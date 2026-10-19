// Reverse proxy for the DSH Web GUI: HTTP pass-through plus a raw WebSocket
// upgrade tunnel. Only one upstream is ever dialed; request-targets that would
// turn the listener into a forward proxy (absolute-form URLs, CONNECT) are
// refused before this module is reached.
//
// The rewrite contract: `Host` becomes the DSH target authority (so DSH's
// authority-bound browser cookie and its loopback/Host trust fence keep
// working), `Origin`/`Referer` become the DSH target origin (so the same-origin
// checks accept requests that a browser addressed to the bridge origin), and
// the cookie travels unchanged both ways.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { drainResponse, isOriginFormPath, sendText } from './http-util.js';

/** Connection-scoped headers never forwarded across the hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const HTML_INJECT_LIMIT_BYTES = 4 * 1024 * 1024;

// Older Android WebViews (e.g. Huawei WebView 14, Chromium < 119) miss a few
// ECMAScript features the DSH Web GUI bootstrap uses. The GUI index runs
// `Promise.withResolvers()` in its boot tail, so without this shim the GUI
// iframe never boots on those phones. The script is injected into proxied
// text/html responses only, is idempotent, and never changes application data.
const COMPAT_SCRIPT = `<script data-dsh-mobile-compat>(function(){
  function define(target, name, value) {
    try {
      if (typeof target[name] !== 'function') {
        Object.defineProperty(target, name, { value: value, writable: true, configurable: true });
      }
    } catch (error) { /* ignore */ }
  }
  define(Promise, 'withResolvers', function () {
    var resolve, reject;
    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
  });
  if (typeof structuredClone !== 'function') {
    globalThis.structuredClone = function (value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); };
  }
  // Insecure-context (plain HTTP LAN) WebViews do not expose crypto.randomUUID.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
      Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: function randomUUID() {
          var bytes = new Uint8Array(16);
          crypto.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          var hex = '';
          for (var index = 0; index < 16; index += 1) {
            hex += (bytes[index] + 256).toString(16).slice(1);
            if (index === 3 || index === 5 || index === 7 || index === 9) hex += '-';
          }
          return hex;
        },
      });
    }
  } catch (error) { /* ignore */ }
  define(Array.prototype, 'with', function (index, value) {
    var copy = this.slice();
    var at = index < 0 ? copy.length + index : index;
    if (at < 0 || at >= copy.length) throw new RangeError('Invalid index');
    copy[at] = value;
    return copy;
  });
  define(Array.prototype, 'toSorted', function (compare) { return this.slice().sort(compare); });
  define(Array.prototype, 'toReversed', function () { return this.slice().reverse(); });
  define(Array.prototype, 'toSpliced', function (start, deleteCount) {
    var copy = this.slice();
    copy.splice.apply(copy, [start, deleteCount].concat(Array.prototype.slice.call(arguments, 2)));
    return copy;
  });
  define(Object, 'groupBy', function (items, keyFn) {
    var out = Object.create(null);
    for (var index = 0; index < items.length; index += 1) {
      var key = keyFn(items[index], index);
      (out[key] = out[key] || []).push(items[index]);
    }
    return out;
  });
  define(Map, 'groupBy', function (items, keyFn) {
    var out = new Map();
    for (var index = 0; index < items.length; index += 1) {
      var key = keyFn(items[index], index);
      var list = out.get(key);
      if (list === undefined) { list = []; out.set(key, list); }
      list.push(items[index]);
    }
    return out;
  });
  if (typeof AbortSignal !== 'undefined') {
    define(AbortSignal, 'timeout', function (ms) {
      var controller = new AbortController();
      setTimeout(function () { controller.abort(new DOMException('TimeoutError', 'TimeoutError')); }, ms);
      return controller.signal;
    });
    define(AbortSignal, 'any', function (signals) {
      var controller = new AbortController();
      var listeners = [];
      var cleanup = function () {
        for (var index = 0; index < signals.length; index += 1) {
          try { signals[index].removeEventListener('abort', listeners[index]); } catch (error) { /* ignore */ }
        }
      };
      var abortWith = function (signal) {
        if (controller.signal.aborted) return;
        cleanup();
        try {
          if (signal && signal.reason !== undefined) controller.abort(signal.reason);
          else controller.abort();
        } catch (error) { controller.abort(); }
      };
      for (var index = 0; index < signals.length; index += 1) {
        var signal = signals[index];
        var listener = (function (source) { return function () { abortWith(source); }; })(signal);
        listeners.push(listener);
        if (signal.aborted) { abortWith(signal); break; }
        signal.addEventListener('abort', listener);
      }
      return controller.signal;
    });
    if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
      define(AbortSignal.prototype, 'throwIfAborted', function () {
        if (this.aborted) throw this.reason;
      });
    }
  }
  if (typeof URL !== 'undefined') {
    define(URL, 'canParse', function (input, base) {
      try { new URL(input, base); return true; } catch (error) { return false; }
    });
  }
})();</script>`;

/**
 * Inject the compatibility shim into one HTML document (idempotent).
 * @param {string} html raw document text.
 * @returns {string} document with the shim placed right after `<head>`.
 */
export function injectHtmlCompat(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (html.includes('data-dsh-mobile-compat')) return html;
  const headPattern = /<head(?:\s[^>]*)?>/i;
  if (headPattern.test(html)) return html.replace(headPattern, (open) => `${open}${COMPAT_SCRIPT}`);
  const htmlPattern = /<html(?:\s[^>]*)?>/i;
  if (htmlPattern.test(html)) return html.replace(htmlPattern, (open) => `${open}${COMPAT_SCRIPT}`);
  return COMPAT_SCRIPT + html;
}


/**
 * Parse and validate the DSH target origin.
 * @param {unknown} targetOrigin e.g. `http://127.0.0.1:6326`.
 * @returns {{origin: string, authority: string, hostname: string, port: number, isHttps: boolean}}
 */
export function parseTargetOrigin(targetOrigin) {
  let url;
  try {
    url = new URL(String(targetOrigin ?? ''));
  } catch {
    throw new Error(`mobile-bridge: targetOrigin is not a valid URL: ${String(targetOrigin)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`mobile-bridge: targetOrigin must be http(s), got ${url.protocol}`);
  }
  const isHttps = url.protocol === 'https:';
  return {
    origin: url.origin,
    authority: url.host,
    hostname: url.hostname.replace(/^\[|\]$/gu, ''),
    port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
    isHttps,
  };
}

/** Positive integer option with a default. */
function positiveInteger(value, fallback) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

/**
 * Create the proxy facade for one target origin.
 *
 * @param {object} options
 * @param {string} options.targetOrigin loopback DSH origin, e.g. `http://127.0.0.1:6326`.
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 * @param {number} [options.probeTimeoutMs] authenticated-probe bound.
 * @param {number} [options.upstreamTimeoutMs] upstream inactivity bound before response headers.
 * @param {number} [options.connectTimeoutMs] WebSocket upstream connect bound.
 * @param {boolean} [options.tlsRejectUnauthorized] TLS verification for an https target.
 */
export function createProxy(options) {
  const upstream = parseTargetOrigin(options?.targetOrigin);
  const logger = options?.logger ?? console;
  const probeTimeoutMs = positiveInteger(options?.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const upstreamTimeoutMs = positiveInteger(options?.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const connectTimeoutMs = positiveInteger(options?.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const tlsRejectUnauthorized = options?.tlsRejectUnauthorized !== false;

  const transport = upstream.isHttps ? https : http;
  const agentOptions = { keepAlive: true, maxSockets: 64, maxFreeSockets: 8, timeout: upstreamTimeoutMs };
  const agent = upstream.isHttps
    ? new https.Agent({ ...agentOptions, rejectUnauthorized: tlsRejectUnauthorized })
    : new http.Agent(agentOptions);

  /**
   * Rewrite a browser Referer to the upstream origin, preserving path/query.
   * @param {string} value original Referer.
   * @returns {string} upstream-origin Referer.
   */
  function rewriteReferer(value) {
    try {
      const url = new URL(value);
      return `${upstream.origin}${url.pathname}${url.search}${url.hash}`;
    } catch {
      return `${upstream.origin}/`;
    }
  }

  /**
   * Build upstream request headers: mutate Host/Origin/Referer, drop hop-by-hop
   * and undefined values (Node rejects undefined header values).
   * @param {import('node:http').IncomingMessage} req client request.
   * @returns {Record<string, string|string[]>}
   */
  function buildUpstreamHeaders(req) {
    /** @type {Record<string, string|string[]>} */
    const headers = {};
    const documentRequest = typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html');
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower === 'host' || HOP_BY_HOP.has(lower)) continue;
      // Document responses are buffered to inject the WebView compatibility
      // shim; keep them uncompressed so the HTML can be rewritten safely.
      if (lower === 'accept-encoding' && documentRequest) continue;
      headers[lower] = value;
    }
    headers.host = upstream.authority;
    if (typeof headers.origin === 'string') headers.origin = upstream.origin;
    if (typeof headers.referer === 'string') headers.referer = rewriteReferer(headers.referer);
    return headers;
  }

  /**
   * Build downstream headers from an upstream response, dropping hop-by-hop
   * headers (Node re-frames the body) and keeping Set-Cookie arrays intact.
   * @param {import('node:http').IncomingMessage} upRes upstream response.
   * @returns {Record<string, string|string[]>}
   */
  function buildDownstreamHeaders(upRes) {
    /** @type {Record<string, string|string[]>} */
    const headers = {};
    for (const [name, value] of Object.entries(upRes.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      headers[lower] = value;
    }
    return headers;
  }

  /**
   * Proxy one ordinary HTTP request to the DSH target.
   * @param {import('node:http').IncomingMessage} req client request.
   * @param {import('node:http').ServerResponse} res client response.
   */
  function proxyHttp(req, res) {
    if (!isOriginFormPath(req.url)) {
      sendText(res, 400, 'mobile-bridge: proxy accepts origin-form request targets only');
      return;
    }
    let upstreamRequest;
    try {
      upstreamRequest = transport.request({
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: buildUpstreamHeaders(req),
        agent,
      });
    } catch (error) {
      logger.warn?.(`mobile-bridge: upstream request construction failed: ${String(error?.message ?? error)}`);
      sendText(res, 502, 'mobile-bridge: upstream unavailable');
      return;
    }
    /**
     * Destroying a keep-alive ClientRequest only detaches it; the socket can be
     * parked back in the agent pool and stay open, so failed/aborted requests
     * close the socket explicitly.
     * @type {import('node:net').Socket | undefined}
     */
    let upstreamSocket;
    const destroyUpstream = () => {
      try {
        upstreamRequest.destroy();
      } catch {
        /* ignore */
      }
      try {
        upstreamSocket?.destroy();
      } catch {
        /* ignore */
      }
    };
    upstreamRequest.on('socket', (socket) => {
      upstreamSocket = socket;
    });
    let headersReceived = false;
    const fail = (status, message) => {
      destroyUpstream();
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      sendText(res, status, message);
    };
    upstreamRequest.on('response', (upRes) => {
      headersReceived = true;
      upstreamRequest.setTimeout(0);
      const statusCode = upRes.statusCode ?? 502;
      const contentType = String(upRes.headers['content-type'] ?? '');
      const injectable =
        req.method === 'GET' &&
        statusCode === 200 &&
        /text\/html/i.test(contentType) &&
        upRes.headers['content-encoding'] === undefined;
      if (!injectable) {
        try {
          res.writeHead(statusCode, buildDownstreamHeaders(upRes));
        } catch {
          upRes.destroy();
          res.destroy();
          return;
        }
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
        upRes.on('aborted', () => res.destroy());
        res.on('close', () => {
          if (!res.writableEnded) {
            upRes.destroy();
            destroyUpstream();
          }
        });
        return;
      }
      // Small HTML documents (the DSH GUI index) are buffered so the WebView
      // compatibility shim runs before any application script.
      const chunks = [];
      let total = 0;
      let overflow = false;
      upRes.on('data', (chunk) => {
        if (overflow) return;
        total += chunk.length;
        if (total > HTML_INJECT_LIMIT_BYTES) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      upRes.on('end', () => {
        if (res.destroyed) {
          destroyUpstream();
          return;
        }
        const headers = buildDownstreamHeaders(upRes);
        const source = overflow ? '' : injectHtmlCompat(Buffer.concat(chunks).toString('utf8'));
        const payload = Buffer.from(source, 'utf8');
        delete headers['content-length'];
        delete headers['content-encoding'];
        headers['content-length'] = String(payload.length);
        headers['cache-control'] = 'no-store';
        try {
          res.writeHead(overflow ? 500 : 200, headers);
          res.end(payload);
        } catch {
          res.destroy();
        }
      });
      upRes.on('error', () => res.destroy());
      upRes.on('aborted', () => res.destroy());
      res.on('close', () => {
        if (!res.writableEnded) {
          upRes.destroy();
          destroyUpstream();
        }
      });
    });
    upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
      const timeout = new Error('upstream response timeout');
      timeout.code = 'ETIMEDOUT';
      upstreamRequest.destroy(timeout);
      // A keep-alive socket would otherwise be parked in the pool still open.
      try {
        upstreamSocket?.destroy();
      } catch {
        /* ignore */
      }
    });
    upstreamRequest.on('error', (error) => {
      if (headersReceived) {
        res.destroy();
        return;
      }
      const timedOut = error?.code === 'ETIMEDOUT';
      logger.warn?.(`mobile-bridge: upstream ${timedOut ? 'timeout' : 'error'}: ${String(error?.message ?? error)}`);
      fail(timedOut ? 504 : 502, timedOut ? 'mobile-bridge: upstream timed out' : 'mobile-bridge: upstream unavailable');
    });
    req.on('error', () => destroyUpstream());
    res.on('close', () => {
      if (!res.writableEnded) destroyUpstream();
    });
    req.pipe(upstreamRequest);
  }

  /**
   * Build the raw WebSocket handshake forwarded upstream: every end-to-end
   * header is preserved (Upgrade/Connection/Sec-WebSocket-* stay untouched)
   * while Host/Origin/Referer are rewritten. Browsers attach Origin to the
   * upgrade, so DSH's same-origin fence is satisfied exactly as for HTTP.
   * @param {import('node:http').IncomingMessage} req upgrade request.
   * @returns {string} raw handshake text.
   */
  function buildUpgradeHandshake(req) {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = String(rawHeaders[index] ?? '');
      const value = String(rawHeaders[index + 1] ?? '');
      if (name === '' || value.includes('\r') || value.includes('\n')) continue;
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'origin' || lower === 'referer') continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push(`Host: ${upstream.authority}`);
    if (typeof req.headers.origin === 'string') lines.push(`Origin: ${upstream.origin}`);
    if (typeof req.headers.referer === 'string') lines.push(`Referer: ${rewriteReferer(req.headers.referer)}`);
    lines.push('', '');
    return lines.join('\r\n');
  }

  /**
   * Tunnel one HTTP Upgrade (WebSocket) request to the DSH target: raw TCP pipe
   * after the handshake, no HTTP semantic rewriting of the framed data.
   * @param {import('node:http').IncomingMessage} req upgrade request.
   * @param {import('node:net').Socket} socket client socket.
   * @param {Buffer} head bytes already read after the client handshake.
   */
  function proxyUpgrade(req, socket, head) {
    if (!isOriginFormPath(req.url)) {
      endSocketWithStatus(socket, 400, 'Bad Request');
      return;
    }
    const handshake = buildUpgradeHandshake(req);
    /** @type {import('node:net').Socket} */
    let targetSocket;
    let connected = false;
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (connected) return;
      settled = true;
      try {
        targetSocket?.destroy();
      } catch {
        /* ignore */
      }
      endSocketWithStatus(socket, 504, 'Gateway Timeout');
    }, connectTimeoutMs);
    const cleanupTimer = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
    };
    try {
      targetSocket = upstream.isHttps
        ? tls.connect({
            host: upstream.hostname,
            port: upstream.port,
            servername: net.isIP(upstream.hostname) === 0 ? upstream.hostname : undefined,
            rejectUnauthorized: tlsRejectUnauthorized,
          })
        : net.connect(upstream.port, upstream.hostname);
      targetSocket.setNoDelay?.(true);
    } catch (error) {
      cleanupTimer();
      logger.warn?.(`mobile-bridge: websocket upstream connect failed: ${String(error?.message ?? error)}`);
      endSocketWithStatus(socket, 502, 'Bad Gateway');
      return;
    }
    const onUpstreamReady = () => {
      if (settled && !connected) return;
      connected = true;
      cleanupTimer();
      try {
        targetSocket.write(handshake);
        if (Buffer.isBuffer(head) && head.length > 0) targetSocket.write(head);
      } catch {
        targetSocket.destroy();
      }
    };
    if (upstream.isHttps) targetSocket.once('secureConnect', onUpstreamReady);
    else targetSocket.once('connect', onUpstreamReady);
    targetSocket.on('error', (error) => {
      const wasConnected = connected;
      cleanupTimer();
      if (!wasConnected) {
        logger.warn?.(`mobile-bridge: websocket upstream unavailable: ${String(error?.message ?? error)}`);
        endSocketWithStatus(socket, 502, 'Bad Gateway');
      } else {
        socket.destroy();
      }
    });
    socket.on('error', () => targetSocket.destroy());
    socket.on('close', () => targetSocket.destroy());
    targetSocket.on('close', () => {
      cleanupTimer();
      if (!socket.destroyed) socket.end();
    });
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  }

  /**
   * Cheap authenticated probe: forward `GET /` with the caller's Cookie. A 200
   * means DSH accepted the browser session; 303 (stale token exchange) and 401
   * both mean "not paired". Never throws, bounded by `probeTimeoutMs`.
   * @param {unknown} cookieHeader raw Cookie header from the phone request.
   * @returns {Promise<boolean>}
   */
  function probeAuthenticated(cookieHeader) {
    if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      let probe;
      try {
        probe = transport.request({
          hostname: upstream.hostname,
          port: upstream.port,
          method: 'GET',
          path: '/',
          agent,
          headers: {
            host: upstream.authority,
            cookie: cookieHeader,
            accept: 'text/html',
            'accept-encoding': 'identity',
            'user-agent': 'dsh-plugin-mobile-bridge/state-probe',
          },
        });
      } catch {
        finish(false);
        return;
      }
      probe.setTimeout(probeTimeoutMs, () => {
        const socket = probe.socket;
        probe.destroy();
        try {
          socket?.destroy();
        } catch {
          /* ignore */
        }
        finish(false);
      });
      probe.on('response', (upRes) => {
        probe.setTimeout(0);
        const status = upRes.statusCode ?? 0;
        drainResponse(upRes).then(() => finish(status === 200));
      });
      probe.on('error', () => finish(false));
      probe.end();
    });
  }

  /** Release pooled sockets (bridge close). */
  function dispose() {
    agent.destroy();
  }

  return { upstream, proxyHttp, proxyUpgrade, probeAuthenticated, dispose };
}

/**
 * End a raw upgrade socket with one minimal HTTP error response.
 * @param {import('node:net').Socket} socket client socket.
 * @param {number} status HTTP status code.
 * @param {string} reason reason phrase.
 */
function endSocketWithStatus(socket, status, reason) {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  } catch {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
}
