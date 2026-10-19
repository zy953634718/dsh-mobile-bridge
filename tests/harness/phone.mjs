/**
 * phone.mjs -- minimal "phone browser" HTTP client for E2E tests.
 *
 * - manual cookie jar (like a browser cookie store): captures `Set-Cookie` from
 *   responses, honours Domain/Path, replays on matching requests
 * - no automatic redirects (tests assert 303/401 status codes directly)
 * - raw WebSocket upgrade helper (net socket + HTTP handshake) since an HTTP
 *   client cannot perform a WS upgrade; used for /api/remote.mux via the bridge
 * - NOTE: uses node:http rather than fetch() on purpose. Under this sandbox
 *   fetch()'s undici keep-alive + raw-socket + process.exit() can abort with a
 *   libuv assertion (reproduced 2026-10-19, src/win/async.c:94); node:http with
 *   agent:false has no such pending-handle race, and allows a custom Host header.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

/** plain low-level request; returns {statusCode, headers(plain), setCookies[], location, text, buffer, elapsedMs} */
export function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const url = new URL(urlStr);
  const mod = url.protocol === 'https:' ? https : http;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers, agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = res.rawHeaders;
        const setCookies = [];
        for (let i = 0; i < raw.length; i += 2) {
          if (String(raw[i]).toLowerCase() === 'set-cookie') setCookies.push(raw[i + 1]);
        }
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          setCookies,
          location: res.headers.location ?? null,
          text: buffer.toString('utf8'),
          buffer,
          elapsedMs: Math.round(performance.now() - started),
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function parseSetCookie(header) {
  const parts = String(header).split(';');
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    domain: null,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
    expires: null,
    maxAge: null,
  };
  for (const raw of attrs) {
    const a = raw.trim();
    const i = a.indexOf('=');
    const key = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : a.slice(i + 1).trim();
    if (key === 'domain') cookie.domain = val.replace(/^\./, '').toLowerCase();
    else if (key === 'path') cookie.path = val || '/';
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
    else if (key === 'expires') cookie.expires = val;
    else if (key === 'max-age') cookie.maxAge = Number(val);
  }
  return cookie;
}

function domainMatch(hostname, cookie) {
  if (!cookie.domain) return true; // host-only cookie
  const h = hostname.toLowerCase();
  return h === cookie.domain || h.endsWith('.' + cookie.domain);
}
function pathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/')) return true;
  return false;
}

export class CookieJar {
  constructor() { this.cookies = []; }
  addFromSetCookie(headers) {
    for (const h of headers) {
      const c = parseSetCookie(h);
      if (!c) continue;
      const expired = (c.maxAge !== null && c.maxAge <= 0) ||
        (c.expires && new Date(c.expires).getTime() <= Date.now());
      this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.path === c.path && x.domain === c.domain));
      if (!expired) this.cookies.push(c);
    }
    return this;
  }
  headerFor(url, { includeHttpOnly = true } = {}) {
    const u = new URL(url);
    const list = this.cookies.filter((c) =>
      domainMatch(u.hostname, c) &&
      pathMatch(u.pathname || '/', c.path || '/') &&
      (!c.secure || u.protocol === 'https:') &&
      (includeHttpOnly || !c.httpOnly));
    if (!list.length) return null;
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  names() { return this.cookies.map((c) => c.name); }
  has(re) { return this.cookies.some((c) => (re instanceof RegExp ? re.test(c.name) : c.name === re)); }
  matchesName(re) { return this.cookies.filter((c) => re.test(c.name)); }
  clear() { this.cookies = []; return this; }
  toJSON() { return this.cookies; }
}

export class Phone {
  /**
   * @param {string} origin e.g. http://127.0.0.1:7861  (the *public* origin under test)
   * @param {{timeoutMs?:number}} [opts]
   */
  constructor(origin, opts = {}) {
    this.origin = origin.replace(/\/$/, '');
    this.jar = new CookieJar();
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.log = [];
  }
  url(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return this.origin + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
  }
  /**
   * @returns {Promise<{status:number, headers:object, setCookies:string[], text:string,
   *                    json:()=>any, location:string|null, url:string, elapsedMs:number}>}
   */
  async request(pathOrUrl, { method = 'GET', headers = {}, body, redirect = 'manual', timeoutMs = this.timeoutMs, sendCookies = true } = {}) {
    void redirect; // never follow redirects: the E2E suite asserts 303/401 explicitly
    const url = this.url(pathOrUrl);
    const h = { ...headers };
    if (sendCookies) {
      const cookie = this.jar.headerFor(url);
      if (cookie && !h.cookie && !h.Cookie) h.cookie = cookie;
    }
    let payload = null;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || body instanceof Uint8Array) payload = body;
      else { payload = JSON.stringify(body); if (!h['content-type'] && !h['Content-Type']) h['content-type'] = 'application/json'; }
    }
    const res = await httpRequest(url, { method, headers: h, body: payload, timeoutMs });
    this.jar.addFromSetCookie(res.setCookies);
    this.log.push({ method, url, status: res.statusCode, elapsedMs: res.elapsedMs });
    return {
      url,
      method,
      status: res.statusCode,
      headers: res.headers,
      setCookies: res.setCookies,
      location: res.location,
      text: res.text,
      elapsedMs: res.elapsedMs,
      json() { try { return JSON.parse(res.text); } catch { return null; } },
    };
  }
  get(pathOrUrl, opts) { return this.request(pathOrUrl, { ...opts, method: 'GET' }); }
  post(pathOrUrl, body, opts) { return this.request(pathOrUrl, { ...opts, method: 'POST', body }); }

  /**
   * Raw WebSocket upgrade.
   * Resolves with { status, headers, socket, body?, request, elapsedMs }; for
   * status 101 the socket is left open and the caller MUST close it.
   */
  async wsUpgrade(pathOrUrl, { headers = {}, timeoutMs = 10000, hostHeader } = {}) {
    const url = new URL(this.url(pathOrUrl));
    const host = hostHeader || url.host;
    const key = randomBytes(16).toString('base64');
    const cookie = this.jar.headerFor(url);
    const lines = [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (headers.origin) lines.push(`Origin: ${headers.origin}`);
    if (Array.isArray(headers.extra)) lines.push(...headers.extra);
    if (cookie) lines.push(`Cookie: ${cookie}`);
    const request = lines.join('\r\n') + '\r\n\r\n';
    const started = performance.now();
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 80) });
    let settled = false;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { socket.destroy(); } catch {} reject(new Error(`WS upgrade timeout after ${timeoutMs}ms`)); }
      }, timeoutMs);
      const finish = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
      const chunks = [];
      socket.once('connect', () => socket.write(request));
      socket.on('data', (buf) => {
        chunks.push(buf);
        const all = Buffer.concat(chunks);
        const idx = all.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = all.subarray(0, idx).toString('latin1');
        const rest = all.subarray(idx + 4);
        const statusLine = head.split('\r\n')[0] || '';
        const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/);
        if (!m) { try { socket.destroy(); } catch {} finish({ status: 0, error: `bad status line: ${statusLine}`, request, elapsedMs: Math.round(performance.now() - started) }); return; }
        const status = Number(m[1]);
        const hdrs = {};
        for (const line of head.split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if (status === 101) {
          socket.removeAllListeners('data');
          finish({ status, headers: hdrs, socket, rest, request, elapsedMs: Math.round(performance.now() - started) });
          return;
        }
        // non-101: collect the body until close (bounded), then resolve
        const bodyChunks = [];
        socket.removeAllListeners('data');
        socket.on('data', (b) => bodyChunks.push(b));
        const done = () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve({ status, headers: hdrs, socket, body: Buffer.concat([rest, ...bodyChunks]).toString('utf8'), request, elapsedMs: Math.round(performance.now() - started) });
          }
          try { socket.destroy(); } catch {}
        };
        const bodyTimer = setTimeout(done, Math.min(1500, timeoutMs));
        socket.once('end', () => { clearTimeout(bodyTimer); done(); });
        socket.once('close', () => { clearTimeout(bodyTimer); done(); });
        socket.once('error', () => { clearTimeout(bodyTimer); done(); });
      });
      socket.once('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      socket.once('close', () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ status: 0, closedBeforeResponse: true, body: Buffer.concat(chunks).toString('utf8'), request, elapsedMs: Math.round(performance.now() - started) }); }
      });
    });
    if (result.status === 101) return result; // caller closes socket
    try { result.socket?.destroy(); } catch {}
    return result;
  }
}

/** wait until fn() is truthy. */
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor ${label} timeout after ${timeoutMs}ms`);
}

/**
 * Send a raw HTTP/1.1 request string (for protocol-level checks an HTTP client
 * cannot express: absolute-form request targets, CONNECT, malformed handshakes).
 * @returns {Promise<{status:number, headers:object, body:string, elapsedMs:number}>}
 */
export function rawHttpRequest(host, port, requestText, { timeoutMs = 5000 } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks = [];
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; clearTimeout(timer); try { socket.destroy(); } catch {} resolve(val); } };
    const timer = setTimeout(() => finish({ status: 0, headers: {}, body: Buffer.concat(chunks).toString('utf8'), elapsedMs: Math.round(performance.now() - started), timedOut: true }), timeoutMs);
    socket.once('connect', () => socket.write(requestText));
    socket.on('data', (buf) => {
      chunks.push(buf);
      const all = Buffer.concat(chunks);
      const idx = all.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = all.subarray(0, idx).toString('latin1');
      const lines = head.split('\r\n');
      const m = (lines[0] || '').match(/^HTTP\/1\.[01]\s+(\d{3})/);
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      finish({ status: m ? Number(m[1]) : 0, headers, body: all.subarray(idx + 4).toString('utf8'), elapsedMs: Math.round(performance.now() - started) });
    });
    socket.once('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    socket.once('close', () => finish({ status: 0, headers: {}, body: Buffer.concat(chunks).toString('utf8'), closed: true, elapsedMs: Math.round(performance.now() - started) }));
  });
}

/** close a 101 socket politely enough, then destroy. */
export function closeWs(result) {
  try { result?.socket?.end(); } catch {}
  try { result?.socket?.destroy(); } catch {}
}
