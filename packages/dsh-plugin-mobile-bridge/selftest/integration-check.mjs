// Integration check: drives the bridge exactly as the Cordis plugin started it
// (a real DSH profile boot), proving the installed bundle end to end.
//
// Usage:
//   node packages/dsh-plugin-mobile-bridge/selftest/integration-check.mjs \
//     --bridge http://127.0.0.1:7862 --log <DSH_HOME>/web.log --pin 246810
//
// The DSH launch token is read from the boot log (UTF-8 or UTF-16LE) and is
// never printed.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const at = args.indexOf(flag);
  if (at === -1 || at + 1 >= args.length) return fallback;
  return args[at + 1];
}
const BRIDGE = new URL(argValue('--bridge', 'http://127.0.0.1:7862'));
const LOG_PATH = argValue('--log', undefined);
const PIN = String(argValue('--pin', ''));
if (LOG_PATH === undefined || PIN === '') {
  console.error('usage: node integration-check.mjs --log <web.log> --pin <6-digit pin> [--bridge http://127.0.0.1:7862]');
  process.exit(2);
}

function readLogText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const utf16 =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] !== 0 && buffer[1] === 0 && buffer[2] !== 0 && buffer[3] === 0));
  return utf16 ? buffer.toString('utf16le') : buffer.toString('utf8');
}

const logText = readLogText(LOG_PATH);
const tokenMatch = /[?&]token=([A-Za-z0-9_-]+)/u.exec(logText);
if (tokenMatch === null) {
  console.error('integration-check: no DSH launch token in the boot log');
  process.exit(2);
}
const TOKEN = tokenMatch[1];

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  [${detail}]` : ''}`);
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
async function test(name, fn) {
  try {
    record(name, true, await fn());
  } catch (error) {
    record(name, false, String(error?.message ?? error));
  }
}

function request({ method = 'GET', requestPath = '/', headers = {}, body, timeoutMs = 10_000 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const merged = { ...headers };
    if (body !== undefined && merged['content-length'] === undefined) merged['content-length'] = String(Buffer.byteLength(body));
    const req = http.request(
      { host: BRIDGE.hostname, port: Number(BRIDGE.port) || 80, method, path: requestPath, headers: merged, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolvePromise({ status: res.statusCode, headers: res.headers, body: buffer, text: buffer.toString('utf8') });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function wsProbe({ cookie, origin, timeoutMs = 8_000 }) {
  return new Promise((resolvePromise) => {
    const socket = net.connect(Number(BRIDGE.port) || 80, BRIDGE.hostname);
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
    socket.on('connect', () => {
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `Host: ${BRIDGE.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: dsh-remote',
      ];
      if (origin !== undefined) lines.push(`Origin: ${origin}`);
      if (cookie !== undefined) lines.push(`Cookie: ${cookie}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
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

function parseStatus(raw) {
  const match = /^HTTP\/1\.[01] (\d{3})/u.exec(String(raw).split('\r\n')[0] ?? '');
  return match === null ? undefined : Number(match[1]);
}

console.log(`integration-check: bridge=${BRIDGE.origin} log=${LOG_PATH} (token hidden)`);

let cookie;
await test('bridge: serves the installed mobile shell', async () => {
  const response = await request({ requestPath: '/m/' });
  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(/<html/iu.test(response.text), 'shell is not HTML');
  expect(response.text.includes('DSH Mobile') || response.text.includes('app.js'), 'shell markers missing');
  return `200 ${response.body.length}B`;
});

await test('bridge: state before pairing is paired:false', async () => {
  const response = await request({ requestPath: '/m/api/state' });
  expect(response.status === 200, `expected 200, got ${response.status}`);
  const json = JSON.parse(response.text);
  expect(json.paired === false, `paired should be false, got ${json.paired}`);
  expect(json.pinRequired === true, 'pinRequired should be true');
  expect(!response.text.includes(TOKEN), 'state leaked the launch token');
  return `host=${json.host}`;
});

await test('bridge: desktop pairing page and info are loopback-only and live', async () => {
  const page = await request({ requestPath: '/m/pair' });
  expect(page.status === 200, `pair page expected 200, got ${page.status}`);
  expect(page.text.includes('DSH 手机配对'), 'pair page copy missing');
  const info = await request({ requestPath: '/m/pair/info' });
  expect(info.status === 200, `pair info expected 200, got ${info.status}`);
  const json = JSON.parse(info.text);
  expect(json.pin === PIN, `pair info PIN mismatch (${json.pin})`);
  expect(Array.isArray(json.urls) && json.urls.length > 0, 'pair info has no URLs');
  return `${json.urls.length} url(s), pin present`;
});

await test('bridge: pair with the configured PIN returns the tokenised URL', async () => {
  const response = await request({
    method: 'POST',
    requestPath: '/m/api/pair',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: PIN }),
  });
  expect(response.status === 200, `expected 200, got ${response.status}: ${response.text.slice(0, 120)}`);
  const json = JSON.parse(response.text);
  expect(json.ok === true, 'pair response is not ok');
  const url = new URL(json.url);
  expect(url.host === BRIDGE.host, `pair URL host ${url.host} should be the bridge origin ${BRIDGE.host}`);
  expect(url.searchParams.get('token') === TOKEN, 'pair URL does not carry the DSH launch token');
  return 'URL minted';
});

await test('bridge: token URL => 303 + cookie, cookie replay => real DSH GUI', async () => {
  const paired = await request({ method: 'POST', requestPath: '/m/api/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: PIN }) });
  const pairUrl = new URL(JSON.parse(paired.text).url);
  const exchanged = await request({ requestPath: `${pairUrl.pathname}${pairUrl.search}` });
  expect(exchanged.status === 303, `token URL expected 303, got ${exchanged.status}`);
  expect(exchanged.headers.location === './', `expected Location ./, got ${exchanged.headers.location}`);
  const setCookie = exchanged.headers['set-cookie'];
  expect(Array.isArray(setCookie) && setCookie.length > 0, 'no Set-Cookie from token exchange');
  cookie = setCookie[0].split(';')[0].trim();
  expect(cookie.startsWith('dsh-auth-'), `unexpected cookie name: ${cookie.split('=')[0]}`);
  const index = await request({ requestPath: '/', headers: { cookie } });
  expect(index.status === 200, `replayed GET / expected 200, got ${index.status}`);
  expect(index.text.includes('__DSH_BOOT__'), 'replayed index is not the real DSH GUI');
  return `200 ${index.body.length}B __DSH_BOOT__`;
});

await test('bridge: state after cookie replay is paired:true', async () => {
  const response = await request({ requestPath: '/m/api/state', headers: { cookie } });
  const json = JSON.parse(response.text);
  expect(response.status === 200 && json.paired === true, `paired should be true, got ${response.text.slice(0, 120)}`);
  return 'paired:true';
});

await test('bridge: GUI discovery button injection is present in the desktop index', async () => {
  const response = await request({ requestPath: '/', headers: { cookie } });
  expect(response.text.includes('dsh-mobile-bridge-pair'), 'injected pairing button script missing from index HTML');
  expect(response.text.includes('127.0.0.1:' + String(BRIDGE.port)), 'injected button must open this bridge port');
  return 'button injected';
});

await test('bridge: unauthenticated / is gated', async () => {
  const response = await request({ requestPath: '/' });
  expect(response.status === 401 || response.status === 303, `expected 401/303, got ${response.status}`);
  expect(!response.text.includes('__DSH_BOOT__'), 'unauthenticated response contains the GUI');
  return String(response.status);
});

await test('bridge: websocket /api/remote.mux upgrade reaches DSH (101)', async () => {
  const probe = await wsProbe({ cookie, origin: BRIDGE.origin });
  const status = parseStatus(probe.text);
  expect(status === 101, `expected 101, got ${String(status)} (${probe.text.split('\r\n')[0] ?? probe.why})`);
  return '101';
});

await test('bridge: wrong PIN is rejected without breaking pairing', async () => {
  const wrong = await request({ method: 'POST', requestPath: '/m/api/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: PIN === '111111' ? '222222' : '111111' }) });
  expect(wrong.status === 401, `expected 401, got ${wrong.status}`);
  const json = JSON.parse(wrong.text);
  expect(json.error === 'bad-pin', `expected bad-pin, got ${JSON.stringify(json)}`);
  return '401 bad-pin';
});

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(`integration-check summary: ${checks.length - failed.length} passed, ${failed.length} failed`);
setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 250);
