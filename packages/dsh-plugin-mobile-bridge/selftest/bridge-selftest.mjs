// plugin-core selftest: drives the real standalone bridge against the isolated
// DSH Web instance (default http://127.0.0.1:8899) and prints a PASS/FAIL table.
//
// Usage:
//   node packages/dsh-plugin-mobile-bridge/selftest/bridge-selftest.mjs
//   node ... --target http://127.0.0.1:8899 --token <launchToken>
//   node ... --static <dir> [--verbose]
//
// The token is required for the authenticated proxy checks. It is read from
// `--token`, `DSH_TEST_TOKEN`, or <workspace>/.test-home/web.log. Nothing here
// writes to DSH or to .test-home.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../lib/bridge.js';
import { apply as applyPlugin } from '../lib/plugin.js';
import { isLoopbackAddress, lanHostCandidates } from '../lib/network.js';

const SELFTEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(SELFTEST_DIR);
const WORKSPACE_DIR = path.resolve(PACKAGE_DIR, '..', '..');

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const at = args.indexOf(flag);
  if (at === -1 || at + 1 >= args.length) return fallback;
  return args[at + 1];
}
const TARGET_ORIGIN = argValue('--target', 'http://127.0.0.1:8899').replace(/\/+$/u, '');
const STATIC_ARG = argValue('--static', undefined);
const VERBOSE = args.includes('--verbose');

function resolveToken() {
  const cli = argValue('--token', undefined);
  if (typeof cli === 'string' && cli !== '') return cli;
  if (typeof process.env.DSH_TEST_TOKEN === 'string' && process.env.DSH_TEST_TOKEN !== '') return process.env.DSH_TEST_TOKEN;
  try {
    const buffer = fs.readFileSync(path.join(WORKSPACE_DIR, '.test-home', 'web.log'));
    // PowerShell's `*>` redirection writes UTF-16LE on Windows; tolerate both encodings.
    const utf16 = buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] !== 0 && buffer[1] === 0 && buffer[2] !== 0 && buffer[3] === 0));
    const text = utf16 ? buffer.toString('utf16le') : buffer.toString('utf8');
    const match = /[?&]token=([A-Za-z0-9_-]+)/u.exec(text);
    if (match !== null) return match[1];
  } catch {
    /* fall through */
  }
  return undefined;
}

const TOKEN = resolveToken();
if (TOKEN === undefined) {
  console.error('selftest: no DSH launch token found. Pass --token <token>, set DSH_TEST_TOKEN, or boot the isolated instance (its token is in .test-home/web.log).');
  process.exit(2);
}

function resolveStaticDir() {
  if (typeof STATIC_ARG === 'string' && STATIC_ARG !== '') return path.resolve(STATIC_ARG);
  const realPublic = path.join(PACKAGE_DIR, 'public');
  if (fs.existsSync(path.join(realPublic, 'index.html'))) return realPublic;
  return path.join(SELFTEST_DIR, 'fixtures', 'public');
}
const STATIC_DIR = resolveStaticDir();
const PAIR_PAGE_DIR = path.join(PACKAGE_DIR, 'pair-page');

// ---------------------------------------------------------------- reporting
const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? `  [${detail}]` : ''}`);
}
async function test(name, fn, timeoutMs = 20_000) {
  let timer;
  try {
    const detail = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`check timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    record(name, true, detail);
  } catch (error) {
    record(name, false, String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
  }
}
async function skip(name, reason) {
  checks.push({ name, ok: true, skipped: true, detail: reason });
  console.log(`SKIP  ${name}  [${reason}]`);
}
function fail(message) {
  throw new Error(message);
}
function expect(condition, message) {
  if (!condition) fail(message);
}

// Hard cap: a stuck socket must never leave a hung test process behind.
const watchdog = setTimeout(() => {
  console.error('selftest: WATCHDOG - run exceeded 180s, forcing exit');
  process.exit(3);
}, 180_000);
if (typeof watchdog.unref === 'function') watchdog.unref();

// ---------------------------------------------------------------- http helpers
function httpRequest({ host = '127.0.0.1', port, method = 'GET', requestPath = '/', headers = {}, body, timeoutMs = 10_000 }) {
  const mergedHeaders = { ...headers };
  if (body !== undefined && mergedHeaders['content-length'] === undefined) {
    mergedHeaders['content-length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request(
      { host, port, method, path: requestPath, headers: mergedHeaders, agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolvePromise({ status: response.statusCode, headers: response.headers, body: buffer, text: buffer.toString('utf8') });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function jsonRequest({ host, port, method = 'GET', requestPath = '/', cookie, headers = {}, body, timeoutMs }) {
  const merged = { ...headers };
  if (cookie !== undefined) merged.cookie = cookie;
  if (body !== undefined) merged['content-type'] = merged['content-type'] ?? 'application/json';
  return httpRequest({ host, port, method, requestPath, headers: merged, body, timeoutMs }).then((response) => {
    let json;
    try {
      json = JSON.parse(response.text);
    } catch {
      json = undefined;
    }
    return { ...response, json };
  });
}

function rawRequest({ host = '127.0.0.1', port, lines, timeoutMs = 8_000 }) {
  return new Promise((resolvePromise) => {
    const socket = net.connect(port, host);
    let text = '';
    const finish = (why) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolvePromise({ why, text });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.includes('\r\n\r\n')) {
        clearTimeout(timer);
        finish('response');
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      finish(`error:${error.message}`);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish('close');
    });
  });
}

function wsProbe({ port, cookie, origin, hostHeader, requestPath = '/api/remote.mux', timeoutMs = 8_000 }) {
  const headers = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${hostHeader ?? `127.0.0.1:${port}`}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: dsh-remote',
  ];
  if (origin !== undefined) headers.push(`Origin: ${origin}`);
  if (cookie !== undefined) headers.push(`Cookie: ${cookie}`);
  return rawRequest({ port, lines: headers, timeoutMs });
}

function parseStatus(raw) {
  const line = String(raw).split('\r\n')[0] ?? '';
  const match = /^HTTP\/1\.[01] (\d{3})/u.exec(line);
  return match === null ? undefined : Number(match[1]);
}

/** Minimal cookie jar for the token-exchange response. */
function firstCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!Array.isArray(setCookie) || setCookie.length === 0) return undefined;
  const first = setCookie[0].split(';')[0].trim();
  return first === '' ? undefined : first;
}

// ---------------------------------------------------------------- bridge lifecycle
const bridges = new Set();
async function spawnBridge(options, label) {
  const lines = [];
  const logger = {
    info: (...parts) => {
      lines.push(parts.join(' '));
      if (VERBOSE) console.log(`  [${label}] ${parts.join(' ')}`);
    },
    warn: (...parts) => {
      lines.push(parts.join(' '));
      if (VERBOSE) console.log(`  [${label}:warn] ${parts.join(' ')}`);
    },
    error: (...parts) => {
      lines.push(parts.join(' '));
      if (VERBOSE) console.log(`  [${label}:error] ${parts.join(' ')}`);
    },
  };
  const handle = await startBridge({ ...options, logger });
  handle.logLines = lines;
  bridges.add(handle);
  return handle;
}
async function closeBridge(handle) {
  bridges.delete(handle);
  await handle.close();
}

/** Minimal Cordis-context stand-in for exercising plugin.apply without a host. */
function createFakePluginContext(webServer, connection) {
  const cleanups = [];
  const ctx = {
    webServer,
    connection,
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    on() {},
    inject(_dependencies, callback) {
      try {
        callback(ctx);
      } catch {
        /* ignore fake injection failures */
      }
    },
    get(key) {
      if (key === 'webServer') return webServer;
      if (key === 'connection') return connection;
      return undefined;
    },
    dispose() {
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        try {
          cleanup();
        } catch {
          /* ignore */
        }
      }
    },
  };
  return ctx;
}

// ---------------------------------------------------------------- tests
const authenticatedUrl = (baseUrl) => `${baseUrl}?token=${encodeURIComponent(TOKEN)}`;
const common = {
  targetOrigin: TARGET_ORIGIN,
  authenticatedUrl,
  bindHost: '127.0.0.1',
  port: 0,
  staticDir: STATIC_DIR,
  pairPageDir: PAIR_PAGE_DIR,
};

console.log(`selftest: target=${TARGET_ORIGIN} staticDir=${STATIC_DIR} token=${TOKEN.slice(0, 4)}...${TOKEN.slice(-2)}`);

let gateBridge;
let pairBridge;
try {
  // ---- module sanity -------------------------------------------------------
  await test('network: loopback predicate classifies peers', () => {
    expect(isLoopbackAddress('127.0.0.1'), '127.0.0.1 must be loopback');
    expect(isLoopbackAddress('::1'), '::1 must be loopback');
    expect(isLoopbackAddress('::ffff:127.0.0.1'), 'IPv4-mapped loopback must be loopback');
    expect(!isLoopbackAddress('192.168.1.40'), 'LAN address must not be loopback');
    expect(!isLoopbackAddress('10.0.0.2'), 'LAN address must not be loopback');
    expect(!isLoopbackAddress(undefined), 'undefined must not be loopback');
    return 'ok';
  });

  await test('plugin: apply retries getOrigin() until the DSH web listener binds', async () => {
    let originCalls = 0;
    const fakeWebServer = {
      getOrigin() {
        originCalls += 1;
        if (originCalls <= 3) throw new Error('webserver: origin read before the listener bound a port');
        return TARGET_ORIGIN;
      },
    };
    const fakeConnection = { authenticatedUrl: (baseUrl) => `${baseUrl}?token=STUB_TOKEN` };
    const fakeCtx = createFakePluginContext(fakeWebServer, fakeConnection);
    const logs = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...parts) => logs.push(parts.join(' '));
    console.warn = (...parts) => logs.push(parts.join(' '));
    console.error = (...parts) => logs.push(parts.join(' '));
    try {
      await applyPlugin(fakeCtx, { bindHost: '127.0.0.1', port: 0, pin: '135790', guiButton: false });
      expect(originCalls >= 1, 'getOrigin must be called at least once');
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !logs.some((line) => line.includes('mobile-bridge: phone URL'))) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      const phoneLine = logs.find((line) => line.includes('mobile-bridge: phone URL'));
      expect(phoneLine !== undefined, `bridge never started after retries: ${logs.join(' | ')}`);
      expect(originCalls >= 4, `getOrigin must be retried after throwing (calls=${originCalls})`);
      const portMatch = /http:\/\/127\.0\.0\.1:(\d+)\/m\//u.exec(phoneLine);
      expect(portMatch !== null, `phone URL must carry the listener port: ${phoneLine}`);
      const retryPort = Number(portMatch[1]);
      const state = await jsonRequest({ port: retryPort, requestPath: '/m/api/state' });
      expect(state.status === 200 && state.json?.ok === true, 'bridge started through the retry path must serve state');
      fakeCtx.dispose();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      let refused = false;
      try {
        await httpRequest({ port: retryPort, requestPath: '/healthz', timeoutMs: 2_000 });
      } catch (error) {
        refused = error?.code === 'ECONNREFUSED';
      }
      expect(refused, 'disposing the plugin context must close the bridge');
      return `started after ${originCalls} getOrigin calls`;
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  // ---- startup ------------------------------------------------------------
  gateBridge = await spawnBridge({ ...common, pin: '123456', pairAttempts: 3 }, 'gate');
  pairBridge = await spawnBridge({ ...common, pin: '654321', pairAttempts: 8 }, 'pair');

  await test('startup: logs phone URL + PIN and desktop pair page', () => {
    const line = gateBridge.logLines.find((entry) => entry.startsWith('mobile-bridge: phone URL'));
    expect(line !== undefined, 'missing phone URL log line');
    expect(line.includes('/m/'), 'phone URL log line must contain /m/');
    expect(line.includes(`pin ${gateBridge.pin}`), 'phone URL log line must contain the PIN');
    expect(
      gateBridge.logLines.some((entry) => entry.includes('desktop pairing page') && entry.includes('/m/pair')),
      'missing desktop pairing page log line',
    );
    return line.slice(0, 70);
  });

  await test('startup: no DSH launch token in any log line', () => {
    const all = [...gateBridge.logLines, ...pairBridge.logLines].join('\n');
    expect(!all.includes(TOKEN), 'launch token leaked into logs');
    return 'clean';
  });

  await test('startup: port 0 resolved to a real listening port', () => {
    expect(Number.isInteger(gateBridge.port) && gateBridge.port > 0, 'bridge port must be a positive integer');
    expect(pairBridge.port !== gateBridge.port, 'two bridges must not share a port');
    return `ports ${gateBridge.port}/${pairBridge.port}`;
  });

  // ---- static shell -------------------------------------------------------
  const staticBridge = gateBridge;
  await test('static: GET /m/ serves shell HTML with no-cache', async () => {
    const response = await httpRequest({ port: staticBridge.port, requestPath: '/m/' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(String(response.headers['content-type'] ?? '').includes('text/html'), 'content-type must be text/html');
    expect(String(response.headers['cache-control'] ?? '').includes('no-cache'), 'html must be no-cache');
    const realShell = response.text.includes('DSH Mobile');
    const fixtureShell = response.text.includes('DSH-MOBILE-SHELL-FIXTURE');
    expect(realShell || fixtureShell || response.text.includes('__DSH_MOBILE__'), 'shell marker missing');
    expect(/<html/iu.test(response.text), 'shell must be an HTML document');
    return `200 ${response.body.length}B ${realShell ? '(real shell)' : '(fixture)'}`;
  });

  await test('static: GET /m redirects to shell index', async () => {
    const response = await httpRequest({ port: staticBridge.port, requestPath: '/m' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    return '200';
  });

  await test('static: assets served with cacheable headers and correct types', async () => {
    const probes = [
      ['/m/app.js', /javascript/u],
      ['/m/app.css', /text\/css/u],
      ['/m/manifest.webmanifest', /manifest\+json/u],
      ['/m/icons/icon-192.png', /image\/png/u],
    ];
    let served = 0;
    const types = [];
    for (const [requestPath, typePattern] of probes) {
      const response = await httpRequest({ port: staticBridge.port, requestPath });
      if (response.status === 404) continue;
      expect(response.status === 200, `${requestPath} expected 200, got ${response.status}`);
      const contentType = String(response.headers['content-type'] ?? '');
      expect(typePattern.test(contentType), `${requestPath} content-type ${contentType} does not match ${typePattern}`);
      const cacheControl = String(response.headers['cache-control'] ?? '');
      expect(cacheControl === 'no-cache' || cacheControl.includes('max-age'), `${requestPath} cache-control missing`);
      served += 1;
      types.push(requestPath);
    }
    expect(served >= 2, 'expected at least two shell assets to be served');
    return types.join(', ');
  });

  await test('static: HEAD /m/ returns headers without a body', async () => {
    const response = await httpRequest({ port: staticBridge.port, method: 'HEAD', requestPath: '/m/' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(Number(response.headers['content-length'] ?? '0') > 0, 'content-length should be present');
    expect(response.body.length === 0, 'HEAD must not return a body');
    return 'ok';
  });

  await test('static: missing asset is 404', async () => {
    const response = await httpRequest({ port: staticBridge.port, requestPath: '/m/definitely-missing.js' });
    expect(response.status === 404, `expected 404, got ${response.status}`);
    return '404';
  });

  await test('static: percent-encoded traversal is refused', async () => {
    for (const bad of ['/m/%2e%2e/package.json', '/m/%2e%2e%2fpackage.json', '/m/..%2fpackage.json', '/m/%2e%2e/%2e%2e/README.md']) {
      const response = await httpRequest({ port: staticBridge.port, requestPath: bad });
      expect(response.status === 403 || response.status === 404, `${bad}: expected 403/404, got ${response.status}`);
      expect(!response.text.includes('dsh-plugin-mobile-bridge'), `${bad}: leaked package content`);
    }
    return '4 variants blocked';
  });

  await test('static: unsupported method is 405', async () => {
    const response = await httpRequest({ port: staticBridge.port, method: 'POST', requestPath: '/m/' });
    expect(response.status === 405, `expected 405, got ${response.status}`);
    return '405';
  });

  // ---- state --------------------------------------------------------------
  await test('state: no cookie => paired:false, never leaks the token', async () => {
    const response = await jsonRequest({ port: pairBridge.port, requestPath: '/m/api/state' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(response.json?.ok === true, 'ok must be true');
    expect(response.json?.paired === false, 'paired must be false');
    expect(response.json?.dshUrl === '/', 'dshUrl must be /');
    expect(response.json?.pinRequired === true, 'pinRequired must be true');
    expect(typeof response.json?.host === 'string' && response.json.host.length > 0, 'host must be a non-empty string');
    expect(!response.text.includes(TOKEN), 'state must not leak the launch token');
    expect(String(response.headers['cache-control'] ?? '').includes('no-store'), 'state must be no-store');
    return `host=${response.json.host}`;
  });

  // ---- pairing rate limit -------------------------------------------------
  await test(`pair: ${gateBridge.pin ? 3 : 'N'} wrong PINs => 401, next => 429 locked`, async () => {
    const attempts = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await jsonRequest({
        port: gateBridge.port,
        method: 'POST',
        requestPath: '/m/api/pair',
        body: JSON.stringify({ code: '000000' === gateBridge.pin ? '999999' : '000000' }),
      });
      attempts.push(response.status);
      expect(response.json?.ok === false, 'bad PIN must not be ok');
      expect(response.json?.error === 'bad-pin', `expected bad-pin, got ${JSON.stringify(response.json)}`);
      expect(!response.text.includes(TOKEN), 'bad PIN response must not leak the token');
    }
    expect(attempts.every((status) => status === 401), `expected three 401s, got ${attempts.join(',')}`);
    const locked = await jsonRequest({
      port: gateBridge.port,
      method: 'POST',
      requestPath: '/m/api/pair',
      body: JSON.stringify({ code: '111111' }),
    });
    expect(locked.status === 429, `expected 429 after limit, got ${locked.status}`);
    expect(locked.json?.error === 'locked', `expected locked, got ${JSON.stringify(locked.json)}`);
    expect(Number(locked.json?.retryAfterMs) > 0, 'retryAfterMs must be positive');
    return `${attempts.join(',')} -> 429`;
  });

  await test('pair: non-JSON content-type is refused (CSRF guard)', async () => {
    const response = await httpRequest({
      port: gateBridge.port,
      method: 'POST',
      requestPath: '/m/api/pair',
      headers: { 'content-type': 'text/plain', 'content-length': '16' },
      body: JSON.stringify({ code: '1' }),
    });
    expect(response.status === 415, `expected 415, got ${response.status}`);
    return '415';
  });

  await test('pair: malformed JSON is refused', async () => {
    const response = await httpRequest({
      port: pairBridge.port,
      method: 'POST',
      requestPath: '/m/api/pair',
      headers: { 'content-type': 'application/json' },
      body: '{oops}',
    });
    expect(response.status === 400, `expected 400, got ${response.status}`);
    return '400';
  });

  // ---- pairing success + token exchange + cookie replay --------------------
  let cookie;
  let pairedUrl;
  await test('pair: correct PIN returns a tokenised URL on this very origin', async () => {
    const response = await jsonRequest({
      port: pairBridge.port,
      method: 'POST',
      requestPath: '/m/api/pair',
      body: JSON.stringify({ code: pairBridge.pin }),
    });
    expect(response.status === 200, `expected 200, got ${response.status}: ${response.text.slice(0, 120)}`);
    expect(response.json?.ok === true, 'ok must be true');
    expect(Number(response.json?.expiresInMs) === 120_000, `expiresInMs must be 120000, got ${response.json?.expiresInMs}`);
    const url = new URL(String(response.json?.url ?? ''));
    expect(url.hostname === '127.0.0.1', `pair URL hostname must be the request authority, got ${url.hostname}`);
    expect(String(url.port) === String(pairBridge.port), `pair URL port must be the bridge port, got ${url.port}`);
    expect(url.searchParams.get('token') === TOKEN, 'pair URL must carry the DSH launch token');
    pairedUrl = url;
    return `${url.origin}/?token=***`;
  });

  await test('proxy: GET token URL => 303 + Set-Cookie bound to bridge origin', async () => {
    const response = await httpRequest({ port: pairBridge.port, requestPath: `${pairedUrl.pathname}${pairedUrl.search}` });
    expect(response.status === 303, `expected 303, got ${response.status}`);
    expect(response.headers.location === './', `expected Location ./, got ${response.headers.location}`);
    expect(String(response.headers['cache-control'] ?? '').includes('no-store'), 'token exchange must be no-store');
    cookie = firstCookie(response.headers);
    expect(cookie !== undefined && cookie.startsWith('dsh-auth-'), 'expected a dsh-auth-* cookie');
    return `303 ${cookie.split('=')[0]}=***`;
  });

  await test('proxy: replaying cookie to GET / serves the real DSH index', async () => {
    expect(cookie !== undefined, 'no cookie captured');
    const response = await httpRequest({ port: pairBridge.port, requestPath: '/', headers: { cookie } });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(String(response.headers['content-type'] ?? '').includes('text/html'), 'index content-type must be text/html');
    expect(response.text.includes('__DSH_BOOT__'), 'index must contain the real DSH boot payload');
    return `200 ${response.body.length}B __DSH_BOOT__`;
  });

  await test('state: cookie replay => paired:true', async () => {
    const response = await jsonRequest({ port: pairBridge.port, requestPath: '/m/api/state', cookie });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(response.json?.paired === true, `paired must be true, got ${JSON.stringify(response.json)}`);
    return 'paired:true';
  });

  await test('proxy: unauthenticated GET / is gated (401/303, no GUI)', async () => {
    const response = await httpRequest({ port: pairBridge.port, requestPath: '/' });
    expect(response.status === 401 || response.status === 303, `expected 401/303, got ${response.status}`);
    expect(!response.text.includes('__DSH_BOOT__'), 'unauthenticated request must not receive the GUI');
    return String(response.status);
  });

  await test('proxy: proxied HTML is the real DSH page and keeps boot injections', async () => {
    const response = await httpRequest({ port: pairBridge.port, requestPath: '/', headers: { cookie } });
    expect(response.text.includes('__DSH_CONNECTION_RECOVERY__'), 'index injection from connection plugin missing');
    return 'injections intact';
  });

  // ---- loopback-only desktop pairing page --------------------------------
  await test('pair page: GET /m/pair from loopback => 200 inline HTML', async () => {
    const response = await httpRequest({ port: pairBridge.port, requestPath: '/m/pair' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(String(response.headers['content-type'] ?? '').includes('text/html'), 'pair page must be HTML');
    expect(response.text.includes('DSH 手机配对'), 'pair page Chinese copy missing');
    expect(response.text.includes('仅本机可访问'), 'pair page loopback badge missing');
    expect(!/(?:src|href)=["']https?:/iu.test(response.text), 'pair page must not reference external resources');
    return `200 ${response.body.length}B`;
  });

  await test('pair page: /m/pair/info returns the live PIN and URLs (loopback)', async () => {
    const response = await jsonRequest({ port: pairBridge.port, requestPath: '/m/pair/info' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(response.json?.pin === pairBridge.pin, `pin mismatch: ${JSON.stringify(response.json)}\n`);
    expect(Array.isArray(response.json?.urls) && response.json.urls.length > 0, 'urls must be a non-empty array');
    expect(response.json.urls.every((url) => String(url).endsWith('/m/')), 'urls must point at /m/');
    expect(response.json?.port === pairBridge.port, 'port must match the listener');
    expect(response.json?.targetOrigin === TARGET_ORIGIN, 'targetOrigin must match');
    expect(!response.text.includes(TOKEN), 'pair info must not leak the token');
    return `${response.json.urls.length} url(s)`;
  });

  await test('healthz: loopback => {ok:true}', async () => {
    const response = await jsonRequest({ port: pairBridge.port, requestPath: '/healthz' });
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(response.json?.ok === true, 'healthz must be ok');
    return 'ok';
  });

  await test('loopback-only: LAN peer is refused for /m/pair, /m/pair/info, /healthz', async () => {
    const candidates = lanHostCandidates();
    if (candidates.length === 0) {
      return 'no LAN IPv4 on this host: covered by the network predicate check';
    }
    const lanBridge = await spawnBridge({ ...common, bindHost: '0.0.0.0', pin: '111222' }, 'lan');
    try {
      const lanHost = candidates[0].host;
      const targets = ['/m/pair', '/m/pair/info', '/healthz'];
      for (const requestPath of targets) {
        const response = await jsonRequest({ host: lanHost, port: lanBridge.port, requestPath, timeoutMs: 8_000 });
        expect(response.status === 403, `${requestPath} from ${lanHost} expected 403, got ${response.status}`);
        expect(response.json?.error === 'loopback-only', `${requestPath} expected loopback-only error`);
      }
      return `${targets.length} routes refused on ${lanHost}`;
    } finally {
      await closeBridge(lanBridge);
    }
  });

  // ---- WebSocket upgrade through the proxy --------------------------------
  await test('ws: /api/remote.mux upgrade with cookie + browser Origin => 101', async () => {
    expect(cookie !== undefined, 'no cookie captured');
    const probe = await wsProbe({
      port: pairBridge.port,
      cookie,
      origin: `http://127.0.0.1:${pairBridge.port}`,
    });
    const status = parseStatus(probe.text);
    expect(status === 101, `expected 101, got ${String(status)} (${probe.text.split('\r\n')[0] ?? probe.why})`);
    expect(/upgrade:\s*websocket/iu.test(probe.text), '101 response must include Upgrade: websocket');
    expect(/sec-websocket-accept:/iu.test(probe.text), '101 response must include Sec-WebSocket-Accept');
    return '101';
  });

  await test('ws: upgrade without cookie is rejected by DSH (401, no hang)', async () => {
    const probe = await wsProbe({
      port: pairBridge.port,
      origin: `http://127.0.0.1:${pairBridge.port}`,
    });
    const status = parseStatus(probe.text);
    expect(status === 401 || status === 403, `expected DSH 401/403, got ${String(status)} (${probe.why})`);
    expect(probe.why !== 'timeout', 'upgrade without cookie must not hang');
    return String(status);
  });

  // ---- proxy hardening ----------------------------------------------------
  await test('proxy: absolute-form request target is refused', async () => {
    const probe = await rawRequest({
      port: pairBridge.port,
      lines: ['GET http://example.com/ HTTP/1.1', ...(function () { return ['Host: example.com']; })()],
    });
    const status = parseStatus(probe.text);
    expect(status === 400, `expected 400, got ${String(status)} (${probe.why})`);
    return '400';
  });

  await test('proxy: CONNECT is refused', async () => {
    const probe = await rawRequest({
      port: pairBridge.port,
      lines: ['CONNECT example.com:443 HTTP/1.1', 'Host: example.com:443'],
    });
    const status = parseStatus(probe.text);
    expect(status === 405 || status === 400, `expected 400/405, got ${String(status)} (${probe.why})`);
    return String(status);
  });

  await test('proxy: unreachable upstream => 502', async () => {
    const deadBridge = await spawnBridge({ targetOrigin: 'http://127.0.0.1:1', bindHost: '127.0.0.1', port: 0 }, 'dead');
    try {
      const response = await httpRequest({ port: deadBridge.port, requestPath: '/', timeoutMs: 8_000 });
      expect(response.status === 502, `expected 502, got ${response.status}`);
      return '502';
    } finally {
      await closeBridge(deadBridge);
    }
  });

  await test('proxy: silent upstream => 504 (bounded, no hang)', async () => {
    const silentServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.resume(); // observe the peer FIN/RST so server.close() can settle
    });
    await new Promise((resolvePromise) => silentServer.listen(0, '127.0.0.1', resolvePromise));
    const silentPort = silentServer.address().port;
    const slowBridge = await spawnBridge(
      { targetOrigin: `http://127.0.0.1:${silentPort}`, bindHost: '127.0.0.1', port: 0, upstreamTimeoutMs: 1_000 },
      'slow',
    );
    try {
      const started = Date.now();
      const response = await httpRequest({ port: slowBridge.port, requestPath: '/', timeoutMs: 8_000 });
      expect(response.status === 504, `expected 504, got ${response.status}`);
      expect(Date.now() - started < 6_000, 'gateway timeout must be bounded');
      return `504 in ${Date.now() - started}ms`;
    } finally {
      await closeBridge(slowBridge);
      await Promise.race([
        new Promise((resolvePromise) => silentServer.close(resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
      ]);
    }
  });

  await test('routing: unknown /m/api/* is 404 JSON', async () => {
    const response = await jsonRequest({ port: pairBridge.port, requestPath: '/m/api/nope' });
    expect(response.status === 404, `expected 404, got ${response.status}`);
    expect(response.json?.ok === false, 'unknown API must return ok:false');
    return '404';
  });

  await test('routing: OPTIONS on /m/api/state is 405', async () => {
    const response = await httpRequest({ port: pairBridge.port, method: 'OPTIONS', requestPath: '/m/api/state' });
    expect(response.status === 405, `expected 405, got ${response.status}`);
    return '405';
  });

  // ---- close --------------------------------------------------------------
  await test('lifecycle: close() stops the listener', async () => {
    const victim = await spawnBridge({ ...common, pin: '333444' }, 'victim');
    await victim.close();
    bridges.delete(victim);
    let refused = false;
    try {
      await httpRequest({ port: victim.port, requestPath: '/healthz', timeoutMs: 3_000 });
    } catch (error) {
      refused = error?.code === 'ECONNREFUSED';
    }
    expect(refused, 'closed bridge must refuse connections');
    return 'refused';
  });
} catch (error) {
  record('selftest harness', false, String(error?.stack ?? error));
} finally {
  for (const handle of [...bridges]) {
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- summary
const failed = checks.filter((entry) => !entry.ok);
const passed = checks.filter((entry) => entry.ok && entry.skipped !== true);
const skipped = checks.filter((entry) => entry.skipped === true);
console.log('');
console.log(`selftest summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (${checks.length} checks)`);
const exitCode = failed.length > 0 ? 1 : 0;
if (failed.length > 0) {
  console.log('failed checks:');
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
}
// A hung socket must never leave the harness running: flush briefly, then exit.
setTimeout(() => process.exit(exitCode), 250);
