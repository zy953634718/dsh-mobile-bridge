// The LAN bridge listener: routes the mobile shell (`/m/`), the PIN pairing API
// (`/m/api/*`), the loopback-only desktop pairing page (`/m/pair*`), the
// loopback health probe (`/healthz`), and reverse-proxies everything else to
// the running DSH Web GUI. Node builtins only: this module is the standalone
// entry point QA and the Cordis plugin both use.
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOriginFormPath, readJsonBody, sendJson, sendText } from './http-util.js';
import { isLoopbackAddress, normalizeAddress, resolveUrlHosts } from './network.js';
import { PairingGate } from './pairing.js';
import { createProxy } from './proxy.js';
import { serveFile, serveStaticPath } from './static.js';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_STATIC_DIR = join(PACKAGE_DIR, 'public');
const DEFAULT_PAIR_PAGE_DIR = join(PACKAGE_DIR, 'pair-page');

const DEFAULT_BIND_HOST = '0.0.0.0';
const DEFAULT_PORT = 7860;
const DEFAULT_PAIR_ATTEMPTS = 8;
const DEFAULT_PAIR_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
/** Advertised lifetime of a minted pairing URL (the DSH process token itself lives with the process). */
const PAIR_URL_TTL_MS = 120_000;
const PAIR_BODY_LIMIT_BYTES = 4 * 1024;

const CONSOLE_LOGGER = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const MISSING_DIRECTORY_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR']);

/** Normalize a logger option to always expose info/warn/error functions. */
function normalizeLogger(logger) {
  const candidate = logger !== null && typeof logger === 'object' ? logger : {};
  const pick = (name) => (typeof candidate[name] === 'function' ? candidate[name].bind(candidate) : CONSOLE_LOGGER[name]);
  return { info: pick('info'), warn: pick('warn'), error: pick('error') };
}

/** Integer option with default and bounds. */
function integerOption(value, fallback, min, max) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/** Non-empty string option with default. */
function stringOption(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text === '' ? fallback : text;
}

/** `http://host:port` for a bind address, loopback-safe for the pair-page log line. */
function desktopProbeOrigin(bindHost, port) {
  const host = bindHost === '0.0.0.0' || bindHost === '::' || isLoopbackAddress(bindHost) ? '127.0.0.1' : bindHost;
  const formatted = host.includes(':') ? `[${host}]` : host;
  return `http://${formatted}:${port}`;
}

/**
 * Start the standalone LAN bridge (no Cordis required).
 *
 * @param {object} options
 * @param {string} options.targetOrigin loopback DSH origin, e.g. `http://127.0.0.1:6326` (required).
 * @param {(baseUrl: string) => string} [options.authenticatedUrl] DSH token-URL minter;
 *   forwarding `ctx.connection.authenticatedUrl`. Missing => pairing returns 503.
 * @param {string} [options.bindHost='0.0.0.0'] listener bind address.
 * @param {number} [options.port=7860] listener port; `0` assigns a free port.
 * @param {string} [options.publicHost] host authority used in pairing URLs.
 * @param {string|number} [options.pin] fixed PIN (tests/dev); omitted => random per process.
 * @param {number} [options.pairAttempts=8] failed attempts per IP per 10 min.
 * @param {number} [options.pairWindowMs=600000] limiter window.
 * @param {string} [options.staticDir] mobile shell root, default package `public/`.
 * @param {string} [options.pairPageDir] desktop pair page directory, default package `pair-page/`.
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 * @param {number} [options.probeTimeoutMs] authenticated-probe bound.
 * @param {number} [options.upstreamTimeoutMs] upstream inactivity bound.
 * @returns {Promise<{port: number, host: string, pin: string, urls: string[], targetOrigin: string, pairPageUrl: string, close: () => Promise<void>}>}
 */
export async function startBridge(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const targetOrigin = stringOption(settings.targetOrigin, '');
  if (targetOrigin === '') throw new Error('mobile-bridge: startBridge requires options.targetOrigin');
  const logger = normalizeLogger(settings.logger);
  const bindHost = stringOption(settings.bindHost, DEFAULT_BIND_HOST);
  const requestedPort = integerOption(settings.port, DEFAULT_PORT, 0, 65535);
  const staticDir = resolve(stringOption(settings.staticDir, DEFAULT_STATIC_DIR));
  const pairPageDir = resolve(stringOption(settings.pairPageDir, DEFAULT_PAIR_PAGE_DIR));
  const pairedUrlFor = typeof settings.authenticatedUrl === 'function' ? settings.authenticatedUrl : undefined;

  const proxy = createProxy({
    targetOrigin,
    logger,
    probeTimeoutMs: integerOption(settings.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 100, 60_000),
    upstreamTimeoutMs: integerOption(settings.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS, 1_000, 600_000),
  });
  const gate = new PairingGate({
    pin: settings.pin,
    pairAttempts: integerOption(settings.pairAttempts, DEFAULT_PAIR_ATTEMPTS, 1, 1_000_000),
    windowMs: integerOption(settings.pairWindowMs, DEFAULT_PAIR_WINDOW_MS, 1_000, 24 * 60 * 60 * 1000),
  });

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let closed = false;
  let port = requestedPort;
  let urlHosts = [];

  /** Candidate phone URLs, recomputed after a successful bind (the port may be OS-assigned). */
  function refreshUrls() {
    urlHosts = resolveUrlHosts({ publicHost: settings.publicHost, bindHost, port });
    return urlHosts;
  }

  /**
   * First value of a (possibly repeated) proxy header.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {string} name lower-case header name.
   * @returns {string}
   */
  function proxyHeader(req, name) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value.split(',')[0].trim() : '';
  }

  /**
   * A reverse tunnel (cloudflared / ngrok / Tailscale Funnel) connects from
   * loopback but speaks for a remote client, so forwarded headers disqualify a
   * request from the loopback-only routes.
   * @param {import('node:http').IncomingMessage} req request.
   */
  function isProxiedRequest(req) {
    return ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'forwarded'].some(
      (name) => req.headers[name] !== undefined,
    );
  }

  /** Hostname-only helper for an authority such as `127.0.0.1:7860` or `x.lhr.life`. */
  function authorityHostname(authority) {
    if (authority === '') return '';
    try {
      return new URL(`http://${authority}`).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /** Loopback hosts only (`127.0.0.1`, `localhost`, `[::1]`). */
  function isLoopbackAuthority(authority) {
    const hostname = authorityHostname(authority);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  }

  /** Loopback + RFC1918/link-local/ULA hosts: plain HTTP; public tunnel hosts: HTTPS. */
  function isLocalAuthority(authority) {
    if (isLoopbackAuthority(authority)) return true;
    const hostname = authorityHostname(authority);
    if (hostname === '') return false;
    if (/^127\./u.test(hostname)) return true;
    if (/^10\./u.test(hostname)) return true;
    if (/^192\.168\./u.test(hostname)) return true;
    if (/^169\.254\./u.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./u.test(hostname)) return true;
    if (/^\[?(fc|fd|fe80:)/iu.test(hostname)) return true;
    return false;
  }

  /**
   * Public scheme: honour `X-Forwarded-Proto`; otherwise public tunnel hosts
   * terminate TLS so their pairing URLs must be https, while loopback/LAN stay
   * on plain http (local tunnels like localhost.run do not add forwarded headers).
   */
  function publicScheme(req) {
    const proto = proxyHeader(req, 'x-forwarded-proto').toLowerCase();
    if (proto === 'https' || proto === 'http') return proto;
    const authority = publicAuthority(req);
    return authority !== '' && !isLocalAuthority(authority) ? 'https' : 'http';
  }

  /** Public authority: `X-Forwarded-Host` wins over the raw Host header. */
  function publicAuthority(req) {
    const forwarded = proxyHeader(req, 'x-forwarded-host');
    const raw = forwarded !== '' ? forwarded : typeof req.headers.host === 'string' ? req.headers.host : '';
    if (raw === '') return '';
    try {
      const url = new URL(`http://${raw}`);
      return url.host !== '' ? url.host : '';
    } catch {
      return '';
    }
  }

  /** Pairing origin: configured publicHost wins, else the public authority this request reached us on. */
  function pairingOrigin(req) {
    if (urlHosts.length > 0 && stringOption(settings.publicHost, '') !== '') return urlHosts[0].base;
    const authority = publicAuthority(req);
    if (authority !== '') return `${publicScheme(req)}://${authority}`;
    return desktopProbeOrigin(bindHost, port);
  }

  /**
   * Loopback-only routes: the pairing PIN must never leave the machine.
   * A reverse tunnel (localhost.run / cloudflared / ngrok) reaches the bridge
   * from a loopback socket but carries the public tunnel Host, so requiring a
   * loopback Host (and no forwarded headers) keeps `/m/pair*` desktop-only.
   */
  function isLoopbackRequest(req) {
    return (
      !isProxiedRequest(req) &&
      isLoopbackAddress(req.socket?.remoteAddress) &&
      isLoopbackAuthority(publicAuthority(req))
    );
  }

  /** Normalized limiter key for this peer (real client IP behind a tunnel when provided). */
  /**
   * Normalized limiter key for this peer.
   * Deliberately socket-based only: forwarding headers are client-controllable
   * through localhost.run-style tunnels, so trusting them would let an attacker
   * rotate `X-Forwarded-For` to bypass the PIN attempt limit. Tunnel users all
   * share the loopback key, which makes internet brute force impractical.
   */
  function clientKey(req) {
    const normalized = normalizeAddress(req.socket?.remoteAddress);
    return normalized === '' ? 'unknown' : normalized;
  }

  /** Fast-ish JSON response helpers for the `/m/api/*` endpoints. */
  function methodNotAllowed(req, res, allow) {
    sendJson(
      res,
      405,
      { ok: false, error: 'method-not-allowed' },
      { allow, 'access-control-allow-methods': allow },
    );
  }

  /** GET /m/api/state - whether this browser already holds a valid DSH session. */
  async function handleState(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
    let paired = false;
    try {
      paired = await proxy.probeAuthenticated(req.headers.cookie);
    } catch (error) {
      logger.warn?.(`mobile-bridge: state probe failed: ${String(error?.message ?? error)}`);
    }
    const host = urlHosts.length > 0 && urlHosts[0].host !== '' ? urlHosts[0].host : '127.0.0.1';
    sendJson(res, 200, { ok: true, paired, host, dshUrl: '/', pinRequired: true });
  }

  /** POST /m/api/pair - exchange the desktop PIN for a tokenised DSH login URL. */
  async function handlePair(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(req, res, 'POST');
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    if (!/^application\/json(?:\s*;|\s*$)/iu.test(contentType)) {
      sendJson(res, 415, { ok: false, error: 'unsupported-media-type' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, PAIR_BODY_LIMIT_BYTES);
    } catch (error) {
      const status = error?.code === 'body-too-large' ? 413 : 400;
      sendJson(res, status, { ok: false, error: 'bad-request' });
      return;
    }
    const code = typeof body === 'object' && body !== null ? body.code : undefined;
    if (code === undefined || code === null || code === '') {
      sendJson(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const verdict = gate.verify(code, clientKey(req));
    if (!verdict.ok) {
      if (verdict.error === 'locked') {
        const retryAfterMs = verdict.retryAfterMs ?? gate.windowMs;
        sendJson(
          res,
          429,
          { ok: false, error: 'locked', retryAfterMs },
          { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
        );
        return;
      }
      sendJson(res, 401, { ok: false, error: 'bad-pin', attemptsLeft: verdict.attemptsLeft });
      return;
    }
    if (pairedUrlFor === undefined) {
      logger.warn?.('mobile-bridge: pairing is unavailable because no authenticatedUrl minter was supplied');
      sendJson(res, 503, { ok: false, error: 'pairing-unavailable' });
      return;
    }
    let url;
    try {
      url = String(pairedUrlFor(`${pairingOrigin(req)}/`));
      if (!/^https?:\/\//iu.test(url)) throw new Error('minted URL is not absolute http(s)');
    } catch (error) {
      logger.warn?.(`mobile-bridge: could not mint pairing URL: ${String(error?.message ?? error)}`);
      sendJson(res, 503, { ok: false, error: 'pairing-unavailable' });
      return;
    }
    // Never log the tokenised URL: it carries the DSH process launch token.
    logger.info?.(`mobile-bridge: phone paired from ${clientKey(req)}`);
    sendJson(res, 200, { ok: true, url, expiresInMs: PAIR_URL_TTL_MS });
  }

  /** GET /m/pair - desktop pairing page (loopback sockets only). */
  async function handlePairPage(req, res) {
    if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
    try {
      await serveFile(req, res, join(pairPageDir, 'index.html'), {
        cacheControl: 'no-store',
        notFoundMessage: 'mobile-bridge: pair-page/index.html is missing from the package',
      });
    } catch (error) {
      if (!MISSING_DIRECTORY_CODES.has(error?.code)) throw error;
      sendText(res, 500, 'mobile-bridge: pair-page/index.html is missing from the package');
    }
  }

  /** GET /m/pair/info - live PIN + phone URLs for the desktop page (loopback only). */
  function handlePairInfo(req, res) {
    if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
    sendJson(res, 200, {
      pin: gate.pin,
      urls: urlHosts.map((host) => `${host.base}/m/`),
      port,
      targetOrigin,
    });
  }

  /** GET /healthz - loopback liveness probe. */
  function handleHealthz(req, res) {
    if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
    sendJson(res, 200, { ok: true });
  }

  /** Route one request under the `/m` mount. */
  async function handleMounted(req, res, pathname) {
    if (pathname === '/m/api/state') return handleState(req, res);
    if (pathname === '/m/api/pair') return handlePair(req, res);
    if (pathname.startsWith('/m/api/')) return sendJson(res, 404, { ok: false, error: 'not-found' });
    if (pathname === '/m/pair') return handlePairPage(req, res);
    if (pathname === '/m/pair/info') return handlePairInfo(req, res);
    await serveStaticPath(req, res, { rootDir: staticDir, pathname });
  }

  /** Top-level request dispatch. */
  async function handleRequest(req, res) {
    if (!isOriginFormPath(req.url)) {
      sendText(res, 400, 'mobile-bridge: origin-form request targets only');
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://mobile-bridge.invalid');
    } catch {
      sendText(res, 400, 'mobile-bridge: invalid request target');
      return;
    }
    const pathname = url.pathname;
    if (pathname === '/m' || pathname === '/m/' || pathname.startsWith('/m/')) {
      await handleMounted(req, res, pathname);
      return;
    }
    if (pathname === '/healthz') {
      handleHealthz(req, res);
      return;
    }
    proxy.proxyHttp(req, res);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.error?.(`mobile-bridge: request handler failed: ${String(error?.stack ?? error)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
      else res.destroy();
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      proxy.proxyUpgrade(req, socket, head);
    } catch (error) {
      logger.warn?.(`mobile-bridge: websocket proxy failed: ${String(error?.message ?? error)}`);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  server.on('connect', (req, socket) => {
    // CONNECT would turn the listener into a generic TCP proxy; refuse it.
    try {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  server.on('clientError', (error, socket) => {
    logger.warn?.(`mobile-bridge: client error: ${String(error?.message ?? error)}`);
    if (socket.writable && !socket.destroyed) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {
        socket.destroy();
      }
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, bindHost);
  });
  server.on('error', (error) => {
    logger.error?.(`mobile-bridge: listener error: ${String(error?.message ?? error)}`);
  });

  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  refreshUrls();

  const phoneUrl = urlHosts[0]?.base !== undefined ? `${urlHosts[0].base}/m/` : `http://127.0.0.1:${port}/m/`;
  logger.info(`mobile-bridge: phone URL ${phoneUrl}  pin ${gate.pin}`);
  logger.info(`mobile-bridge: desktop pairing page ${desktopProbeOrigin(bindHost, port)}/m/pair`);
  logger.info(`mobile-bridge: proxying ${targetOrigin} on ${bindHost}:${port}`);

  /**
   * Stop the listener and release every socket (HTTP keep-alive, proxied
   * streams, and upgraded WebSocket tunnels).
   * @returns {Promise<void>}
   */
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      try {
        server.close(() => finish());
      } catch {
        finish();
      }
      try {
        server.closeAllConnections?.();
      } catch {
        /* older Node */
      }
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      proxy.dispose();
      const timer = setTimeout(finish, 2_000);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  return {
    port,
    host: bindHost,
    pin: gate.pin,
    urls: urlHosts.map((host) => `${host.base}/m/`),
    targetOrigin,
    pairPageUrl: `${desktopProbeOrigin(bindHost, port)}/m/pair`,
    close,
  };
}
