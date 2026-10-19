#!/usr/bin/env node
/**
 * DSH Mobile — headless-Chrome UI smoke test (dev-only, no dependencies)
 * =========================================================================
 * Boots the phone shell at `<bridge>/m/` in a real headless Chromium at a
 * 390x844 mobile viewport, pairs with the PIN through the new numeric keypad,
 * verifies the real DSH GUI renders in the same-origin iframe behind the glass
 * Dock, exercises the Dock quick actions / session drawer / quick sheet and
 * finally re-opens the shell in APK mode (Android WebView UA + `?app=1`) to
 * verify the full-screen native layout.
 *
 * Requires a running bridge exposing /m/ and /m/api/* (e.g. the plugin's own
 * listener on 7876, or the dev mock server on 7862). It does NOT start DSH.
 *
 * Usage (run where headless Chrome is allowed, e.g. the Lead session):
 *   node packages/dsh-plugin-mobile-bridge/public/dev/ui-smoke.mjs \
 *     --bridge http://127.0.0.1:7876 --pin 112233
 *
 * Options:
 *   --bridge <url>     bridge/mock origin         (default http://127.0.0.1:7876)
 *   --pin <pin>        pairing PIN               (default 112233)
 *   --out <dir>        screenshot dir            (default public/dev/screenshots)
 *   --chrome <path>    Chrome/Edge executable    (auto-detected)
 *   --keep-profile      keep the temp Chrome profile for debugging
 *
 * Outputs:
 *   optimized-pair.png, optimized-main.png, optimized-sidebar.png,
 *   optimized-quick-actions.png, optimized-apk.png, optimized-sidebar-guard.png\n *   and ui-smoke-report.json
 *   in --out. Exit code 0 = all checks passed.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '..');
const DEFAULT_OUT = join(PUBLIC_ROOT, 'dev', 'screenshots');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    bridge: 'http://127.0.0.1:7876',
    pin: '112233',
    out: DEFAULT_OUT,
    chrome: '',
    keepProfile: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--bridge') args.bridge = argv[++i];
    else if (flag === '--pin') args.pin = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--chrome') args.chrome = argv[++i];
    else if (flag === '--keep-profile') args.keepProfile = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* Chrome discovery + CDP client                                       */
/* ------------------------------------------------------------------ */

function findChrome(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  candidates.push(
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  throw new Error('Could not find Chrome/Edge. Pass --chrome <path>.');
}

async function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.eventHandlers = [];
    this.consoleErrors = [];
    this.detached = false;
  }

  async connect(timeoutMs = 10000) {
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) throw new Error('Node runtime has no global WebSocket');
    this.ws = new WebSocketImpl(this.wsUrl);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolvePromise();
      });
      this.ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket error: ' + (event && event.message ? event.message : 'unknown')));
      });
    });
    this.ws.addEventListener('message', (event) => this._onMessage(event));
    this.ws.addEventListener('close', () => {
      this.detached = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  _onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (_) {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      this._captureConsole(message);
      for (const handler of this.eventHandlers) {
        try {
          handler(message);
        } catch (_) {
          /* ignore listener errors */
        }
      }
    }
  }

  _captureConsole(message) {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params && message.params.exceptionDetails;
      const text =
        (details && (details.exception && (details.exception.description || details.exception.value))) ||
        (details && details.text) ||
        'uncaught exception';
      this.consoleErrors.push({ type: 'exception', text: String(text) });
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params && message.params.type;
      if (type !== 'error' && type !== 'assert') return;
      const args = (message.params && message.params.args) || [];
      const text = args
        .map((arg) => (arg && typeof arg.value !== 'undefined' ? String(arg.value) : arg && arg.description ? arg.description : ''))
        .join(' ');
      this.consoleErrors.push({ type: 'console.error', text });
      return;
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params && message.params.entry;
      if (!entry || entry.level !== 'error') return;
      this.consoleErrors.push({ type: 'log.error', text: entry.text || entry.url || '', url: entry.url || '' });
    }
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.detached) return Promise.reject(new Error('CDP detached'));
    const id = (this.nextId += 1);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* reporting                                                           */
/* ------------------------------------------------------------------ */

const results = [];
let startedAt = Date.now();

function record(name, ok, details, extra) {
  results.push({
    name,
    ok: !!ok,
    details: details || '',
    extra: extra || null,
    durationMs: 0,
  });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${ok || !details ? '' : '\n       ↳ ' + details}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const outcome = await fn();
    if (outcome && typeof outcome === 'object' && outcome.ok === false) {
      record(name, false, outcome.details || 'failed', outcome.extra);
    } else if (typeof outcome === 'string') {
      record(name, false, outcome);
    } else {
      record(name, true, '', outcome && outcome.extra ? outcome.extra : null);
    }
  } catch (error) {
    record(name, false, (error && error.message) || String(error));
  } finally {
    results[results.length - 1].durationMs = Date.now() - started;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message || 'expectation failed');
}

function isBenignConsole(text) {
  return /favicon|net::ERR_ABORTED|ERR_CONNECTION_RESET|WebSocket connection|DevTools|Autofill|third-party cookie|deprecated/i.test(
    String(text || ''),
  );
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    [
      'DSH Mobile headless UI smoke test',
      '',
      'Usage: node public/dev/ui-smoke.mjs --bridge http://127.0.0.1:7876 --pin 112233',
      '',
      'Options: --out <dir>  --chrome <path>  --keep-profile',
      '',
      'Screenshots written: optimized-pair.png, optimized-main.png,',
      '                     optimized-sidebar.png, optimized-quick-actions.png,',
      '                     optimized-apk.png, optimized-sidebar-guard.png',
    ].join('\n'),
  );
  process.exit(0);
}

const bridge = String(args.bridge).replace(/\/+$/, '');
const outputDir = resolve(args.out);
const screenshots = [];
const report = {
  startedAt: new Date().toISOString(),
  bridge,
  chrome: '',
  viewport: '390x844 @3x mobile',
  steps: results,
  screenshots,
  quickActionSelectors: null,
  quickActionProof: null,
  sidebarProof: null,
  apkMode: null,
  consoleErrors: [],
  pass: false,
};
let chromePath = '';
let profileDir = '';
let logFile = '';
let chromeProcess = null;
let client = null;

function screenshotPath(name) {
  return join(outputDir, name);
}

async function capture(clientRef, fileName) {
  const result = await clientRef.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const path = screenshotPath(fileName);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  screenshots.push(path);
  console.log('       screenshot -> ' + path);
  return path;
}

async function evaluate(clientRef, expression) {
  const result = await clientRef.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(
      'page evaluation failed: ' +
        ((details.exception && (details.exception.description || details.exception.value)) || details.text || 'unknown'),
    );
  }
  return result ? result.result && result.result.value : undefined;
}

async function waitFor(clientRef, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(clientRef, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + (label || expression) + (lastError ? ' (' + lastError.message + ')' : ''));
}

async function navigate(clientRef, url) {
  await clientRef.send('Page.navigate', { url });
  await waitFor(clientRef, 'document.readyState === "complete"', 20000, 'page load');
  await sleep(350);
}

const SHELL_STATUS = 'window.__DSH_MOBILE__ ? window.__DSH_MOBILE__.getStatus() : null';
const FRAME_DOC = 'document.getElementById("guiFrame").contentDocument';

/** Dismiss the DSH first-run / welcome dialog if one is in the way. */
async function dismissGuiOverlays(clientRef) {
  const dismissed = await evaluate(
    clientRef,
    `(() => {
      try {
        const doc = ${FRAME_DOC};
        if (!doc) return 0;
        const patterns = /关闭|取消|跳过|知道了|开始使用|继续|关闭对话|close|cancel|skip|got it|dismiss|continue|start|ok/i;
        const buttons = [...doc.querySelectorAll('button, [role="button"]')];
        let clicked = 0;
        for (const button of buttons) {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '')).trim();
          if (!label || !patterns.test(label)) continue;
          if (button.disabled) continue;
          const rect = button.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          button.click();
          clicked += 1;
          if (clicked >= 1) break;
        }
        return clicked;
      } catch (_) { return -1; }
    })()`,
  );
  return dismissed;
}

async function run() {
  chromePath = findChrome(args.chrome);
  report.chrome = chromePath;
  console.log('DSH Mobile UI smoke test');
  console.log('  chrome :', chromePath);
  console.log('  bridge :', bridge);
  console.log('  out    :', outputDir);
  console.log('');
  mkdirSync(outputDir, { recursive: true });

  profileDir = mkdtempSync(join(tmpdir(), 'dsh-ui-smoke-'));
  logFile = join(profileDir, 'chrome.log');
  const logFd = openSync(logFile, 'w');
  const cdpPort = await findFreePort();
  console.log('  chrome headless, CDP port', cdpPort);
  console.log('');

  chromeProcess = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=' + cdpPort,
      '--user-data-dir=' + profileDir,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=390,844',
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] },
  );
  closeSync(logFd);

  let version = null;
  for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
    await sleep(300);
    version = await fetchJson('http://127.0.0.1:' + cdpPort + '/json/version');
  }
  if (!version) {
    let logTail = '';
    try {
      logTail = readFileSync(logFile, 'utf8').slice(-2000);
    } catch (_) {
      /* ignore */
    }
    throw new Error('headless Chrome CDP did not start. Last log:\n' + logTail);
  }
  console.log('  browser:', version.Browser);
  console.log('');

  const targets = (await fetchJson('http://127.0.0.1:' + cdpPort + '/json/list')) || [];
  const pageTarget = targets.find((target) => target.type === 'page') || targets[0];
  expect(pageTarget && pageTarget.webSocketDebuggerUrl, 'no debuggable page target');
  client = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await client.connect();

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await client.send('Emulation.setLocaleOverride', { locale: 'zh-CN' }).catch(() => {});
  const browserUa =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  await client.send('Emulation.setUserAgentOverride', {
    userAgent: browserUa,
    acceptLanguage: 'zh-CN,zh;q=0.9',
    platform: 'Linux armv8l',
  });

  /* ---------------- 1. pairing view (browser mode) ---------------- */
  await step('browser: pairing view renders at 390x844', async () => {
    await navigate(client, bridge + '/m/');
    const state = await waitFor(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        const pairing = document.getElementById('pairingView');
        const cells = document.querySelectorAll('.pin-cell');
        const keys = document.querySelectorAll('#keypad [data-key]');
        return status && pairing && !pairing.hidden && cells.length === 6 && keys.length === 11
          ? { screen: status.screen, appMode: status.appMode, cells: cells.length, keys: keys.length, title: document.title }
          : null;
      })()`,
      15000,
      'pairing view',
    );
    await expect(state.cells === 6, 'expected 6 PIN cells, got ' + state.cells);
    await expect(state.keys === 11, 'expected 11 numeric keypad keys, got ' + state.keys);
    await expect(state.appMode === false, 'browser mode must not be APK mode');
    await expect(state.screen === 'pair', 'expected the pair screen, got ' + state.screen);
    await expect(state.title === 'DSH Mobile', 'unexpected title: ' + state.title);
    const chrome = await evaluate(
      client,
      `(() => {
        const capsule = document.getElementById('capsule');
        const apkLink = document.getElementById('pairApk');
        const card = document.querySelector('.pair-card');
        return {
          capsuleOpacity: Number(getComputedStyle(capsule).opacity),
          apkLinkText: apkLink ? apkLink.textContent.trim() : '',
          cardHeight: card ? card.getBoundingClientRect().height : 0,
          dockVisible: getComputedStyle(document.getElementById('dock')).opacity,
        };
      })()`,
    );
    await expect(chrome.capsuleOpacity < 0.05, 'capsule must be hidden on the pairing screen');
    await expect(chrome.apkLinkText.includes('下载安卓 App'), 'pairing page should offer the APK download entry');
    await expect(Number(chrome.dockVisible) < 0.05, 'dock must be hidden on the pairing screen');
    await capture(client, 'optimized-pair.png');
    return {
      extra: {
        screen: state.screen,
        pinCells: state.cells,
        keypadKeys: state.keys,
        apkEntry: chrome.apkLinkText,
      },
    };
  });

  /* ---------------- 2. pair through the keypad, load the real GUI ---------------- */
  await step('browser: keypad pairing -> real DSH GUI + glass Dock', async () => {
    await evaluate(
      client,
      `(() => {
        const pin = ${JSON.stringify(String(args.pin))};
        for (const digit of pin) {
          const key = document.querySelector('#keypad [data-key="' + digit + '"]');
          if (key) key.click();
        }
        return true;
      })()`,
    );
    const state = await waitFor(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        if (!status || status.screen !== 'chat' || !status.paired || !status.frameLoaded) return null;
        const doc = ${FRAME_DOC};
        if (!doc || !doc.body) return null;
        const text = (doc.body.innerText || '').trim();
        return text.length > 20 ? status : null;
      })()`,
      35000,
      'paired chat screen with GUI content',
    );
    // dismiss first-run overlays a few times (they can stack)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const clicked = await dismissGuiOverlays(client);
      if (!clicked || clicked < 0) break;
      await sleep(700);
    }
    await sleep(1200);
    const injected = await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        const style = doc && doc.getElementById('dsh-mobile-adaptive-style');
        const dock = document.getElementById('dock');
        const capsule = document.getElementById('capsule');
        return style ? {
          hasStyle: true,
          hasMobileClass: doc.documentElement.classList.contains('dsh-mobile'),
          has100dvh: style.textContent.includes('100dvh'),
          hasSafeArea: style.textContent.includes('env(safe-area-inset-bottom'),
          hasShellHooks: style.textContent.includes('[data-shell-bottom]'),
          hasScaleVar: style.textContent.includes('--dsh-mobile-app-top'),
          guiTitle: doc.title,
          dockOpacity: Number(getComputedStyle(dock).opacity),
          capsuleOpacity: Number(getComputedStyle(capsule).opacity),
        } : { hasStyle: false };
      })()`,
    );
    await expect(injected.hasStyle, 'adaptive <style> was not injected into the GUI iframe');
    await expect(injected.hasMobileClass, 'dsh-mobile class missing on iframe html');
    await expect(injected.has100dvh, 'injected css missing 100dvh');
    await expect(injected.hasSafeArea, 'injected css missing safe-area variables');
    await expect(injected.hasShellHooks, 'injected css missing [data-shell-bottom] hook');
    await expect(injected.hasScaleVar, 'injected css missing the DshApp inset css vars');
    await expect(injected.dockOpacity > 0.5, 'glass Dock must be visible on the chat screen');
    await expect(injected.capsuleOpacity > 0.5, 'status capsule must be visible after loading the GUI');
    const proof = await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        return {
          title: doc.title,
          bodyTextLength: (doc.body.innerText || '').length,
          hasSidebarCollapsed: !!doc.querySelector('[data-sidebar-collapsed]'),
          hasShellBottom: !!doc.querySelector('[data-shell-bottom]'),
          hasOverlay: !!doc.querySelector('[data-shell-overlay]'),
        };
      })()`,
    );
    await expect(proof.hasSidebarCollapsed, 'expected the auto-collapsed sidebar rail at 390px');
    await expect(proof.hasShellBottom, 'expected the [data-shell-bottom] composer seat');
    await capture(client, 'optimized-main.png');
    return {
      extra: {
        guiTitle: injected.guiTitle,
        bodyTextLength: proof.bodyTextLength,
        collapsedRail: proof.hasSidebarCollapsed,
        dockVisible: true,
      },
    };
  });

  /* ---------------- 3. v0.3.2 sidebar UX (no rail, workspace-only sidebar) ---------------- */
  await step('dock 会话: hidden rail -> workspace-only real sidebar -> full width', async () => {
    const quick = await waitFor(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        if (!status) return null;
        return status.quickActions.sidebar === true && status.quickActions.newSession === true
          ? { quickActions: status.quickActions }
          : null;
      })()`,
      12000,
      'dock quick-action availability',
    );

    // -- 1) collapsed main screen: no rail, no empty column, content full width
    const collapsed = await waitFor(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        const frame = doc.querySelector('[data-sidebar-collapsed="true"]');
        if (!frame) return null;
        const first = frame.children[0] || null;
        const firstStyle = first ? getComputedStyle(first) : null;
        const firstRect = first ? first.getBoundingClientRect() : null;
        const center = frame.children[1] ? frame.children[1].getBoundingClientRect() : null;
        return {
          grid: getComputedStyle(frame).gridTemplateColumns,
          firstVisibility: firstStyle ? firstStyle.visibility : null,
          firstWidth: firstRect ? firstRect.width : null,
          centerLeft: center ? center.left : null,
          centerWidth: center ? center.width : null,
          viewportWidth: window.innerWidth,
          dockActive: document.querySelector('.dock-btn[data-dock="sessions"]').classList.contains('is-active'),
          drawerOpen: document.getElementById('drawer').classList.contains('is-open'),
        };
      })()`,
      10000,
      'collapsed sidebar layout',
    );
    await expect(
      collapsed.firstVisibility === 'hidden',
      'collapsed rail must be visibility:hidden (not display:none), got ' + collapsed.firstVisibility,
    );
    await expect(collapsed.firstWidth <= 1, 'collapsed rail must consume 0px, got ' + collapsed.firstWidth);
    await expect(
      String(collapsed.grid).startsWith('0px'),
      'collapsed sidebar grid column must be 0px, got ' + collapsed.grid,
    );
    await expect(collapsed.centerLeft <= 1, 'main content must start at x=0, got ' + collapsed.centerLeft);
    await expect(
      collapsed.centerWidth >= collapsed.viewportWidth - 2,
      'main content must be full width, got ' + collapsed.centerWidth + '/' + collapsed.viewportWidth,
    );
    await expect(collapsed.dockActive === false, 'dock 会话 must not look selected while collapsed');
    await expect(collapsed.drawerOpen === false, 'shell drawer must not open on the main screen');

    // -- 2) tap Dock 会话 -> real GUI sidebar expands, workspace content only
    await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"sessions\\"]").click()');
    const expanded = await waitFor(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        if (doc.querySelector('[data-sidebar-collapsed]')) return null;
        const toggle = doc.querySelector('button[aria-label="收起侧边栏"]') || doc.querySelector('button[aria-label="Collapse sidebar"]');
        if (!toggle) return null;
        const anchor = doc.querySelector('[data-shell-bottom]') || doc.querySelector('[data-shell-overlay]');
        const frame = anchor && anchor.parentElement;
        const sidebar = frame && frame.children[0] ? frame.children[0] : null;
        const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
        if (!sidebarRect || sidebarRect.width < 120) return null;
        const guards = [
          '[class*="brand"]',
          '[class*="newSession"]',
          '[class*="panelRow"]',
          '[aria-label="插件"]',
          '[aria-label="自动化任务"]',
          '[aria-label="账号菜单"]',
        ];
        let chromeTotal = 0;
        let chromeHidden = 0;
        for (const selector of guards) {
          for (const element of doc.querySelectorAll(selector)) {
            chromeTotal += 1;
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) chromeHidden += 1;
          }
        }
        const workspaceNodes = [...doc.querySelectorAll('[class*="workspace"]')];
        const workspaceVisible = workspaceNodes.some((element) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0;
        });
        const workspaceText = workspaceNodes
          .map((element) => element.innerText || '')
          .join(' ')
          .replace(/\\s+/g, ' ')
          .slice(0, 300);
        const sidebarText = sidebar ? (sidebar.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : '';
        const bodyText = ((doc.body && doc.body.innerText) || '').replace(/\\s+/g, ' ');
        const emptyWorkspace = /(无法创建默认工作区|暂无工作区|选择一个工作区|选择工作区开始|请选择工作区)/.test(bodyText);
        return {
          sidebarWidth: sidebarRect.width,
          sidebarText,
          workspaceText,
          chromeTotal,
          chromeHidden,
          workspaceVisible,
          emptyWorkspace,
          dockActive: document.querySelector('.dock-btn[data-dock="sessions"]').classList.contains('is-active'),
          drawerOpen: document.getElementById('drawer').classList.contains('is-open'),
        };
      })()`,
      8000,
      'expanded workspace-only sidebar',
    );
    await expect(expanded.sidebarWidth > 120, 'expanded sidebar should be visible, got width ' + expanded.sidebarWidth);
    await expect(expanded.chromeTotal > 0, 'expected brand/new-session/panel chrome inside the real sidebar');
    await expect(
      expanded.chromeHidden === expanded.chromeTotal,
      'expanded sidebar must hide non-workspace chrome, ' +
        expanded.chromeHidden +
        '/' +
        expanded.chromeTotal +
        ' hidden',
    );
    // In the empty-workspace isolated DSH the only `[class*="workspace"]` node
    // is the composer chooser that the guard correctly hides, so fall back to
    // the empty-state state + sidebar 工作区 text. Live GUIs still require a
    // visible workspace node.
    await expect(
      expanded.workspaceVisible || expanded.emptyWorkspace || /工作区|Workspace/i.test(expanded.sidebarText),
      'workspace content must stay visible in the expanded sidebar: ' +
        JSON.stringify({
          visible: expanded.workspaceVisible,
          empty: expanded.emptyWorkspace,
          text: expanded.sidebarText.slice(0, 80),
        }),
    );
    await expect(
      /工作区|Workspace/i.test(expanded.workspaceText) || /工作区|Workspace/i.test(expanded.sidebarText),
      'sidebar should show the workspace area, got: ' +
        (expanded.workspaceText || expanded.sidebarText).slice(0, 80),
    );
    await expect(
      !/(插件|自动化任务|账号菜单)/.test(expanded.sidebarText),
      'hidden panel rows leaked into the sidebar text: ' + expanded.sidebarText.slice(0, 120),
    );
    await expect(expanded.dockActive === true, 'dock 会话 should look selected while the sidebar is open');
    await expect(expanded.drawerOpen === false, 'shell drawer must not open when the real toggle works');
    await capture(client, 'optimized-sidebar.png');

    // -- 3) tap Dock 会话 again -> sidebar closes, full width restored
    await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"sessions\\"]").click()');
    const collapsedAgain = await waitFor(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        const frame = doc.querySelector('[data-sidebar-collapsed="true"]');
        if (!frame) return null;
        const first = frame.children[0] || null;
        const firstStyle = first ? getComputedStyle(first) : null;
        const firstRect = first ? first.getBoundingClientRect() : null;
        const center = frame.children[1] ? frame.children[1].getBoundingClientRect() : null;
        if (!center || center.width < window.innerWidth - 2) return null;
        return {
          firstVisibility: firstStyle ? firstStyle.visibility : null,
          firstWidth: firstRect ? firstRect.width : null,
          centerLeft: center.left,
          dockActive: document.querySelector('.dock-btn[data-dock="sessions"]').classList.contains('is-active'),
          drawerOpen: document.getElementById('drawer').classList.contains('is-open'),
        };
      })()`,
      8000,
      'collapsed sidebar restored',
    );
    await expect(collapsedAgain.firstVisibility === 'hidden', 'rail must be hidden again after closing');
    await expect(collapsedAgain.firstWidth <= 1, 'rail must be 0px again after closing');
    await expect(collapsedAgain.centerLeft <= 1, 'main content must return to x=0, got ' + collapsedAgain.centerLeft);
    await expect(collapsedAgain.dockActive === false, 'dock 会话 must deselect after closing');
    await expect(collapsedAgain.drawerOpen === false, 'shell drawer must stay unused');

    // -- 4) other Dock actions unchanged: 更多 -> quick sheet, 新建 -> real GUI button
    await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"more\\"]").click()');
    await waitFor(client, 'document.getElementById("quickSheet").classList.contains("is-open")', 5000, 'quick sheet open');
    const sheet = await evaluate(
      client,
      `(() => {
        const actions = [...document.querySelectorAll('#quickSheet [data-quick]')];
        return {
          count: actions.length,
          hasDiag: !!document.getElementById('diagBtn'),
        };
      })()`,
    );
    await expect(sheet.count >= 6, 'quick sheet should expose at least 6 actions, got ' + sheet.count);
    await expect(sheet.hasDiag, 'diagnostics action (#diagBtn) missing from the quick sheet');
    await capture(client, 'optimized-quick-actions.png');
    await evaluate(client, 'document.getElementById("scrim").click()');
    await waitFor(client, '!document.getElementById("quickSheet").classList.contains("is-open")', 5000, 'quick sheet closed');
    await sleep(300);

    await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"new\\"]").click()');
    await waitFor(client, 'document.getElementById("appToast").classList.contains("is-visible")', 5000, 'dock new-session toast');
    const toast = await evaluate(client, 'document.getElementById("appToast").textContent.trim()');
    await expect(toast.includes('已新建会话'), 'Dock 新建 should trigger the real GUI button, toast=' + toast);
    await sleep(900);

    report.sidebarProof = { quickActions: quick.quickActions, collapsed, expanded, collapsedAgain, sheet, newSessionToast: toast };
    return {
      extra: {
        railHidden: collapsed.firstVisibility,
        railWidth: Math.round(collapsed.firstWidth),
        mainLeft: Math.round(collapsed.centerLeft),
        mainWidth: Math.round(collapsed.centerWidth),
        expandedSidebarWidth: Math.round(expanded.sidebarWidth),
        hiddenSidebarChrome: expanded.chromeHidden + '/' + expanded.chromeTotal,
        workspaceVisible: expanded.workspaceVisible,
        sheetActions: sheet.count,
        newSessionToast: toast,
      },
    };
  });

  /* ---------------- 4. v0.3.6 desktop-dialog guard (real GUI) ---------------- */
  await step('guard: add-workspace dialog entries hidden, switcher still usable', async () => {
    // Open the real GUI sidebar via Dock 会话 — but tolerate a previous step
    // having left it expanded (avoid a click that would close it instead).
    const sidebarAlreadyExpanded = await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        return (
          !doc.querySelector('[data-sidebar-collapsed]') &&
          !!(doc.querySelector('button[aria-label="收起侧边栏"]') || doc.querySelector('button[aria-label="Collapse sidebar"]'))
        );
      })()`,
    );
    if (!sidebarAlreadyExpanded) {
      await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"sessions\\"]").click()');
    }
    await waitFor(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        const toggle = doc.querySelector('button[aria-label="收起侧边栏"]') || doc.querySelector('button[aria-label="Collapse sidebar"]');
        return toggle ? true : null;
      })()`,
      8000,
      'sidebar expanded for guard step',
    );

    // find the workspace switcher trigger (must stay usable / not be blocked)
    const trigger = await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        const buttons = [...doc.querySelectorAll('button, [role="button"]')];
        const found = buttons.find((button) => {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).trim();
          return /选择工作区/.test(label) && !/添加工作区|打开工作区|新建工作区/.test(label);
        });
        if (!found) return { found: false };
        return {
          found: true,
          text: (found.innerText || '').trim().slice(0, 30),
          display: getComputedStyle(found).display,
          blocked: found.getAttribute('data-dsh-mobile-blocked'),
        };
      })()`,
    );
    await expect(trigger && trigger.found, '选择工作区 trigger not found in the real GUI sidebar');

    // Detect environment: no-workspace empty state (isolated DSH) vs normal
    // workspaces (live desktop GUI). The empty-state chooser also opens the
    // desktop native directory picker, so it must be guarded too.
    const env = await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        const bodyText = ((doc.body && doc.body.innerText) || '').replace(/\\s+/g, ' ');
        const emptyWorkspace = /(无法创建默认工作区|暂无工作区|选择一个工作区|选择工作区开始|请选择工作区|没有工作区)/.test(bodyText);
        return { emptyWorkspace, bodyPreview: bodyText.slice(0, 180) };
      })()`,
    );
    await expect(env !== null, 'could not read the GUI workspace state');

    if (env.emptyWorkspace) {
      // Empty-state protection: the chooser cannot open a workspace dropdown,
      // guard must mark/hide it and the click must be blocked with a toast.
      const emptyState = await waitFor(
        client,
        `(() => {
          const doc = ${FRAME_DOC};
          if (!doc) return null;
          const chooser = [...doc.querySelectorAll('button, [role="button"]')].find((button) => {
            const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).trim();
            return /选择工作区/.test(label) && !/添加工作区|打开工作区|新建工作区/.test(label);
          });
          const addSidebar = doc.querySelector('[aria-label="添加工作区"]');
          if (!chooser) return null;
          const chooserBlocked = chooser.getAttribute('data-dsh-mobile-blocked') === '1';
          const chooserDisplay = getComputedStyle(chooser).display;
          const addHidden =
            !!addSidebar &&
            (getComputedStyle(addSidebar).display === 'none' ||
              addSidebar.getAttribute('data-dsh-mobile-blocked') === '1');
          if (!addHidden || !(chooserBlocked || chooserDisplay === 'none')) return null;
          return {
            chooserDisplay,
            chooserBlocked,
            addHidden,
            menuCount: doc.querySelectorAll('[role="menuitem"]').length,
          };
        })()`,
        8000,
        'empty-workspace chooser guarded',
      );
      await expect(emptyState.menuCount === 0, 'empty workspace must not open a workspace dropdown');
      await expect(emptyState.addHidden, '添加工作区 entry must stay hidden in the empty state');

      await evaluate(
        client,
        `(() => {
          const doc = ${FRAME_DOC};
          const chooser = [...doc.querySelectorAll('button, [role="button"]')].find((button) => {
            const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).trim();
            return /选择工作区/.test(label) && !/添加工作区|打开工作区|新建工作区/.test(label);
          });
          if (!chooser) return false;
          window.__dshGuardHit = 0;
          chooser.addEventListener('click', () => { window.__dshGuardHit += 1; }, false);
          chooser.click();
          return true;
        })()`,
      );
      await waitFor(
        client,
        `(() => {
          const status = ${SHELL_STATUS};
          const toast = document.getElementById('appToast');
          const text = toast ? toast.textContent : '';
          return status && status.blockedAction && /手机端暂不支持/.test(text) ? true : null;
        })()`,
        5000,
        'empty-workspace blocked-action toast',
      );
      const emptyGuard = await evaluate(
        client,
        `(() => {
          const status = ${SHELL_STATUS};
          return {
            hit: window.__dshGuardHit || 0,
            toast: document.getElementById('appToast').textContent.trim(),
            blockedAction: status ? status.blockedAction : null,
          };
        })()`,
      );
      await expect(emptyGuard.hit === 0, 'empty-state chooser click must be blocked (hit=' + emptyGuard.hit + ')');
      await expect(emptyGuard.toast.includes('手机端暂不支持'), 'empty-state toast text: ' + emptyGuard.toast);
      await expect(
        String(emptyGuard.blockedAction || '').includes('选择工作区'),
        'empty-state blocked action recorded: ' + emptyGuard.blockedAction,
      );
      await capture(client, 'optimized-sidebar-guard.png');
      await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"sessions\\"]").click()');
      await waitFor(
        client,
        `(() => {
          const doc = ${FRAME_DOC};
          if (!doc) return null;
          return doc.querySelector('[data-sidebar-collapsed="true"]') ? true : null;
        })()`,
        8000,
        'sidebar collapsed after empty-state guard step',
      );
      return {
        extra: {
          mode: 'empty-workspace',
          chooserDisplay: emptyState.chooserDisplay,
          chooserBlocked: emptyState.chooserBlocked,
          guardHit: emptyGuard.hit,
          blockedAction: emptyGuard.blockedAction,
          toast: emptyGuard.toast,
          bodyPreview: env.bodyPreview,
        },
      };
    }

    // ---- workspace mode: the chooser opens a normal dropdown ----
    await expect(trigger.display !== 'none', '选择工作区 trigger must stay visible, got display ' + trigger.display);
    await expect(trigger.blocked === null, '选择工作区 trigger must NOT be marked blocked');

    // open the dropdown menu -> only the desktop-dialog item is hidden
    await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        const buttons = [...doc.querySelectorAll('button, [role="button"]')];
        const found = buttons.find((button) => {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).trim();
          return /选择工作区/.test(label) && !/添加工作区|打开工作区|新建工作区/.test(label);
        });
        if (found) found.click();
        return !!found;
      })()`,
    );
    const menu = await waitFor(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        const addSidebar = doc.querySelector('[aria-label="添加工作区"]');
        const items = [...doc.querySelectorAll('[role="menuitem"]')];
        if (!items.length) return null;
        const addItem = items.find((item) => /添加工作区/.test(item.innerText || ''));
        const otherItem = items.find((item) => !/添加工作区/.test(item.innerText || ''));
        const addHidden =
          !!addSidebar &&
          getComputedStyle(addSidebar).display === 'none' &&
          (!addItem || getComputedStyle(addItem).display === 'none' || addItem.getAttribute('data-dsh-mobile-blocked') === '1');
        if (!addHidden) return null;
        return {
          addSidebarFound: !!addSidebar,
          addSidebarDisplay: addSidebar ? getComputedStyle(addSidebar).display : 'missing',
          addSidebarBlocked: addSidebar ? addSidebar.getAttribute('data-dsh-mobile-blocked') : null,
          menuCount: items.length,
          addItem: addItem
            ? {
                display: getComputedStyle(addItem).display,
                blocked: addItem.getAttribute('data-dsh-mobile-blocked'),
                hidden: addItem.getAttribute('aria-hidden'),
              }
            : null,
          otherItem: otherItem
            ? { display: getComputedStyle(otherItem).display, blocked: otherItem.getAttribute('data-dsh-mobile-blocked') }
            : null,
        };
      })()`,
      8000,
      '选择工作区 menu with guarded items',
    );
    await expect(menu.addSidebarFound, 'real GUI should render the 添加工作区 sidebar button');
    await expect(menu.addSidebarDisplay === 'none', '添加工作区 sidebar entry must be display:none, got ' + menu.addSidebarDisplay);
    await expect(menu.menuCount >= 1, '选择工作区 menu should open with existing workspaces');
    await expect(
      menu.addItem && (menu.addItem.display === 'none' || menu.addItem.blocked === '1'),
      '添加工作区… menu item must be hidden by the guard: ' + JSON.stringify(menu.addItem),
    );
    await expect(
      menu.otherItem && menu.otherItem.display !== 'none' && menu.otherItem.blocked === null,
      'existing workspace switch items must stay visible',
    );

    // capture-click fallback: blocked entry never reaches the GUI handler + shell toast via postMessage
    await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        const target = doc.querySelector('[aria-label="添加工作区"]');
        if (!target) return false;
        window.__dshGuardHit = 0;
        target.addEventListener('click', () => { window.__dshGuardHit += 1; }, false);
        target.click();
        return true;
      })()`,
    );
    await waitFor(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        const toast = document.getElementById('appToast');
        const text = toast ? toast.textContent : '';
        return status && status.blockedAction && /手机端暂不支持/.test(text) ? true : null;
      })()`,
      5000,
      'blocked-action shell toast',
    );
    const guard = await evaluate(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        return {
          hit: window.__dshGuardHit || 0,
          toast: document.getElementById('appToast').textContent.trim(),
          blockedAction: status ? status.blockedAction : null,
        };
      })()`,
    );
    await expect(guard.hit === 0, 'blocked click must not reach the real GUI handler (hit=' + guard.hit + ')');
    await expect(guard.toast.includes('手机端暂不支持'), 'shell toast text: ' + guard.toast);
    await expect(String(guard.blockedAction || '').includes('添加工作区'), 'blocked action recorded: ' + guard.blockedAction);
    await capture(client, 'optimized-sidebar-guard.png');

    // close the dropdown, then restore the full-width main screen
    await evaluate(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        const buttons = [...doc.querySelectorAll('button, [role="button"]')];
        const found = buttons.find((button) => {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).trim();
          return /选择工作区/.test(label) && !/添加工作区|打开工作区|新建工作区/.test(label);
        });
        if (found) found.click();
        return !!found;
      })()`,
    );
    await sleep(400);
    await evaluate(client, 'document.querySelector(".dock-btn[data-dock=\\"sessions\\"]").click()');
    await waitFor(
      client,
      `(() => {
        const doc = ${FRAME_DOC};
        if (!doc) return null;
        return doc.querySelector('[data-sidebar-collapsed="true"]') ? true : null;
      })()`,
      8000,
      'sidebar collapsed after guard step',
    );

    return {
      extra: {
        trigger: trigger.text,
        sidebarEntryHidden: menu.addSidebarDisplay,
        menuItems: menu.menuCount,
        guardHit: guard.hit,
        blockedAction: guard.blockedAction,
        toast: guard.toast,
        workspaceItemsIntact: true,
      },
    };
  });

  /* ---------------- 5. APK full-screen mode ---------------- */
  await step('apk mode: UA suffix + ?app=1 gives full-screen native layout', async () => {
    const apkUa = browserUa + ' DSHMobileApp/0.1';
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: apkUa,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Linux armv8l',
    });
    await navigate(client, bridge + '/m/?app=1');
    const apkState = await waitFor(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        if (!status) return null;
        const root = document.documentElement;
        if (!root.classList.contains('dsh-app') && !status.appMode) return null;
        const app = document.getElementById('app');
        const capsule = document.getElementById('capsule');
        const handle = document.getElementById('appHandle');
        const dock = document.getElementById('dock');
        const frame = document.getElementById('guiFrame');
        const frameHost = document.getElementById('frameHost');
        const handleStyle = handle ? getComputedStyle(handle) : null;
        const guiDoc = frame ? frame.contentDocument : null;
        const sidebarFrame = guiDoc ? guiDoc.querySelector('[data-sidebar-collapsed="true"]') : null;
        const rail = sidebarFrame ? sidebarFrame.children[0] : null;
        if (!rail) return null;
        const railStyle = getComputedStyle(rail);
        const railRect = rail.getBoundingClientRect();
        return {
          appMode: status.appMode,
          screen: status.screen,
          paired: status.paired,
          frameLoaded: status.frameLoaded,
          mode: app ? app.dataset.mode : null,
          bars: status.bars,
          capsuleOpacity: Number(getComputedStyle(capsule).opacity),
          handleDisplay: handleStyle ? handleStyle.display : 'none',
          handlePosition: handleStyle ? handleStyle.position : 'static',
          handleHeight: handle ? handle.getBoundingClientRect().height : -1,
          handleTop: handle ? handle.getBoundingClientRect().top : -1,
          iframeTop: frame ? frame.getBoundingClientRect().top : -1,
          iframeHeight: frame ? frame.getBoundingClientRect().height : -1,
          iframeBottom: frame ? frame.getBoundingClientRect().bottom : -1,
          frameHostTop: frameHost ? frameHost.getBoundingClientRect().top : -1,
          viewportHeight: window.innerHeight,
          dockOpacity: Number(getComputedStyle(dock).opacity),
          topInset: getComputedStyle(root).getPropertyValue('--apk-top-inset').trim(),
          apkClass: root.classList.contains('dsh-app'),
          railHidden: railStyle.visibility,
          railWidth: railRect.width,
        };
      })()`,
      25000,
      'APK full-screen mode',
    );
    await expect(apkState.appMode === true, 'APK mode not detected');
    await expect(apkState.mode === 'apk', 'app data-mode should be "apk", got ' + apkState.mode);
    await expect(apkState.apkClass === true, 'html.dsh-app class missing');
    await expect(apkState.bars === 'hidden', 'APK mode should start with the mini capsule hidden');
    await expect(apkState.screen === 'chat', 'APK mode should reuse the paired cookie and show the GUI, got ' + apkState.screen);
    // no top bar: capsule hidden and the GUI iframe starts at y=0
    await expect(apkState.capsuleOpacity < 0.05, 'APK capsule should be invisible while hidden, opacity=' + apkState.capsuleOpacity);
    await expect(apkState.iframeTop < 2, 'GUI iframe must start at y=0 in APK mode, got ' + apkState.iframeTop);
    await expect(apkState.frameHostTop < 2, 'frame host must start at y=0 in APK mode, got ' + apkState.frameHostTop);
    // dock floats over the GUI; the iframe reserves only the dock strip
    await expect(apkState.dockOpacity > 0.5, 'glass Dock must stay visible in APK mode');
    await expect(apkState.railHidden === 'hidden', 'APK mode must hide the collapsed sidebar rail, got ' + apkState.railHidden);
    await expect(apkState.railWidth <= 1, 'APK rail must consume 0px, got ' + apkState.railWidth);
    await expect(
      apkState.iframeHeight >= apkState.viewportHeight - 160 && apkState.iframeBottom <= apkState.viewportHeight + 1,
      'APK iframe should fill the screen above the Dock, got ' +
        apkState.iframeHeight +
        ' / ' +
        apkState.viewportHeight,
    );
    // non-occupying recoverable entry
    await expect(apkState.handleDisplay !== 'none', 'APK recoverable handle should be present');
    await expect(apkState.handlePosition === 'absolute', 'APK handle must not occupy layout');
    await expect(apkState.handleHeight <= 24, 'APK handle must stay a tiny non-occupying strip, got ' + apkState.handleHeight);
    await expect(apkState.handleTop < 2, 'APK handle should sit on the top edge, got ' + apkState.handleTop);
    await expect(/^\d+px$/.test(apkState.topInset), 'expected a --apk-top-inset css var, got ' + apkState.topInset);
    await sleep(500);
    await capture(client, 'optimized-apk.png');
    // tapping the handle must reveal the floating mini capsule overlay
    await evaluate(client, 'document.getElementById("appHandle").click()');
    const revealed = await waitFor(
      client,
      `(() => {
        const status = ${SHELL_STATUS};
        const capsule = document.getElementById('capsule');
        if (!status || !capsule) return null;
        const opacity = Number(getComputedStyle(capsule).opacity);
        return status.bars === 'shown' && opacity > 0.5 ? { bars: status.bars, capsuleOpacity: opacity } : null;
      })()`,
      5000,
      'APK handle reveals the mini capsule',
    );
    await evaluate(client, 'window.__DSH_MOBILE__.hideBars()');
    await sleep(300);
    const hiddenAgain = await evaluate(client, 'window.__DSH_MOBILE__.getStatus().bars');
    await expect(hiddenAgain === 'hidden', 'APK mini capsule should collapse again after auto/reveal test');
    report.apkMode = { ...apkState, revealed };
    return {
      extra: {
        capsuleHiddenOpacity: Math.round(apkState.capsuleOpacity * 100) / 100,
        iframeTopPx: Math.round(apkState.iframeTop),
        iframeHeightPx: Math.round(apkState.iframeHeight),
        dockVisible: true,
        handleHeightPx: Math.round(apkState.handleHeight),
        topInset: apkState.topInset,
        reusesCookie: apkState.screen === 'chat',
        revealOnTap: true,
        revealedCapsuleOpacity: Math.round(revealed.capsuleOpacity * 100) / 100,
      },
    };
  });

  /* ---------------- 6. console hygiene ---------------- */
  await step('no console errors / uncaught exceptions', async () => {
    const errors = (client.consoleErrors || []).filter((entry) => !isBenignConsole(entry.text));
    report.consoleErrors = client.consoleErrors || [];
    report.benignConsoleErrors = (client.consoleErrors || []).length - errors.length;
    await expect(errors.length === 0, errors.map((entry) => entry.type + ': ' + entry.text).join('\n       ↳ '));
    return { extra: { benign: report.benignConsoleErrors } };
  });
}

/* ------------------------------------------------------------------ */
/* run + report + cleanup                                              */
/* ------------------------------------------------------------------ */

let fatal = null;
try {
  await run();
} catch (error) {
  fatal = error;
  record('harness', false, (error && error.message) || String(error));
} finally {
  try {
    if (client) {
      await client.send('Browser.close', {}, 3000).catch(() => {});
      client.close();
    }
  } catch (_) {
    /* ignore */
  }
  if (chromeProcess && chromeProcess.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(chromeProcess.pid)], { stdio: 'ignore' });
      } else {
        chromeProcess.kill('SIGKILL');
      }
    } catch (_) {
      try {
        chromeProcess.kill();
      } catch (__) {
        /* ignore */
      }
    }
  }
  await sleep(600);
  if (!args.keepProfile && profileDir) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (_) {
      /* Chrome may still hold files; harmless */
    }
  }
}

const failed = results.filter((result) => !result.ok);
const passed = results.length - failed.length;
report.finishedAt = new Date().toISOString();
report.durationMs = Date.now() - startedAt;
report.pass = failed.length === 0 && !fatal;
report.summary = { passed, failed, total: results.length };

console.log('');
console.log('='.repeat(72));
console.log(`RESULT: ${passed}/${results.length} UI checks passed${report.pass ? '' : ' (FAIL)'}`);
if (failed.length > 0) {
  console.log('Failures:');
  for (const failure of failed) console.log('  - ' + failure.name + ' — ' + failure.details);
}
if (screenshots.length > 0) {
  console.log('Screenshots:');
  for (const path of screenshots) console.log('  - ' + path);
}
try {
  writeFileSync(join(outputDir, 'ui-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log('Report: ' + join(outputDir, 'ui-smoke-report.json'));
} catch (error) {
  console.log('WARN: could not write report: ' + ((error && error.message) || error));
}

if (!report.pass) process.exitCode = 1;
