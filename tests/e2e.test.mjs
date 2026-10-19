/**
 * E2E acceptance suite for the DSH mobile bridge (docs/ARCHITECTURE.md
 * "E2E acceptance" items 1-9).
 *
 * Run standalone (boots/reuses the isolated DSH 8899 + bridge 7861 in-process):
 *   node --test tests/e2e.test.mjs
 *
 * Run through the one-command orchestrator (starts the stack in its own process,
 * then runs this file as a pure HTTP client):
 *   powershell -File tests/run-all.ps1
 *
 * Browser item 8 is covered by DOM-contract fallback checks because browser
 * automation is blocked in this sandbox (see tests/README.md, "Known limitations").
 * Install item 9 is covered by tests/harness/install-check.ps1 evidence: when
 * .test-home/install-proof.json exists, the test asserts it here as well.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Phone, closeWs, rawHttpRequest } from './harness/phone.mjs';
import { acquireStack, lanIPv4, PKG_DIR, STATIC_DIR, TEST_PIN, PAIR_ATTEMPTS } from './harness/bridge.mjs';
import { WORKSPACE } from './harness/boot-dsh.mjs';

const ARTIFACTS = path.join(WORKSPACE, 'tests', 'artifacts');
const EVIDENCE = [];
const FAILURES = [];

function evidence(item, text) {
  const line = `EVIDENCE [item ${item}] ${text}`;
  EVIDENCE.push(line);
  console.log(line);
}
function snippet(text, size = 180) {
  return JSON.stringify(String(text ?? '').replace(/\s+/g, ' ').slice(0, size));
}
function assertStatus(res, expected, label, item) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const contentType = String(res.headers?.['content-type'] ?? '');
  const textual = /text\/|json|javascript/i.test(contentType);
  const bodyDesc = textual ? snippet(res.text) : `<binary ${res.text?.length ?? 0}B>`;
  const detail = `${label}: status=${res.status} expected=${expectedList.join('|')} location=${res.location ?? '-'} body=${bodyDesc}`;
  evidence(item, detail);
  assert.ok(expectedList.includes(res.status), detail);
}
function assertNoToken(text, label) {
  assert.ok(!String(text).includes(TOKEN_STATE.token || '\u0000'), `${label}: bridge log must never contain the DSH launch token`);
}

const TOKEN_STATE = { token: null, tokenUrl: null };
const state = {
  stack: null,
  phone: null,
  anon: null,
  pairBody: null,
  shellHtml: null,
  loopbackEvidence: {},
};

before(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  state.stack = await acquireStack();
  const stack = state.stack;
  evidence(0, `stack origin=${stack.origin} target=${stack.targetOrigin ?? '(external)'} pin=${stack.pin} external=${stack.external}`);
  state.phone = new Phone(stack.origin);
  state.anon = new Phone(stack.origin);
  // Wait until the bridge answers /healthz from loopback (server bound).
  let ready = null;
  for (let i = 0; i < 50 && !ready; i++) {
    try { ready = await new Phone(stack.origin).get('/healthz'); } catch { /* retry */ }
    if (!ready || ready.status !== 200) { ready = null; await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(ready && ready.status === 200, 'bridge /healthz must be 200 from loopback before tests start');
});

after(async () => {
  // Persist machine-readable evidence for the final report.
  const summary = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    externalStack: state.stack?.external ?? null,
    bridgeOrigin: state.stack?.origin ?? null,
    dshTarget: state.stack?.targetOrigin ?? null,
    pinConfigured: state.stack?.pin ?? null,
    loopbackGuard: state.loopbackEvidence,
    evidence: EVIDENCE,
    failures: FAILURES,
    browserAutomation: 'blocked by DSH sandbox (bsk daemon named-pipe access denied; headless Chromium launch denied) - DOM-contract fallback executed (item 8)',
  };
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'e2e-evidence.json'), JSON.stringify(summary, null, 2) + '\n');
    fs.writeFileSync(path.join(ARTIFACTS, 'e2e-evidence.log'), EVIDENCE.join('\n') + '\n');
  } catch (error) {
    console.error('could not write evidence artifacts:', error.message);
  }
  try { await state.stack?.close(); } catch (error) { console.error('stack teardown error:', error?.message ?? error); }
});

/* ------------------------------------------------------------------ */
/* Item 1: /m/ mobile shell is served by the bridge, assets load        */
/* ------------------------------------------------------------------ */
test('E2E-1 mobile shell: GET /m/ -> 200 HTML and every local asset loads', async () => {
  const shell = await state.phone.get('/m/');
  assertStatus(shell, 200, 'GET /m/', 1);
  assert.match(shell.headers['content-type'] ?? '', /text\/html/, 'shell content-type must be text/html');
  assert.match(shell.text, /<title>DSH Mobile<\/title>/, 'shell title');
  assert.match(shell.text, /id="pairingView"/, 'pairing view exists in the shell DOM');
  assert.match(shell.text, /id="guiFrame"/, 'GUI iframe exists in the shell DOM');
  assert.match(shell.text, /<meta name="viewport" content="[^"]*width=device-width/, 'mobile viewport meta');
  assert.match(shell.text, /rel="manifest" href="\.\/manifest\.webmanifest"/, 'PWA manifest link');
  state.shellHtml = shell.text;

  // /m (no trailing slash) must serve the same shell.
  const noSlash = await state.phone.get('/m');
  assertStatus(noSlash, 200, 'GET /m', 1);

  // Resolve and fetch every same-origin local asset referenced by the shell.
  const assetRefs = new Set();
  for (const match of shell.text.matchAll(/(?:href|src)="(\.\/[^"?#]+)(?:\?[^"]*)?"/g)) {
    const rel = match[1].slice(2);
    if (rel.startsWith('icons/') || rel === 'app.css' || rel === 'app.js' || rel === 'manifest.webmanifest') assetRefs.add(rel);
  }
  assert.ok(assetRefs.size >= 5, `expected at least 5 local assets referenced, got ${[...assetRefs].join(', ')}`);
  const loaded = [];
  for (const rel of [...assetRefs].sort()) {
    const res = await state.phone.get(`/m/${rel}`);
    assertStatus(res, 200, `GET /m/${rel}`, 1);
    loaded.push(`${rel}(${res.text.length}B,${res.headers['content-type']})`);
  }
  evidence(1, `assets ${loaded.join(' ')}`);
  evidence(1, `PASS shell=200 title="DSH Mobile" assets=${loaded.length}`);
});

/* ------------------------------------------------------------------ */
/* Item 2: POST /m/api/pair with the right PIN mints a tokenised URL   */
/* ------------------------------------------------------------------ */
test('E2E-2 pairing: correct PIN -> 200 { ok, url(token), expiresInMs }', async () => {
  const pin = state.stack.pin;
  const res = await state.phone.post('/m/api/pair', { code: pin });
  assertStatus(res, 200, 'POST /m/api/pair (correct pin)', 2);
  const body = res.json();
  assert.equal(body?.ok, true, 'pair ok flag');
  assert.equal(typeof body.url, 'string', 'url is a string');
  assert.match(body.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+$/, 'url must be the bridge origin with a token query');
  assert.equal(typeof body.expiresInMs, 'number', 'expiresInMs is a number');
  assert.ok(body.expiresInMs > 0, 'expiresInMs positive');
  TOKEN_STATE.tokenUrl = body.url;
  TOKEN_STATE.token = new URL(body.url).searchParams.get('token');
  assert.ok(TOKEN_STATE.token && TOKEN_STATE.token.length >= 20, 'launch token present in URL');
  state.pairBody = body;

  // token must NOT be logged by the bridge (secret hygiene).
  const logs = state.stack.logs.join('\n');
  assertNoToken(logs, 'bridge log');
  evidence(2, `PASS pair=200 urlOrigin=${new URL(body.url).origin} tokenLen=${TOKEN_STATE.token.length} expiresInMs=${body.expiresInMs} tokenNotLogged=${!logs.includes(TOKEN_STATE.token)}`);
});

/* ------------------------------------------------------------------ */
/* Item 3: token URL -> 303 + cookie; cookie replay -> 200 GUI + state */
/* ------------------------------------------------------------------ */
test('E2E-3 login: token URL -> 303 + Set-Cookie; cookie replay / -> 200 DSH GUI; state paired=true', async () => {
  const phone = new Phone(state.stack.origin); // fresh browser cookie jar
  const login = await phone.get(TOKEN_STATE.tokenUrl);
  assertStatus(login, 303, 'GET tokenised URL through bridge', 3);
  assert.equal(login.location, './', 'token exchange redirects to ./');
  const authCookie = login.setCookies.find((c) => /^dsh-auth-[^=]+=/.test(c));
  assert.ok(authCookie, `expected dsh-auth Set-Cookie, got ${snippet(login.setCookies.join('; '))}`);
  assert.match(authCookie, /HttpOnly/i, 'auth cookie HttpOnly');
  assert.match(authCookie, /SameSite=Strict/i, 'auth cookie SameSite=Strict');
  evidence(3, `token URL -> ${login.status} Location=${login.location} Set-Cookie=${authCookie.split(';')[0]}`);

  const gui = await phone.get('/');
  assertStatus(gui, 200, 'cookie replay GET /', 3);
  assert.match(gui.headers['content-type'] ?? '', /text\/html/, 'GUI content-type text/html');
  assert.match(gui.text, /<title>DeepSeek Harness<\/title>/, 'real DSH GUI HTML served through the bridge');
  assert.ok(gui.text.length > 5000, `GUI HTML looks complete (${gui.text.length}B)`);
  evidence(3, `cookie replay / -> ${gui.status} ${gui.text.length}B title="DeepSeek Harness"`);

  const paired = await phone.get('/m/api/state');
  assertStatus(paired, 200, 'GET /m/api/state (paired browser)', 3);
  const body = paired.json();
  assert.equal(body?.ok, true, 'state ok');
  assert.equal(body?.paired, true, 'state paired=true after cookie replay');
  assert.equal(body?.dshUrl, '/', 'state dshUrl=/');
  assert.equal(body?.pinRequired, true, 'state pinRequired=true');
  assert.equal(typeof body?.host, 'string', 'state host string');
  evidence(3, `state paired=true host=${snippet(body?.host)} pinRequired=${body?.pinRequired}`);

  // Extra (not an acceptance item): the plugin injects a loopback-only desktop pairing
  // button into the proxied DSH index (config guiButton). Informational evidence only.
  const injectedButton = gui.text.includes('dsh-mobile-bridge-pair');
  evidence(3, `desktop pairing button injected into proxied GUI index: ${injectedButton}`);
});

/* ------------------------------------------------------------------ */
/* Item 4: unauthenticated GET / is gated (not the GUI)                */
/* ------------------------------------------------------------------ */
test('E2E-4 unauthenticated GET / through bridge -> 401/redirect, never GUI HTML', async () => {
  const anon = new Phone(state.stack.origin); // empty cookie jar
  const res = await anon.get('/');
  assert.ok([401, 303, 302].includes(res.status), `unauthenticated / must be gated, got ${res.status}`);
  assert.ok(!/<title>DeepSeek Harness<\/title>/.test(res.text), 'unauthenticated response must not contain the GUI');
  if (res.status === 401) {
    assert.match(res.text, /authentication required/i, 'DSH auth-required body text');
  } else {
    assert.match(String(res.location ?? ''), /^\//, 'redirect to a same-origin path');
  }
  evidence(4, `PASS anon / -> ${res.status} body=${snippet(res.text, 100)} notGui=true`);
});

/* ------------------------------------------------------------------ */
/* Item 5: loopback-only pairing page/healthz + attempt guard bypass   */
/* ------------------------------------------------------------------ */
test('E2E-5 loopback guard: /m/pair + /m/pair/info + /healthz loopback-only', async () => {
  const loop = new Phone(state.stack.origin);

  const pairPage = await loop.get('/m/pair');
  assertStatus(pairPage, 200, 'GET /m/pair from 127.0.0.1', 5);
  assert.match(pairPage.headers['content-type'] ?? '', /text\/html/, 'pair page content-type');
  assert.match(pairPage.text, /当前配对 PIN/, 'pair page shows the current PIN heading');
  assert.match(pairPage.text, /id="pin"/, 'pair page PIN element');
  assert.match(pairPage.text, /\/m\/pair\/info/, 'pair page polls /m/pair/info for live URLs');
  assert.match(pairPage.text, /id="urls"/, 'pair page LAN URL list container');
  assert.ok(!/<script\s+src="https?:/i.test(pairPage.text), 'pair page must not load external scripts');

  const info = await loop.get('/m/pair/info');
  assertStatus(info, 200, 'GET /m/pair/info from 127.0.0.1', 5);
  const infoBody = info.json();
  assert.equal(infoBody?.pin, state.stack.pin, 'pair/info pin matches configured test pin');
  assert.ok(Array.isArray(infoBody?.urls) && infoBody.urls.length >= 1, 'pair/info urls[] non-empty');
  assert.equal(infoBody?.port, state.stack.bridgePort, 'pair/info port');
  assert.equal(typeof infoBody?.targetOrigin, 'string', 'pair/info targetOrigin');
  evidence(5, `loopback pair page=200 pin=${infoBody.pin} urls=${infoBody.urls.join(',')}`);

  const health = await loop.get('/healthz');
  assertStatus(health, 200, 'GET /healthz from 127.0.0.1', 5);
  assert.deepEqual(health.json(), { ok: true }, '/healthz body');
  evidence(5, 'loopback /healthz=200 {ok:true}');

  // A request that carries forwarding headers comes from a reverse tunnel (or a
  // client trying to spoof one): even on a loopback socket it must not unlock the
  // desktop-only PIN page / health probe (v0.3.14 tunnel hardening).
  const forwarded = await loop.get('/m/pair/info', { headers: { 'x-forwarded-for': '8.8.8.8, 127.0.0.1' } });
  assertStatus(forwarded, 403, 'GET /m/pair/info with forged X-Forwarded-For', 5);
  assert.equal(forwarded.json()?.error, 'loopback-only', 'forwarded pair/info error');
  evidence(5, 'forwarding headers disqualify loopback-only routes (403) even from 127.0.0.1');

  // A tunnel request keeps the loopback socket but carries the public Host: the
  // desktop pairing page must reject it as well.
  const tunneled = await loop.get('/m/pair', { headers: { host: 'example.lhr.life' } });
  assertStatus(tunneled, 403, 'GET /m/pair with public tunnel Host', 5);
  assert.equal(tunneled.json()?.error, 'loopback-only', 'tunneled pair page error');
  const tunneledHealth = await loop.get('/healthz', { headers: { host: 'example.lhr.life' } });
  assertStatus(tunneledHealth, 403, 'GET /healthz with public tunnel Host', 5);
  evidence(5, 'public tunnel Host on loopback => 403 for /m/pair (/healthz)', 5);

  // Unit-level guard logic (always available even when a non-loopback dial is not).
  const networkPath = pathToFileURL(path.join(PKG_DIR, 'lib', 'network.js')).href;
  const network = await import(networkPath);
  const expectations = [
    ['127.0.0.1', true], ['127.0.0.2', true], ['::1', true], ['::ffff:127.0.0.1', true],
    ['192.168.1.23', false], ['10.0.0.5', false], ['8.8.8.8', false], ['', false], [undefined, false],
  ];
  for (const [address, expected] of expectations) {
    assert.equal(network.isLoopbackAddress(address), expected, `isLoopbackAddress(${JSON.stringify(address)}) === ${expected}`);
  }
  evidence(5, `unit isLoopbackAddress ${expectations.length}/${expectations.length} cases correct`);

  // Real non-loopback peer: dial the bridge through this machine's LAN IPv4. The
  // socket peer address is then the LAN address (not 127.0.0.1) -> 403.
  const lan = lanIPv4();
  if (!lan) {
    state.loopbackEvidence = { nonLoopbackDial: 'skipped', reason: 'no non-internal IPv4 interface' };
    evidence(5, 'non-loopback dial SKIPPED (no LAN IPv4 interface); guard covered by unit test + forged-XFF check');
    return;
  }
  state.loopbackEvidence = { lanAddress: `${lan.address} (${lan.name})` };
  let lanPair;
  try {
    lanPair = await loop.get(`http://${lan.address}:${state.stack.bridgePort}/m/pair`);
  } catch (error) {
    state.loopbackEvidence.dialError = String(error?.message ?? error);
    evidence(5, `non-loopback dial to ${lan.address}:${state.stack.bridgePort} failed (${error?.code ?? error?.message}); guard covered by unit test + forged-XFF check`);
    return;
  }
  assertStatus(lanPair, 403, `GET /m/pair from LAN address ${lan.address}`, 5);
  assert.equal(lanPair.json()?.error, 'loopback-only', 'non-loopback pair page error');
  const lanInfo = await loop.get(`http://${lan.address}:${state.stack.bridgePort}/m/pair/info`);
  assertStatus(lanInfo, 403, `GET /m/pair/info from LAN address ${lan.address}`, 5);
  const lanHealth = await loop.get(`http://${lan.address}:${state.stack.bridgePort}/healthz`);
  assertStatus(lanHealth, 403, `GET /healthz from LAN address ${lan.address}`, 5);
  // a forged loopback X-Forwarded-For from the LAN must not unlock the PIN page
  const lanForged = await loop.get(`http://${lan.address}:${state.stack.bridgePort}/m/pair/info`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
  assertStatus(lanForged, 403, 'LAN request with forged X-Forwarded-For: 127.0.0.1', 5);
  state.loopbackEvidence.nonLoopbackDial = '403 as expected';
  evidence(5, `non-loopback LAN peer ${lan.address}: pair/info/healthz => 403 loopback-only (forged XFF still 403)`);
});

/* ------------------------------------------------------------------ */
/* Item 6: WebSocket /api/remote.mux tunnel through the bridge         */
/* ------------------------------------------------------------------ */
test('E2E-6 WebSocket: /api/remote.mux through bridge -> 101 authed, gated cookie-less, no hangs', { timeout: 30000 }, async () => {
  const bridgeOrigin = state.stack.origin;

  // 6a. authenticated browser (has the DSH cookie) sends Origin = bridge origin;
  //     the bridge rewrites Origin+Host to the DSH origin, so DSH accepts -> 101.
  const authed = new Phone(bridgeOrigin);
  const login = await authed.get(TOKEN_STATE.tokenUrl);
  assert.equal(login.status, 303, 're-login for WS cookie');
  const okWs = await authed.wsUpgrade('/api/remote.mux', { headers: { origin: bridgeOrigin } });
  try {
    assert.equal(okWs.status, 101, `authenticated WS through bridge must be 101, got ${okWs.status} body=${snippet(okWs.body)}`);
    assert.match(String(okWs.headers?.upgrade ?? ''), /websocket/i, '101 Upgrade header');
    assert.ok(okWs.headers?.['sec-websocket-accept'], '101 Sec-WebSocket-Accept present');
    assert.ok(okWs.elapsedMs < 5000, `WS upgrade settled in ${okWs.elapsedMs}ms (<5000ms)`);
    evidence(6, `authed WS -> ${okWs.status} in ${okWs.elapsedMs}ms accept=${okWs.headers['sec-websocket-accept']}`);
  } finally {
    closeWs(okWs);
  }

  // 6b. cookie-less browser -> DSH rejects the tunneled handshake (401/403), fast.
  const anon = new Phone(bridgeOrigin);
  const anonWs = await anon.wsUpgrade('/api/remote.mux', { headers: { origin: bridgeOrigin } });
  try {
    assert.ok([401, 403].includes(anonWs.status), `cookie-less WS must be 401/403, got ${anonWs.status}`);
    assert.ok(anonWs.elapsedMs < 5000, `cookie-less WS settled in ${anonWs.elapsedMs}ms (<5000ms)`);
    evidence(6, `cookie-less WS -> ${anonWs.status} in ${anonWs.elapsedMs}ms body=${snippet(anonWs.body, 80)} (no hang)`);
  } finally {
    closeWs(anonWs);
  }

  // 6c. the tunnel must not be usable as a generic forwarder: wrong Origin is
  //     rewritten to the DSH origin anyway, but an absolute-form upgrade target
  //     is refused by the bridge.
  const raw = await rawHttpRequest(new URL(bridgeOrigin).hostname, state.stack.bridgePort,
    'GET http://evil.example/api/remote.mux HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  assertStatus({ status: raw.status, text: raw.body, location: null }, 400, 'absolute-form WS upgrade target', 6);
  evidence(6, 'absolute-form upgrade target refused with 400');
});

/* ------------------------------------------------------------------ */
/* Item 7: wrong PIN x N -> 401; (N+1)th -> 429 locked                 */
/* ------------------------------------------------------------------ */
test('E2E-7 pairing rate limit: wrong PIN x8 -> 401, 9th -> 429 locked', async () => {
  // NOTE: must run last among PIN tests: it locks the loopback IP for this bridge process.
  const brute = new Phone(state.stack.origin);
  const badPin = state.stack.pin === '000000' ? '111111' : '000000';
  const statuses = [];
  for (let attempt = 1; attempt <= PAIR_ATTEMPTS; attempt++) {
    const res = await brute.post('/m/api/pair', { code: badPin });
    const body = res.json();
    assert.equal(res.status, 401, `wrong PIN attempt ${attempt} must be 401, got ${res.status} ${snippet(res.text)}`);
    assert.equal(body?.ok, false, `attempt ${attempt} ok=false`);
    assert.equal(body?.error, 'bad-pin', `attempt ${attempt} error=bad-pin`);
    assert.equal(body?.attemptsLeft, PAIR_ATTEMPTS - attempt, `attempt ${attempt} attemptsLeft=${PAIR_ATTEMPTS - attempt}`);
    statuses.push(`${attempt}:401(left=${body.attemptsLeft})`);
  }
  const locked = await brute.post('/m/api/pair', { code: badPin });
  const lockedBody = locked.json();
  assertStatus(locked, 429, `wrong PIN attempt ${PAIR_ATTEMPTS + 1} after limit`, 7);
  assert.equal(lockedBody?.ok, false, 'locked ok=false');
  assert.equal(lockedBody?.error, 'locked', 'locked error=locked');
  assert.equal(typeof lockedBody?.retryAfterMs, 'number', 'locked retryAfterMs number');
  assert.ok(lockedBody.retryAfterMs > 0, 'locked retryAfterMs > 0');
  assert.ok(locked.headers['retry-after'], '429 carries Retry-After header');
  // Even the correct PIN is refused while locked (no bypass).
  const correctWhileLocked = await brute.post('/m/api/pair', { code: state.stack.pin });
  assertStatus(correctWhileLocked, 429, 'correct PIN while locked', 7);
  evidence(7, `PASS ${statuses.join(' ')} => 429 locked retryAfterMs=${lockedBody.retryAfterMs} Retry-After=${locked.headers['retry-after']}`);
});

/* ------------------------------------------------------------------ */
/* Item 8: mobile shell in a browser (fallback: DOM contract checks)   */
/* ------------------------------------------------------------------ */
test('E2E-8 mobile shell DOM contract (browser fallback: automation blocked in sandbox)', async () => {
  // Browser automation is blocked in this DSH sandbox (Lead-verified: bsk daemon
  // named-pipe access denied, headless Chromium launch denied). We verify the
  // shell's real HTTP/DOM contract instead, which is what the browser check would
  // exercise: shell HTML -> state -> PIN flow -> cookie -> iframe GUI.
  const shell = state.shellHtml ?? (await state.phone.get('/m/')).text;
  const pinCells = [...shell.matchAll(/class="pin-cell"/g)].length;
  assert.ok(pinCells >= 6, `pairing view has ${pinCells} PIN cells (expected 6)`);
  assert.match(shell, /id="pairForm"/, 'pair form');
  assert.match(shell, /id="guiFrame"[^>]*src="about:blank"/, 'same-origin iframe starts blank');
  assert.match(shell, /id="diagSheet"|id="diagBtn"/, 'diagnostics sheet/button');
  assert.match(shell, /id="offlineBanner"/, 'offline banner');
  assert.match(shell, /lang="zh-CN"/, 'Chinese UI lang');
  assert.match(shell, /viewport-fit=cover/, 'safe-area viewport');
  assert.match(shell, /\.\/app\.js\?/, 'deferred shell script');

  const appJs = await state.phone.get('/m/app.js');
  assertStatus(appJs, 200, 'GET /m/app.js', 8);
  assert.match(appJs.headers['content-type'] ?? '', /javascript/, 'app.js content-type');
  for (const token of ['/m/api/state', '/m/api/pair', 'guiFrame', 'dsh-mobile-adaptive-style']) {
    assert.ok(appJs.text.includes(token), `app.js references ${token}`);
  }

  const manifest = await state.phone.get('/m/manifest.webmanifest');
  assertStatus(manifest, 200, 'GET /m/manifest.webmanifest', 8);
  const manifestJson = manifest.json();
  assert.equal(manifestJson?.name, 'DSH Mobile', 'manifest name');
  assert.equal(manifestJson?.start_url, '/m/', 'manifest start_url');
  assert.equal(manifestJson?.display, 'standalone', 'manifest display standalone');
  assert.ok(Array.isArray(manifestJson?.icons) && manifestJson.icons.length >= 2, 'manifest icons >= 2');
  const sizes = manifestJson.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), `manifest icon sizes ${sizes.join(',')}`);
  for (const icon of manifestJson.icons) {
    const assetPath = `/m/${String(icon.src).replace(/^\.\//, '')}`;
    const res = await state.phone.get(assetPath);
    assertStatus(res, 200, `GET ${assetPath}`, 8);
    assert.match(res.headers['content-type'] ?? '', /image\/png/, 'icon content-type image/png');
  }
  evidence(8, `DOM contract PASS: 6 PIN cells, form, iframe, manifest=${manifestJson.name}/${manifestJson.display}, app.js API refs`);
  evidence(8, 'browser screenshot check BLOCKED (sandbox) - fallback = HTTP/DOM contract above; see tests/README.md');
  fs.writeFileSync(path.join(ARTIFACTS, 'browser-check-FALLBACK.txt'),
    [
      'Browser UI check (E2E acceptance item 8) - FALLBACK USED',
      `Date: ${new Date().toISOString()}`,
      'Reason: browser automation is blocked in the DSH Windows sandbox:',
      '  - %USERPROFILE%\\.local\\bin\\bsk.exe (browser-skill 0.3.3) daemon IPC named pipe is access-denied',
      '  - headless Chrome/Edge launches are terminated immediately under the confined token',
      '(confirmed by Lead; no arbitrary escalated browser run performed by QA)',
      '',
      'Fallback evidence executed by tests/e2e.test.mjs E2E-8 at HTTP/DOM level:',
      `  shell GET /m/ -> 200, ${pinCells} PIN cells, pair form, same-origin iframe, diagnostics, offline banner`,
      '  shell assets app.css/app.js/manifest/icons -> 200 with correct content types',
      '  pairing flow proven end-to-end at HTTP level: POST /m/api/pair -> token URL -> 303 Set-Cookie -> replay -> 200 DSH GUI (items 2-3)',
      '',
      'Manual browser verification (for the human operator):',
      `  1. node tests/harness/boot-dsh.mjs start ; start bridge on 7861 (or run tests/run-all.ps1 and keep it running)`,
      '  2. open http://127.0.0.1:7861/m/ in a desktop browser at phone viewport 390x844',
      '  3. enter PIN 123456 -> the DSH GUI must appear inside the iframe with no console errors',
      '  4. screenshots belong under tests/artifacts/ (browser-edge.png etc.)',
    ].join('\n') + '\n');
});

/* ------------------------------------------------------------------ */
/* Item 9: plugin install proof (artifact produced by install-check)   */
/* ------------------------------------------------------------------ */
test('E2E-9 install proof: package installed into isolated profile + dump-config shows row', (t) => {
  const proofFile = path.join(WORKSPACE, '.test-home', 'install-proof.json');
  if (!fs.existsSync(proofFile)) {
    evidence(9, `install proof artifact missing (${proofFile}); run tests/harness/install-check.ps1 first`);
    t.skip('run tests/harness/install-check.ps1 to produce .test-home/install-proof.json');
    return;
  }
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  assert.equal(proof.ok, true, `install proof ok: ${JSON.stringify(proof.error ?? proof)}`);
  assert.equal(proof.dumpConfigHasMobileBridge, true, 'dump-config contains mobile-bridge row');
  assert.ok(proof.mode === 'dsh-plugin-add' || proof.mode === 'manual-fallback', `install mode ${proof.mode}`);
  evidence(9, `PASS mode=${proof.mode} packageJsonHasPlugin=${proof.packageJsonHasPlugin} dumpConfigRow=${proof.dumpConfigHasMobileBridge}`);
});

/* ------------------------------------------------------------------ */
/* Extra: JSON/HTML error handling on the bridge surface               */
/* ------------------------------------------------------------------ */
test('E2E-X error handling: JSON errors for API misuse, HTML/HTTP for protocol misuse', async () => {
  const phone = new Phone(state.stack.origin);

  const wrongMethod = await phone.get('/m/api/pair');
  assertStatus(wrongMethod, 405, 'GET /m/api/pair', 'X');
  assert.match(wrongMethod.headers.allow ?? '', /POST/, '405 Allow header mentions POST');
  assert.equal(wrongMethod.json()?.error, 'method-not-allowed', '405 JSON error');

  const wrongType = await phone.post('/m/api/pair', 'code=123456', { headers: { 'content-type': 'text/plain' } });
  assertStatus(wrongType, 415, 'POST /m/api/pair text/plain', 'X');
  assert.equal(wrongType.json()?.error, 'unsupported-media-type', '415 JSON error');

  const badJson = await phone.request('/m/api/pair', { method: 'POST', body: '{"code":', headers: { 'content-type': 'application/json' } });
  assertStatus(badJson, 400, 'POST /m/api/pair malformed JSON', 'X');
  assert.equal(badJson.json()?.error, 'bad-request', '400 JSON error');

  const noCode = await phone.post('/m/api/pair', {});
  assertStatus(noCode, 400, 'POST /m/api/pair without code', 'X');
  assert.equal(noCode.json()?.error, 'bad-request', 'missing code JSON error');

  const unknownApi = await phone.get('/m/api/nope');
  assertStatus(unknownApi, 404, 'GET /m/api/nope', 'X');
  assert.equal(unknownApi.json()?.error, 'not-found', '404 JSON error');

  // absolute-form request target: the bridge is not a forward proxy.
  const absolute = await rawHttpRequest('127.0.0.1', state.stack.bridgePort,
    'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
  assertStatus({ status: absolute.status, text: absolute.body, location: null }, 400, 'absolute-form GET', 'X');

  // CONNECT is refused.
  const connect = await rawHttpRequest('127.0.0.1', state.stack.bridgePort,
    'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  assertStatus({ status: connect.status, text: connect.body, location: null }, 405, 'CONNECT', 'X');

  // Unknown top-level path is proxied (not a bridge-local 404 page).
  const proxied = await phone.get('/does-not-exist-e2e-probe');
  assert.ok([200, 302, 303, 401, 404].includes(proxied.status), `proxied unknown path status ${proxied.status}`);
  evidence('X', `PASS 405/415/400/400/404 JSON + absolute-form=400 + CONNECT=405 + proxied=${proxied.status}`);
});
