#!/usr/bin/env node
/**
 * DSH Mobile — local development mock server (dev-only, not used in production)
 * ============================================================================
 * Simulates the mobile-bridge plugin's HTTP surface so the phone shell in
 * ../index.html can be developed and smoke-tested without DSH or the plugin.
 *
 * Routes
 * ------
 *   GET  /m/ , /m/*        static files from public/ (path-traversal safe)
 *   GET  /m/api/state      { ok, paired, host, dshUrl:"/", pinRequired:true }
 *   POST /m/api/pair       body { code } -> 200 { ok:true, url, expiresInMs }
 *                                        -> 401 { ok:false, error:"bad-pin" }
 *                                        -> 429 { ok:false, error:"locked" }
 *   GET  /?token=...       mock DSH login: Set-Cookie + 303 Location: ./
 *   GET  /                 mock DSH Web GUI when authenticated, otherwise the
 *                          same plain-text 401 body the real DSH web server uses
 *   /__mock/*              dev-only controls (see below)
 *
 * Dev-only control routes
 * -----------------------
 *   GET  /__mock/pair      set the mock auth cookie and redirect to /m/
 *   POST /__mock/logout    clear the mock auth cookie
 *   GET  /__mock/reset     reset PIN attempt limiter + invalidate tokens
 *
 * Usage
 * -----
 *   node packages/dsh-plugin-mobile-bridge/public/dev/mock-server.mjs
 *   node ... --port 7862 --pin 123456 --paired
 *   MOCK_PORT=7862 MOCK_PIN=123456 MOCK_PAIRED=1 node ...
 *
 * Then open:  http://127.0.0.1:7862/m/     (default PIN 123456)
 *   - pair through the UI (hidden-iframe cookie handshake included), or
 *   - open http://127.0.0.1:7862/__mock/pair to jump straight into the GUI, or
 *   - start with --paired to make /m/api/state report paired immediately.
 *
 * Notes: listens on 127.0.0.1 only. Static files are read from the parent
 * directory (public/). Never expose this server to a network.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '..');
const AUTH_COOKIE = 'mock_dsh_auth';
const AUTH_TOKEN = randomBytes(18).toString('base64url');
const MAX_BODY_BYTES = 64 * 1024;
const ATTEMPT_LIMIT = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 30 * 1000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function now() {
  return Date.now();
}

function randomToken() {
  return randomBytes(18).toString('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...(extraHeaders || {}),
  });
  res.end(text);
}

async function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('bad-json'));
      }
    });
    req.on('error', reject);
  });
}

function requestHost(req, fallbackPort) {
  const host = req.headers.host;
  if (host && /^[a-zA-Z0-9.\-:[\]]+$/.test(host)) return host;
  return '127.0.0.1:' + fallbackPort;
}

/**
 * Resolve a /m/* URL path to a file below PUBLIC_ROOT.
 * Returns null for traversal attempts / missing files.
 */
function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // /m, /m/ -> index.html
  let relative = decoded.replace(/^\/m\/?/, '');
  if (relative === '') relative = 'index.html';
  if (relative.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  if (!relative.includes('.')) relative = 'index.html'; // SPA-ish fallback for /m/foo
  const target = resolve(PUBLIC_ROOT, normalize(relative));
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) return null;
  return target;
}

async function serveStatic(req, res, urlPath, log) {
  const filePath = resolveStaticPath(urlPath);
  if (!filePath) {
    sendText(res, 404, 'not found');
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': data.length,
      'x-mock-server': 'dsh-mobile-dev',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(res, 404, 'not found');
    } else {
      log('static error:', error && error.message);
      sendText(res, 500, 'internal error');
    }
  }
}

/* ------------------------------------------------------------------ */
/* mock DSH GUI + unauthenticated page                                 */
/* ------------------------------------------------------------------ */

const UNAUTH_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.\n';

function mockGuiHtml(port) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body { background: #151517; color: #e8e8ea; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; overflow: hidden; }
  #root { display: flex; flex-direction: column; }
  .mock-ribbon { position: fixed; right: 10px; bottom: 10px; z-index: 50; padding: 4px 8px; border-radius: 6px; background: rgba(34,211,238,.16); color: #67e8f9; font: 600 10px/1.4 ui-monospace, monospace; letter-spacing: .12em; pointer-events: none; }
  .titlebar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; border-bottom: 1px solid #26262b; background: #1a1a1e; }
  .titlebar .logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(140deg,#2563eb,#22d3ee); }
  .titlebar .name { font-size: 12.5px; font-weight: 600; color: #d4d4d8; }
  .titlebar .crumb { font-size: 11px; color: #8b8b93; }
  .titlebar .spacer { flex: 1; }
  .titlebar button { font: inherit; font-size: 11px; color: #c9c9cf; background: #26262b; border: 1px solid #34343a; border-radius: 7px; padding: 5px 9px; cursor: pointer; }
  .titlebar button:active { transform: scale(.97); }
  .layout { flex: 1; min-height: 0; display: flex; }
  .sidebar { width: 232px; flex: 0 0 auto; display: none; flex-direction: column; gap: 6px; padding: 12px 10px; border-right: 1px solid #26262b; background: #19191d; }
  .sidebar .new-chat { height: 34px; border-radius: 9px; border: 1px solid #34343a; background: #232328; color: #d4d4d8; font-size: 12px; }
  .sidebar .item { padding: 8px 10px; border-radius: 8px; font-size: 12px; color: #9a9aa2; }
  .sidebar .item.active { background: #26262b; color: #e8e8ea; }
  .sidebar .hint { font-size: 10.5px; color: #6d6d75; padding: 8px 10px; border-top: 1px solid #26262b; margin-top: auto; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 14px 8px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 86%; padding: 10px 12px; border-radius: 14px; font-size: 13.5px; line-height: 1.6; }
  .msg.user { align-self: flex-end; background: #1d4ed8; color: #fff; border-bottom-right-radius: 5px; }
  .msg.bot { align-self: flex-start; background: #202026; color: #e4e4e8; border: 1px solid #2c2c33; border-bottom-left-radius: 5px; }
  .msg .who { display: block; margin-bottom: 3px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: #8b8b93; }
  .composer { flex: 0 0 auto; padding: 8px 10px 12px; border-top: 1px solid #26262b; background: #17171b; }
  .composer .box { display: flex; align-items: flex-end; gap: 8px; padding: 8px; border: 1px solid #33333a; border-radius: 13px; background: #1e1e23; }
  .composer textarea { flex: 1; min-height: 22px; max-height: 96px; resize: none; border: 0; outline: none; background: transparent; color: #e8e8ea; font-family: inherit; font-size: 13px; line-height: 1.5; }
  .composer .send { flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 9px; background: linear-gradient(140deg,#2563eb,#0891b2); color: #fff; font-size: 15px; cursor: pointer; }
  @media (min-width: 640px) { .sidebar { display: flex; } }
</style>
</head>
<body data-ds-dark-theme>
<div id="root">
  <div class="titlebar">
    <span class="logo"></span>
    <span class="name">DeepSeek Harness</span>
    <span class="crumb">/ mock workspace</span>
    <span class="spacer"></span>
    <button id="logout">模拟登录失效</button>
  </div>
  <div class="layout">
    <div class="sidebar">
      <button class="new-chat">＋ 新建会话</button>
      <div class="item active">Mock 会话 · 移动端预览</div>
      <div class="item">历史会话 2</div>
      <div class="item">历史会话 3</div>
      <div class="hint">这是 mock-server 提供的假 GUI，用于测试 /m/ 壳的 iframe 嵌入与移动端适配 CSS 注入。</div>
    </div>
    <div class="main">
      <div class="messages" id="messages">
        <div class="msg user"><span class="who">你</span>在手机上能看到桌面会话吗？</div>
        <div class="msg bot"><span class="who">DSH</span>可以。这个页面是本地 mock，用来验证手机壳的 iframe、Cookie 握手和移动端适配。当前 iframe 视口就是手机屏幕。<br><br>测试项：<br>1. 无横向滚动<br>2. 输入框聚焦时 iOS 不缩放（注入 CSS 将字号提升到 16px）<br>3. 底部输入区不被 Home 指示条遮挡</div>
        <div class="msg user"><span class="who">你</span>收到，继续测试。</div>
        <div class="msg bot"><span class="who">DSH</span>好的。你可以点右上角「模拟登录失效」，观察手机壳是否检测到 401 页面并回到配对视图。</div>
      </div>
      <div class="composer">
        <div class="box">
          <textarea id="input" rows="1" placeholder="给 DSH 发消息…"></textarea>
          <button class="send" id="send" aria-label="发送">↑</button>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="mock-ribbon">MOCK · ${port}</div>
<script>
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  function add() {
    const text = input.value.trim();
    if (!text) return;
    const node = document.createElement('div');
    node.className = 'msg user';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = '你';
    node.appendChild(who);
    node.appendChild(document.createTextNode(text));
    messages.appendChild(node);
    input.value = '';
    messages.scrollTop = messages.scrollHeight;
  }
  send.addEventListener('click', add);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); add(); }
  });
  document.getElementById('logout').addEventListener('click', async () => {
    try { await fetch('/__mock/logout', { method: 'POST' }); } catch (_) {}
    location.reload();
  });
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* server factory                                                      */
/* ------------------------------------------------------------------ */

/**
 * Start the mock server.
 * @param {object} [options]
 * @param {number} [options.port=7862] 0 = OS assigned
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.pin='123456']
 * @param {boolean} [options.paired=false] make state/GUI report paired without a cookie
 * @param {(msg: string, ...rest: any[]) => void} [options.log]
 */
export async function startMockServer(options) {
  const opts = options || {};
  const requestedPort = opts.port === 0 ? 0 : Number(opts.port) || 7862;
  const host = opts.host || '127.0.0.1';
  const pin = String(opts.pin || process.env.MOCK_PIN || '123456');
  let forcePaired = opts.paired === true;
  const log = opts.log || ((message) => console.log('[mock-server] ' + message));

  /** @type {Map<string, {count: number, windowStart: number, lockedUntil: number}>} */
  const attempts = new Map();
  /** @type {Map<string, number>} token -> expiry epoch ms */
  const loginTokens = new Map();

  function attemptState(ip) {
    let entry = attempts.get(ip);
    if (!entry) {
      entry = { count: 0, windowStart: now(), lockedUntil: 0 };
      attempts.set(ip, entry);
    }
    if (entry.windowStart + ATTEMPT_WINDOW_MS < now()) {
      entry.count = 0;
      entry.windowStart = now();
    }
    return entry;
  }

  function isAuthenticated(req) {
    if (forcePaired) return true;
    const cookies = parseCookies(req.headers.cookie);
    const cookie = cookies[AUTH_COOKIE];
    return Boolean(cookie && safeEqual(cookie, AUTH_TOKEN));
  }

  const server = createServer(async (req, res) => {
    const started = now();
    const method = (req.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'));
    } catch (_) {
      sendText(res, 400, 'bad request');
      return;
    }
    const pathname = url.pathname;
    const hostHeader = requestHost(req, requestedPort);

    try {
      /* ---------- mock control routes (dev-only) ---------- */
      if (pathname === '/__mock/pair') {
        res.writeHead(303, {
          'set-cookie': `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
          location: '/m/',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      if (pathname === '/__mock/logout') {
        forcePaired = false;
        res.writeHead(200, {
          'set-cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true, paired: false }));
        return;
      }
      if (pathname === '/__mock/reset') {
        attempts.clear();
        loginTokens.clear();
        forcePaired = false;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/__mock/info') {
        sendJson(res, 200, {
          ok: true,
          pin,
          paired: isAuthenticated(req),
          forcePaired,
          urls: [`http://${hostHeader}/m/`],
          routes: ['/m/', '/m/api/state', '/m/api/pair', '/__mock/pair', '/__mock/logout', '/__mock/reset'],
        });
        return;
      }

      /* ---------- shell API ---------- */
      if (pathname === '/m/api/state') {
        const override = url.searchParams.get('paired');
        const paired = override === null ? isAuthenticated(req) : override !== '0';
        sendJson(res, 200, {
          ok: true,
          paired,
          host: `http://${hostHeader}`,
          dshUrl: '/',
          pinRequired: true,
        });
        return;
      }

      if (pathname === '/m/api/pair') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' });
          return;
        }
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        const entry = attemptState(ip);
        if (entry.lockedUntil > now()) {
          const retryAfter = Math.max(1, Math.ceil((entry.lockedUntil - now()) / 1000));
          sendJson(
            res,
            429,
            { ok: false, error: 'locked', retryAfter },
            { 'retry-after': String(retryAfter) },
          );
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error && error.message === 'body-too-large' ? 'body-too-large' : 'bad-json',
          });
          return;
        }
        const code = body && typeof body.code === 'string' ? body.code.trim() : '';
        if (!safeEqual(code, pin)) {
          entry.count += 1;
          if (entry.count >= ATTEMPT_LIMIT) {
            entry.lockedUntil = now() + LOCKOUT_MS;
            entry.count = 0;
            sendJson(
              res,
              429,
              { ok: false, error: 'locked', retryAfter: Math.ceil(LOCKOUT_MS / 1000) },
              { 'retry-after': String(Math.ceil(LOCKOUT_MS / 1000)) },
            );
            return;
          }
          sendJson(res, 401, { ok: false, error: 'bad-pin' });
          return;
        }
        // success: mint a one-shot mock login token (like DSH's launch token)
        entry.count = 0;
        entry.lockedUntil = 0;
        const token = randomToken();
        const expiresInMs = 10 * 60 * 1000;
        loginTokens.set(token, now() + expiresInMs);
        sendJson(res, 200, {
          ok: true,
          url: `http://${hostHeader}/?token=${encodeURIComponent(token)}`,
          expiresInMs,
        });
        return;
      }

      /* ---------- mock DSH login handshake ---------- */
      if (pathname === '/') {
        const token = url.searchParams.get('token');
        if (token) {
          const expiry = loginTokens.get(token);
          if (expiry && expiry > now()) {
            loginTokens.delete(token); // one-shot, like the DSH launch token
            res.writeHead(303, {
              'set-cookie': `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
              location: './',
              'cache-control': 'no-store',
            });
            res.end();
            return;
          }
          sendText(res, 401, UNAUTH_BODY);
          return;
        }
        if (isAuthenticated(req)) {
          const html = mockGuiHtml(requestedPort);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(html),
          });
          res.end(html);
          return;
        }
        sendText(res, 401, UNAUTH_BODY);
        return;
      }

      /* ---------- /m static shell ---------- */
      if (pathname === '/m' || pathname.startsWith('/m/')) {
        if (pathname === '/m') {
          res.writeHead(301, { location: '/m/', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
          return;
        }
        await serveStatic(req, res, pathname, log);
        return;
      }

      sendText(res, 404, 'not found');
    } catch (error) {
      log('unhandled error: ' + ((error && error.stack) || error));
      if (!res.headersSent) sendText(res, 500, 'internal error');
      else res.end();
    } finally {
      if (log && pathname !== '/m/api/state') {
        log(`${method} ${pathname} ${res.statusCode} ${now() - started}ms`);
      }
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  return {
    server,
    port,
    pin,
    get paired() {
      return forcePaired;
    },
    close() {
      return new Promise((resolvePromise) => {
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch (_) {
          /* ignore */
        }
        server.close(() => resolvePromise());
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const parsed = { port: undefined, pin: undefined, paired: undefined, host: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      parsed.port = Number(argv[++i]);
    } else if (arg === '--pin') {
      parsed.pin = argv[++i];
    } else if (arg === '--paired') {
      parsed.paired = true;
    } else if (arg === '--host') {
      parsed.host = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }
  return parsed;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'DSH Mobile dev mock server',
        '',
        'Usage: node dev/mock-server.mjs [--port 7862] [--pin 123456] [--paired] [--host 127.0.0.1]',
        '',
        'Open http://127.0.0.1:<port>/m/ and pair with the PIN (default 123456).',
        'Dev control routes: /__mock/pair, /__mock/logout, /__mock/reset, /__mock/info',
      ].join('\n'),
    );
    process.exit(0);
  }
  const port = args.port === undefined ? Number(process.env.MOCK_PORT) || 7862 : args.port;
  const pin = args.pin || process.env.MOCK_PIN || '123456';
  const paired = args.paired === true || process.env.MOCK_PAIRED === '1';
  const host = args.host || process.env.MOCK_HOST || '127.0.0.1';

  startMockServer({ port, pin, paired, host, log: (msg) => console.log('[mock-server] ' + msg) })
    .then((instance) => {
      console.log('');
      console.log('DSH Mobile dev mock server');
      console.log('  shell : http://' + host + ':' + instance.port + '/m/');
      console.log('  pin   : ' + instance.pin);
      console.log('  paired: ' + (paired ? 'yes (--paired)' : 'no (pair through the UI)'));
      console.log('  routes: /m/, /m/api/state, /m/api/pair, /, /__mock/pair');
      console.log('');
      console.log('Press Ctrl+C to stop.');
    })
    .catch((error) => {
      console.error('[mock-server] failed to start:', (error && error.message) || error);
      process.exit(1);
    });
}
