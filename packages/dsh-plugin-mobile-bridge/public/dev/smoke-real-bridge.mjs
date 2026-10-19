#!/usr/bin/env node
/**
 * DSH Mobile — real-bridge smoke test (dev-only)
 * ==============================================
 * Boots the plugin's real standalone `startBridge()` against an isolated DSH web
 * instance and checks the mobile-shell contract end to end at the HTTP level:
 * static shell assets, /m/api/state, /m/api/pair (bad + good PIN), the token URL
 * 303 + Set-Cookie handshake, cookie replay into the proxied DSH GUI, and
 * unauthenticated access gating.
 *
 * Prerequisites: an isolated DSH web instance (do NOT use the live desktop DSH):
 *   $env:DSH_HOME="<workspace>\.test-home"
 *   dsh.cmd web --no-open --host 127.0.0.1 --port 8899
 * then take the `token=` value from .test-home/web.log.
 *
 * Usage:
 *   node public/dev/smoke-real-bridge.mjs --target http://127.0.0.1:8899 --token <TOKEN>
 *   DSH_TEST_TOKEN=<TOKEN> node public/dev/smoke-real-bridge.mjs
 *
 * Optional: --pin <pin>, --port <bridge port, 0=auto>, --bind 127.0.0.1
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../../lib/bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '..');
const PACKAGE_DIR = resolve(PUBLIC_ROOT, '..');

async function parseArgs(argv) {
  const args = { target: 'http://127.0.0.1:8899', token: process.env.DSH_TEST_TOKEN || '', pin: '123456', port: 0, bind: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--target') args.target = argv[++i];
    else if (key === '--token') args.token = argv[++i];
    else if (key === '--pin') args.pin = argv[++i];
    else if (key === '--port') args.port = Number(argv[++i]);
    else if (key === '--bind') args.bind = argv[++i];
    else if (key === '--token-file') {
      // read a `token=...` value out of a dsh web log line
      const logPath = argv[++i];
      const text = await readFile(logPath, 'utf8');
      const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
      if (match) args.token = match[1];
    } else if (key === '--help' || key === '-h') {
      args.help = true;
    }
  }
  return args;
}

/** Build the same URL shape DSH's ctx.connection.authenticatedUrl() returns. */
function authenticatedUrlFor(token) {
  return (baseUrl) => {
    const url = new URL(baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  };
}

const results = [];
function record(name, ok, details) {
  results.push({ name, ok, details: details || '' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !details ? '' : '\n        ↳ ' + details}`);
}
async function step(name, fn) {
  try {
    const outcome = await fn();
    if (outcome === false) record(name, false, 'returned false');
    else record(name, true);
  } catch (error) {
    record(name, false, (error && error.message) || String(error));
  }
}
async function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return jar.size ? Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
    },
    absorb(response) {
      const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const line of lines) {
        const [pair] = String(line).split(';');
        const index = pair.indexOf('=');
        if (index < 0) continue;
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      return lines;
    },
  };
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(base + path, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    redirect: 'manual',
    cache: 'no-store',
  });
  return { response, status: response.status, text: await response.text() };
}

const args = await parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node public/dev/smoke-real-bridge.mjs --target http://127.0.0.1:8899 --token <token> [--token-file <path>] [--pin 123456] [--port 0]');
  process.exit(0);
}
if (!args.token) {
  console.error('Missing token. Pass --token <TOKEN>, --token-file <.test-home/web.log>, or set DSH_TEST_TOKEN.');
  process.exit(2);
}

console.log('DSH Mobile — real-bridge smoke test');
console.log('  target:', args.target);
console.log('  pin   :', args.pin);
console.log('  bridge: starting…');
console.log('');

const bridge = await startBridge({
  targetOrigin: args.target,
  authenticatedUrl: authenticatedUrlFor(args.token),
  bindHost: args.bind,
  port: args.port,
  pin: args.pin,
  staticDir: join(PACKAGE_DIR, 'public'),
  pairPageDir: join(PACKAGE_DIR, 'pair-page'),
  logger: { info: () => {}, warn: () => {}, error: (msg) => console.error('[bridge]', msg) },
});

const base = `http://127.0.0.1:${bridge.port}`;
const failures = [];

try {
  console.log('  bridge port:', bridge.port);
  console.log('');

  /* ---------------- shell statics through the real bridge ---------------- */
  await step('GET /m/ -> 200 mobile shell from public/', async () => {
    const { status, response, text } = await request(base, '/m/');
    await expect(status === 200, `status ${status}`);
    await expect((response.headers.get('content-type') || '').includes('text/html'), 'content-type');
    await expect(text.includes('DSH Mobile'), 'shell title');
    await expect(text.includes('id="guiFrame"'), 'gui iframe');
    return true;
  });

  await step('GET /m/ -> assets resolve with correct types', async () => {
    const expected = [
      ['/m/app.css', 'text/css'],
      ['/m/app.js', 'javascript'],
      ['/m/manifest.webmanifest', 'application/manifest+json'],
      ['/m/icons/icon-512.png', 'image/png'],
      ['/m/icons/favicon.svg', 'image/svg+xml'],
      ['/m/dev/mock-server.mjs', 'javascript'],
    ];
    for (const [path, type] of expected) {
      const { status, response } = await request(base, path);
      await expect(status === 200, `${path} -> ${status}`);
      await expect((response.headers.get('content-type') || '').includes(type), `${path} content-type`);
    }
    return true;
  });

  await step('traversal under /m is refused', async () => {
    for (const probe of ['/m/%2e%2e/package.json', '/m/..%2fpackage.json', '/m/../package.json']) {
      const response = await fetch(base + probe);
      await expect([400, 403, 404].includes(response.status), `${probe} -> ${response.status}`);
    }
    return true;
  });

  /* ---------------- pairing contract ---------------- */
  await step('GET /m/api/state -> { paired:false }', async () => {
    const { status, text } = await request(base, '/m/api/state');
    await expect(status === 200, `status ${status}`);
    const json = JSON.parse(text);
    await expect(json.ok === true && json.paired === false, 'unpaired state');
    await expect(json.dshUrl === '/', 'dshUrl');
    return true;
  });

  await step('POST /m/api/pair wrong PIN -> 401 bad-pin', async () => {
    const { status, text } = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    await expect(status === 401, `status ${status}`);
    const json = JSON.parse(text);
    await expect(json.ok === false && json.error === 'bad-pin', 'bad-pin payload');
    return true;
  });

  let tokenUrl = '';
  await step('POST /m/api/pair right PIN -> 200 { url }', async () => {
    const { status, text } = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: args.pin }),
    });
    await expect(status === 200, `status ${status} body ${text.slice(0, 120)}`);
    const json = JSON.parse(text);
    await expect(json.ok === true, 'ok');
    await expect(typeof json.url === 'string' && json.url.includes('token='), 'tokenised url');
    await expect(json.url.startsWith(base), 'url must target the bridge origin');
    await expect(Number(json.expiresInMs) > 0, 'expiresInMs');
    tokenUrl = json.url;
    return true;
  });

  await step('token url -> 303 + Set-Cookie', async () => {
    const jar = cookieJar();
    const relative = tokenUrl.replace(base, '');
    const { status, response } = await request(base, relative);
    await expect(status === 303, `status ${status}`);
    const cookies = jar.absorb(response);
    await expect(cookies.length > 0, 'Set-Cookie missing (DSH cookie not minted)');
    await expect((response.headers.get('location') || '').length > 0, 'redirect location');
    return true;
  });

  await step('cookie replay -> proxied DSH GUI 200 + paired:true', async () => {
    const jar = cookieJar();
    const pair = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: args.pin }),
    });
    const url = JSON.parse(pair.text).url.replace(base, '');
    const login = await request(base, url);
    jar.absorb(login.response);
    const cookie = jar.header();
    await expect(cookie, 'no cookie minted');

    const gui = await request(base, '/', { cookie });
    await expect(gui.status === 200, `GUI status ${gui.status}`);
    await expect(gui.text.includes('DeepSeek Harness'), 'DSH GUI title missing');

    const state = await request(base, '/m/api/state', { cookie });
    await expect(JSON.parse(state.text).paired === true, 'paired:true expected with cookie');
    return true;
  });

  await step('unauthenticated / is gated (not the GUI)', async () => {
    const { status, text } = await request(base, '/');
    await expect(status === 401 || status === 303 || status === 302, `status ${status}`);
    if (status === 200) await expect(!text.includes('<div id="root">'), 'GUI leaked while unauthenticated');
    return true;
  });

  await step('GET /m/pair from loopback -> 200 desktop pairing page', async () => {
    const { status, text } = await request(base, '/m/pair');
    await expect(status === 200, `status ${status}`);
    await expect(text.includes('<html') || text.includes('<!doctype'), 'pair page html');
    return true;
  });

  await step('GET /healthz -> 200 ok', async () => {
    const { status, text } = await request(base, '/healthz');
    await expect(status === 200, `status ${status}`);
    await expect(JSON.parse(text).ok === true, 'healthz payload');
    return true;
  });
} finally {
  await bridge.close();
}

const failed = results.filter((result) => !result.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('Failures:');
  failed.forEach((failure) => console.log('  - ' + failure.name + ' — ' + failure.details));
  process.exitCode = 1;
} else {
  console.log('All real-bridge checks passed.');
}
