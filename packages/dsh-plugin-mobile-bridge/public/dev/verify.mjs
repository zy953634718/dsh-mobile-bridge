#!/usr/bin/env node
/**
 * DSH Mobile — shell + mock-server verification (dev-only, no dependencies)
 * ==========================================================================
 * Boots dev/mock-server.mjs in-process on an OS-assigned port and verifies:
 *   - the v0.3.6 「沉浸式原生」production shell assets (design landing)
 *   - the E2E DOM contract (pairingView / pairForm / 6 pin-cell / guiFrame /
 *     offlineBanner / diagBtn / manifest / api tokens)
 *   - /m/api/state, /m/api/pair, token login handshake, PIN lockout
 *   - real-GUI mapping constants (dock → aria-label selects, session scrape)
 *   - APK mode + download card + settings/appearance code paths
 *
 * Usage: node packages/dsh-plugin-mobile-bridge/public/dev/verify.mjs [--verbose]
 * Exit code 0 = all checks passed. No child processes, no network access.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
}

function record(name, ok, details) {
  results.push({ group: currentGroup, name, ok: !!ok, details: details || '' });
  if (VERBOSE) console.log(`[${ok ? 'PASS' : 'FAIL'}] ${currentGroup} :: ${name}${ok || !details ? '' : ' — ' + details}`);
}

async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome === false) record(name, false, 'returned false');
    else if (outcome && typeof outcome === 'object' && outcome.ok === false) record(name, false, outcome.details || 'failed');
    else if (typeof outcome === 'string') record(name, false, outcome);
    else record(name, true);
  } catch (error) {
    record(name, false, (error && error.message) || String(error));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

function cookieJar() {
  const jar = new Map();
  return {
    header() {
      if (!jar.size) return undefined;
      return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
    },
    absorb(response) {
      const setCookies =
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const line of setCookies) {
        const [pair] = String(line).split(';');
        const index = pair.indexOf('=');
        if (index < 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (/Max-Age=0/i.test(line) || !value) jar.delete(name);
        else jar.set(name, value);
      }
      return setCookies;
    },
    clear() {
      jar.clear();
    },
  };
}

async function request(base, path, options) {
  const opts = options || {};
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  const response = await fetch(base + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: opts.redirect || 'manual',
    cache: 'no-store',
  });
  const text = await response.text();
  return { response, text, status: response.status };
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) if (buffer[i] !== signature[i]) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

const mock = await startMockServer({ port: 0, pin: '123456', paired: false, log: () => {} });
const base = `http://127.0.0.1:${mock.port}`;

try {
  /* ================= static shell ================= */
  group('static shell (v0.3.6 design)');

  await check('GET /m/ returns the redesigned mobile shell', async () => {
    const { status, response, text } = await request(base, '/m/');
    expect(status === 200, 'status ' + status);
    expect((response.headers.get('content-type') || '').includes('text/html'), 'content-type');
    expect(text.includes('<title>DSH Mobile</title>'), 'title');
    expect(text.includes('id="pairingView"'), 'pairingView');
    expect(text.includes('id="pairForm"'), 'pairForm');
    expect(text.includes('id="pinRow"'), 'pinRow');
    expect(text.includes('id="offlineBanner"'), 'offlineBanner');
    expect(text.includes('id="diagBtn"'), 'diagBtn (quick-sheet diagnostics action)');
    expect(/id="guiFrame"[^>]*src="about:blank"/.test(text), 'guiFrame about:blank');
    expect(occurrences(text, 'class="pin-cell"') === 6, 'expected exactly 6 .pin-cell inputs');
    expect(text.includes('data-dock="sessions"'), 'dock sessions');
    expect(text.includes('data-dock="new"'), 'dock new');
    expect(text.includes('data-dock="refresh"'), 'dock refresh');
    expect(text.includes('data-dock="more"'), 'dock more');
    expect(occurrences(text, 'data-key=') === 11, '11 keypad keys');
    expect(text.includes('id="appHandle"'), 'APK recoverable handle');
    expect(text.includes('id="pairSuccess"'), 'pairing success overlay');
    expect(text.includes('id="drawer"'), 'session drawer');
    expect(text.includes('id="quickSheet"'), 'quick-actions sheet');
    expect(text.includes('id="settingsView"'), 'settings screen');
    expect(text.includes('data-screen-id="pair"'), 'pair screen');
    expect(text.includes('data-screen-id="chat"'), 'chat screen');
    expect(text.includes('data-screen-id="settings"'), 'settings screen id');
    return true;
  });

  await check('versioned assets + manifest/E2E contract preserved', async () => {
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    const assetVersion = (html.match(/app\.js\?v=([0-9.]+)/) || [])[1];
    expect(!!assetVersion, 'versioned app.js asset');
    expect(html.includes('./app.css?v=' + assetVersion), 'app.css matches asset version');
    expect(html.includes('./app.js?v=' + assetVersion), 'app.js matches asset version');
    expect(/<script[^>]+src="\.\/app\.js\?[^"]*"\s+defer/.test(html), 'deferred shell script');
    expect(html.includes('rel="manifest" href="./manifest.webmanifest"'), 'manifest link');
    expect(html.includes('lang="zh-CN"'), 'lang zh-CN');
    expect(html.includes('viewport-fit=cover'), 'viewport-fit=cover');
    expect(html.includes('width=device-width'), 'width=device-width');
    expect(html.includes('id="pairingView"'), 'pairingView');
    expect(html.includes('id="pairForm"'), 'pairForm');
    return true;
  });

  await check('GET /m/app.css: production + approved design styles', async () => {
    const htmlSource = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    const cssVersion = (htmlSource.match(/app\.css\?v=([0-9.]+)/) || [])[1];
    const { status, response, text } = await request(base, '/m/app.css?v=' + cssVersion);
    expect(status === 200, 'status ' + status);
    expect((response.headers.get('content-type') || '').includes('text/css'), 'content-type');
    for (const token of [
      '.frame-host',
      '.capsule',
      '.dock',
      '.drawer',
      '.sheet',
      '.settings-card',
      '.pair-card',
      '.keypad',
      '.pair-success',
      '.app[data-mode="apk"]',
      '.app[data-keyboard="open"]',
      'prefers-reduced-motion',
      'backdrop-filter',
    ]) {
      expect(text.includes(token), 'missing CSS token ' + token);
    }
    expect(!/url\(\s*["']?https?:/i.test(text), 'no external CSS url()');
    return true;
  });

  await check('GET /m/app.js exposes the required behaviour tokens', async () => {
    const htmlSource = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    const jsVersion = (htmlSource.match(/app\.js\?v=([0-9.]+)/) || [])[1];
    const { status, response, text } = await request(base, '/m/app.js?v=' + jsVersion);
    expect(status === 200, 'status ' + status);
    expect((response.headers.get('content-type') || '').includes('javascript'), 'content-type');
    for (const token of [
      '/m/api/state',
      '/m/api/pair',
      'guiFrame',
      'dsh-mobile-adaptive-style',
      'login-frame',
      'manualLogin',
      'detectAuthPage',
      'WATCHDOG_INTERVAL_MS = 5000',
      'DSHMobileApp/',
      './download/DSH-Mobile.apk',
      'GUI_ACTION_SELECTORS',
      'button[aria-label="打开侧边栏"]',
      'button[aria-label="新建会话"]',
      'openGuiSessionList',
      'drawerFallback',
      'retryAutoLogin',
      'settingsDownloadApk',
      'applyTheme',
      'applyAccent',
      'applyScale',
      // v0.3.6 sidebar UX (Lead-verified injected CSS + Dock 会话 toggle)
      '[data-sidebar-collapsed="true"]',
      'grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px)',
      'visibility: hidden',
      '[class*="brand"]',
      '[class*="newSession"]',
      '[class*="panelRow"]',
      '[aria-label="插件"]',
      '[aria-label="自动化任务"]',
      '[aria-label="账号菜单"]',
      'function toggleGuiSidebar',
      'function activateSessionsEntry',
      // v0.3.6 desktop-dialog guard
      'DESKTOP_DIALOG_PATTERN',
      'data-dsh-mobile-blocked',
      'installGuiDialogGuard',
      'onGuardedClickCapture',
      'MOBILE_BLOCKED_TOAST_TEXT',
      'MOBILE_TOAST_MESSAGE_TYPE',
    ]) {
      expect(text.includes(token), 'missing app.js token ' + token);
    }
    return true;
  });

  await check('manifest is unchanged (DSH Mobile PWA)', async () => {
    const { status, response, text } = await request(base, '/m/manifest.webmanifest');
    expect(status === 200, 'status ' + status);
    expect((response.headers.get('content-type') || '').includes('application/manifest+json'), 'content-type');
    const manifest = JSON.parse(text);
    expect(manifest.name === 'DSH Mobile', 'name');
    expect(manifest.start_url === '/m/', 'start_url');
    expect(manifest.scope === '/m/', 'scope');
    expect(manifest.display === 'standalone', 'display');
    expect(Array.isArray(manifest.icons) && manifest.icons.length >= 4, 'icons');
    return true;
  });

  await check('icons exist with correct PNG dimensions', async () => {
    const expected = [
      ['/m/icons/icon-192.png', 192, 192],
      ['/m/icons/icon-512.png', 512, 512],
      ['/m/icons/icon-maskable-192.png', 192, 192],
      ['/m/icons/icon-maskable-512.png', 512, 512],
      ['/m/icons/apple-touch-icon-180.png', 180, 180],
      ['/m/icons/favicon-32.png', 32, 32],
    ];
    for (const [path, width, height] of expected) {
      const response = await fetch(base + path);
      expect(response.status === 200, `${path} status ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const size = pngSize(buffer);
      expect(size !== null, `${path} not a PNG`);
      expect(size.width === width && size.height === height, `${path} size ${size.width}x${size.height}`);
    }
    const svg = await fetch(base + '/m/icons/favicon.svg');
    expect(svg.status === 200, 'favicon.svg');
    return true;
  });

  await check('every local asset referenced by index.html resolves', async () => {
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    const refs = new Set();
    const regex = /(?:src|href)="(\.\/[^"#]+)"/g;
    let match;
    while ((match = regex.exec(html))) refs.add(match[1].split('?')[0]);
    expect(refs.size >= 5, 'expected several local refs, got ' + refs.size);
    for (const ref of refs) {
      const response = await fetch(base + '/m/' + ref.replace(/^\.\//, ''));
      expect(response.status === 200, `${ref} -> ${response.status}`);
    }
    return true;
  });

  await check('path traversal is rejected', async () => {
    for (const probe of ['/m/../package.json', '/m/%2e%2e/package.json', '/m/..%2fpackage.json']) {
      const response = await fetch(base + probe);
      expect(response.status === 404 || response.status === 400, `${probe} -> ${response.status}`);
      const text = await response.text();
      expect(!text.includes('"name"'), `${probe} leaked package.json`);
    }
    return true;
  });

  /* ================= API contract ================= */
  group('/m/api contract');

  await check('GET /m/api/state -> ok, paired:false, host, dshUrl', async () => {
    const { status, text } = await request(base, '/m/api/state');
    expect(status === 200, 'status ' + status);
    const json = JSON.parse(text);
    expect(json.ok === true, 'ok');
    expect(json.paired === false, 'paired false');
    expect(json.dshUrl === '/', 'dshUrl');
    expect(json.pinRequired === true, 'pinRequired');
    expect(typeof json.host === 'string' && json.host.length > 0, 'host');
    return true;
  });

  await check('POST /m/api/pair wrong PIN -> 401 bad-pin', async () => {
    const { status, text } = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(status === 401, 'status ' + status);
    const json = JSON.parse(text);
    expect(json.ok === false && json.error === 'bad-pin', 'bad-pin payload');
    return true;
  });

  await check('POST /m/api/pair right PIN -> 200 tokenised url', async () => {
    const { status, text } = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(status === 200, 'status ' + status);
    const json = JSON.parse(text);
    expect(json.ok === true, 'ok');
    expect(typeof json.url === 'string' && json.url.includes('token='), 'tokenised url');
    expect(Number(json.expiresInMs) > 0, 'expiresInMs');
    return true;
  });

  await check('token url -> 303 + Set-Cookie; cookie unlocks / and state', async () => {
    const jar = cookieJar();
    const pair = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    const tokenPath = JSON.parse(pair.text).url.replace(base, '');
    const tokenRes = await request(base, tokenPath);
    expect(tokenRes.status === 303, 'token status ' + tokenRes.status);
    const setCookies = jar.absorb(tokenRes.response);
    expect(setCookies.length > 0, 'expected Set-Cookie');
    const gui = await request(base, '/', { cookie: jar.header() });
    expect(gui.status === 200, 'GUI status ' + gui.status);
    expect(gui.text.includes('DeepSeek Harness'), 'mock GUI title');
    const state = await request(base, '/m/api/state', { cookie: jar.header() });
    expect(JSON.parse(state.text).paired === true, 'paired true after cookie');
    return true;
  });

  await check('unauthenticated / -> 401 with DSH auth text', async () => {
    const { status, text } = await request(base, '/');
    expect(status === 401, 'status ' + status);
    expect(text.includes('authentication required'), 'auth text');
    return true;
  });

  await check('GET /m/api/pair -> 405', async () => {
    const response = await fetch(base + '/m/api/pair', { method: 'GET', redirect: 'manual' });
    expect(response.status === 405, 'status ' + response.status);
    return true;
  });

  await check('dev mode --paired: state paired:true + GUI without cookie', async () => {
    const pairedMock = await startMockServer({ port: 0, pin: '123456', paired: true, log: () => {} });
    const pairedBase = `http://127.0.0.1:${pairedMock.port}`;
    try {
      const state = await request(pairedBase, '/m/api/state');
      expect(JSON.parse(state.text).paired === true, 'paired:true expected');
      const gui = await request(pairedBase, '/');
      expect(gui.status === 200 && gui.text.includes('DeepSeek Harness'), 'mock GUI');
      await request(pairedBase, '/__mock/logout', { method: 'POST' });
      const after = await request(pairedBase, '/m/api/state');
      expect(JSON.parse(after.text).paired === false, 'logout clears forced pairing');
    } finally {
      await pairedMock.close();
    }
    return true;
  });

  /* ================= lockout ================= */
  group('PIN lockout');

  await check('8 bad PINs -> 429 locked with retry-after; good PIN also blocked', async () => {
    await fetch(base + '/__mock/reset');
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const { status } = await request(base, '/m/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '999999' }),
      });
      statuses.push(status);
    }
    expect(statuses.slice(0, 7).every((status) => status === 401), 'expected 401 for attempts 1..7, got ' + statuses.join(','));
    expect(statuses[7] === 429, 'expected 429 on attempt 8, got ' + statuses[7]);
    const locked = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(locked.status === 429, 'good pin while locked -> ' + locked.status);
    expect((locked.response.headers.get('retry-after') || '').length > 0, 'retry-after header');
    const json = JSON.parse(locked.text);
    expect(json.ok === false && json.error === 'locked', 'locked payload');
    expect(Number(json.retryAfter) > 0, 'retryAfterMs payload');
    await fetch(base + '/__mock/reset');
    return true;
  });

  await check('lockout resets after /__mock/reset and pairing works again', async () => {
    const { status } = await request(base, '/m/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(status === 200, 'status ' + status);
    return true;
  });

  /* ================= shell code contracts ================= */
  group('shell code contracts (v0.3.6)');

  await check('pairing flow: keypad -> pair -> hidden iframe redeem -> GUI', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    for (const token of [
      'function pressDigit',
      'function submitPair',
      'function redeemToken',
      'function handlePairSuccess',
      'function enterChat',
      'function loadFrame',
      "frame.src = '/'",
      'showPairSuccess',
      'showPairFallback',
      'manualLogin',
      'retryAutoLogin',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    return true;
  });

  await check('APK full-screen mode preserved (UA/?app=1/DshApp + insets)', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    const css = await readFile(resolve(PUBLIC_ROOT, 'app.css'), 'utf8');
    for (const token of [
      "APP_MODE_UA_TOKEN = 'DSHMobileApp/'",
      "params.get('app') === '1'",
      'window.DshApp',
      'getTopInsetPx',
      'applyAppMode',
      'setupAppHandleGestures',
      'setBarsHidden',
      'revealBars',
      '--apk-top-inset',
    ]) {
      expect(code.includes(token), 'missing app.js token ' + token);
    }
    expect(css.includes('.app[data-mode="apk"]'), 'APK CSS branch');
    expect(css.includes('.app-handle'), 'recoverable handle');
    return true;
  });

  await check('dock maps to real GUI aria-label controls + local actions', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    for (const token of [
      'button[aria-label="打开侧边栏"]',
      'button[aria-label="收起侧边栏"]',
      'button[aria-label="新建会话"]',
      'button[aria-label="Open sidebar"]',
      'button[aria-label="New session"]',
      'function clickGuiAction',
      'function resolveGuiAction',
      'function handleDockAction',
      'is-unavailable',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    expect(occurrences(html, 'data-dock=') === 4, '4 dock buttons');
    return true;
  });

  await check('v0.3.6 sidebar UX: rail hidden via injected CSS + Dock 会话 toggles real GUI', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    for (const token of [
      '[data-sidebar-collapsed="true"]',
      'grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px)',
      'visibility: hidden !important',
      'overflow: hidden !important',
      'min-width: 0 !important',
      '[class*="brand"]',
      '[class*="newSession"]',
      '[class*="panelRow"]',
      '[aria-label="插件"], html.dsh-mobile [aria-label="自动化任务"], html.dsh-mobile [aria-label="账号菜单"]',
      'function guiSidebarExpanded',
      'function syncDockSidebarState',
      'function toggleGuiSidebar',
      'function activateSessionsEntry',
      'sidebarExpanded: state.guiSidebarExpanded',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    // Dock 会话 must prefer the real GUI toggle and only fall back to the drawer.
    expect(
      code.includes('if (state.frameLoaded && toggleGuiSidebar()) return;'),
      'Dock 会话 should prefer the real GUI toggle, drawer only as fallback',
    );
    expect(
      /function handleDockAction[\s\S]{0,240}activateSessionsEntry\(\)/.test(code),
      'handleDockAction(sessions) must call activateSessionsEntry()',
    );
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    expect(html.includes('data-dock="sessions"'), 'dock sessions button exists');
    return true;
  });

  await check('v0.3.6 desktop-dialog guard: hides/blocks native picker actions, no false positives', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    for (const token of [
      'DESKTOP_DIALOG_HIDE_SELECTORS',
      'button[aria-label="添加工作区"]',
      '[aria-label*="打开工作区"]',
      '[aria-label*="新建工作区"]',
      '[aria-label*="打开文件夹"]',
      '[aria-label*="选择目录"]',
      '[aria-label*="打开方式"]',
      '[aria-label*="Open in"]',
      'data-dsh-mobile-blocked',
      'function installGuiDialogGuard',
      'function scanGuardedGuiActions',
      'function matchGuardedAction',
      'function onGuardedClickCapture',
      'function onGuardedPointerCapture',
      'new MutationObserver',
      'stopImmediatePropagation',
      'postMessage',
      '手机端暂不支持该操作（需在电脑端选择）',
      // v0.3.6 empty-workspace protection (chooser opens desktop picker when no workspace exists)
      'EMPTY_WORKSPACE_STATE_PATTERN',
      'WORKSPACE_CHOOSER_TEXT_PATTERN',
      'function guiHasEmptyWorkspaceState',
      'function isWorkspaceChooserInEmptyState',
      '手机端暂不支持，请在电脑端打开/新建工作区',
      // v0.3.6 stale-mark auto-unmark (workspace data can arrive after first paint)
      'guardedElementSnapshots',
      'function unmarkGuardedAction',
      'characterData: true',
      'unmarked += 1',
      'lastUnblockedCount',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    // matcher must stay action-specific: never include the workspace switcher or workspace rows
    const patternMatch = code.match(/const DESKTOP_DIALOG_PATTERN\s*=\s*([\s\S]*?);/);
    expect(patternMatch, 'DESKTOP_DIALOG_PATTERN constant');
    expect(!patternMatch[1].includes('选择工作区'), 'matcher must NOT match 选择工作区');
    expect(!patternMatch[1].includes('默认工作区'), 'matcher must NOT match 默认工作区');
    // v0.3.6: the empty-state chooser lives in the composer region, so it must be
    // checked BEFORE the composer/session exclusion in matchGuardedAction().
    const matchStart = code.indexOf('function matchGuardedAction');
    const matchEnd = code.indexOf('function markGuardedAction');
    expect(matchStart >= 0 && matchEnd > matchStart, 'matchGuardedAction function');
    const matchBody = code.slice(matchStart, matchEnd);
    expect(
      matchBody.indexOf('isWorkspaceChooserInEmptyState') >= 0 &&
        matchBody.indexOf('isWorkspaceChooserInEmptyState') < matchBody.indexOf('isGuiSessionOrComposer'),
      'empty-state chooser check must run before composer/session exclusion',
    );
    // empty-state protection must only hide the chooser when no workspace exists
    expect(
      code.includes('if (emptyWorkspace)') || code.includes('emptyWorkspace ? EMPTY_WORKSPACE_BLOCKED_TOAST_TEXT'),
      'empty-state chooser blocking branch',
    );
    // shell receiver for the in-iframe postMessage
    expect(code.includes("window.addEventListener('message'"), 'shell message listener');
    expect(
      code.includes('if (!data || data.type !== MOBILE_TOAST_MESSAGE_TYPE) return;'),
      'shell filters dsh-mobile-toast messages',
    );
    const uiSmoke = await readFile(resolve(PUBLIC_ROOT, 'dev/ui-smoke.mjs'), 'utf8');
    for (const token of ['添加工作区', '选择工作区', '手机端暂不支持', 'data-dsh-mobile-blocked', 'aria-label="添加工作区"', 'empty-workspace']) {
      expect(uiSmoke.includes(token), 'ui-smoke missing guard assertion token ' + token);
    }
    return true;
  });

  await check('session drawer: GUI scrape first, degraded fallback second', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    for (const token of [
      'function collectGuiSessions',
      'function openGuiSidebar',
      'function closeGuiSidebar',
      'function scrapeGuiSessions',
      'function renderDrawerSessions',
      'function activateGuiSession',
      'function openGuiSessionList',
      '打开桌面会话列表',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    expect(html.includes('id="drawerFallback"'), 'drawer fallback block');
    expect(html.includes('id="openGuiSessionsBtn"'), 'open GUI session list button');
    return true;
  });

  await check('real functions preserved: watchdog/adaptive CSS/401/manual login', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    for (const token of [
      '/m/api/state',
      '/m/api/pair',
      'dsh-mobile-adaptive-style',
      'detectAuthPage',
      'authentication required',
      'WATCHDOG_INTERVAL_MS = 5000',
      'visibilitychange',
      'showOffline',
      'TOKEN_REDEEM_WAIT_MS = 600',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    expect(code.includes('window.location.href = state.loginUrl'), 'manual login navigation');
    return true;
  });

  await check('settings/diagnostics + appearance + APK download card', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    for (const id of [
      'settingsOrigin',
      'settingsHost',
      'settingsMode',
      'settingsNative',
      'settingsQuick',
      'settingsLastError',
      'settingsDownloadApk',
      'copyDiagBtn',
      'disconnectBtn',
      'themeRow',
      'accentRow',
      'fontScaleInput',
    ]) {
      expect(html.includes('id="' + id + '"'), 'missing settings node #' + id);
    }
    for (const token of [
      'APK_DOWNLOAD_URL',
      'probeApkAvailability',
      'downloadApk',
      'disconnectToPairing',
      'applyTheme',
      'applyAccent',
      'applyScale',
      'THEME_STORAGE_KEY',
      'ACCENT_STORAGE_KEY',
    ]) {
      expect(code.includes(token), 'missing ' + token);
    }
    return true;
  });

  /* ================= DOM contract static checks ================= */
  group('DOM contract');

  await check('every DOM id referenced by app.js exists in index.html', async () => {
    const code = await readFile(resolve(PUBLIC_ROOT, 'app.js'), 'utf8');
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    const idSet = new Set(htmlIds);
    const duplicates = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
    expect(duplicates.length === 0, 'duplicate ids: ' + duplicates.join(', '));
    const refs = [...new Set([...code.matchAll(/(?<!\$)\$\('([^']+)'\)/g)].map((match) => match[1]))];
    expect(refs.length > 20, `expected many id refs, got ${refs.length}`);
    for (const id of refs) expect(idSet.has(id), `app.js references #${id} but index.html does not define it`);
    return true;
  });

  await check('every class toggled by app.js has a CSS rule', async () => {
    const css = await readFile(resolve(PUBLIC_ROOT, 'app.css'), 'utf8');
    const classes = [
      'is-visible',
      'is-open',
      'is-active',
      'is-done',
      'is-shaking',
      'is-filled',
      'is-error',
      'is-unavailable',
      'is-spinning',
      'login-frame',
      'drawer-note',
    ];
    for (const cls of classes) expect(css.includes('.' + cls), `app.css has no .${cls} rule`);
    return true;
  });

  await check('html document basics preserved', async () => {
    const html = await readFile(resolve(PUBLIC_ROOT, 'index.html'), 'utf8');
    expect(html.startsWith('<!doctype html>'), 'doctype');
    expect(html.includes('id="bootView"'), 'boot view');
    expect(html.includes('id="chatView"'), 'chat view');
    expect(html.includes('id="settingsBack"'), 'settings back');
    expect(html.includes('noscript'), 'noscript fallback');
    expect(!/http(s)?:\/\//.test(html), 'shell must not reference external URLs');
    return true;
  });

  await check('no external network references in shell assets', async () => {
    for (const file of ['index.html', 'app.css', 'app.js', 'manifest.webmanifest']) {
      const text = await readFile(resolve(PUBLIC_ROOT, file), 'utf8');
      const external = text.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]+/g) || [];
      expect(external.length === 0, `${file} references ${external.join(', ')}`);
    }
    return true;
  });

  await check('ui-smoke + dom-smoke tooling updated for the redesign', async () => {
    const uiSmoke = await readFile(resolve(PUBLIC_ROOT, 'dev/ui-smoke.mjs'), 'utf8');
    const domSmoke = await readFile(resolve(PUBLIC_ROOT, 'dev/dom-smoke.mjs'), 'utf8');
    expect(uiSmoke.includes('--bridge') && uiSmoke.includes('--pin'), 'ui-smoke CLI flags');
    expect(uiSmoke.includes('Emulation.setDeviceMetricsOverride'), 'mobile emulation');
    expect(uiSmoke.includes('Emulation.setUserAgentOverride'), 'UA override for APK mode');
    for (const token of [
      'data-sidebar-collapsed',
      'gridTemplateColumns',
      'workspace',
      'optimized-sidebar.png',
      '添加工作区',
      '选择工作区',
      '手机端暂不支持',
      'data-dsh-mobile-blocked',
    ]) {
      expect(uiSmoke.includes(token), 'ui-smoke missing v0.3.6 assertion token ' + token);
    }
    for (const shot of ['optimized-pair.png', 'optimized-main.png', 'optimized-sidebar.png', 'optimized-quick-actions.png', 'optimized-apk.png', 'optimized-sidebar-guard.png']) {
      expect(uiSmoke.includes(shot), 'ui-smoke screenshot ' + shot);
    }
    expect(domSmoke.includes("'--app-mode'"), 'dom-smoke APK scenario flag');
    return true;
  });

  await check('file sizes are reasonable', async () => {
    for (const file of ['index.html', 'app.css', 'app.js', 'manifest.webmanifest']) {
      const info = await stat(resolve(PUBLIC_ROOT, file));
      expect(info.size < 220 * 1024, `${file} too large: ${info.size}`);
    }
    return true;
  });
} finally {
  await mock.close();
}

const groups = new Map();
for (const result of results) {
  if (!groups.has(result.group)) groups.set(result.group, []);
  groups.get(result.group).push(result);
}

let passed = 0;
let failed = 0;
const failures = [];
console.log('');
console.log('DSH Mobile — shell verification v0.3.6 (mock server, HTTP level)');
console.log('='.repeat(72));
for (const [name, groupResults] of groups) {
  console.log(`\n${name}`);
  for (const result of groupResults) {
    const tag = result.ok ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${result.name}${result.ok || !result.details ? '' : '\n         ↳ ' + result.details}`);
    if (result.ok) passed += 1;
    else {
      failed += 1;
      failures.push(`${name} :: ${result.name} — ${result.details}`);
    }
  }
}
console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((failure) => console.log('  - ' + failure));
  process.exitCode = 1;
} else {
  console.log('All checks passed.');
}
