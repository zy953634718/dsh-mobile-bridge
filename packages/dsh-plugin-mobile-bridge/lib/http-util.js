// Small node:http helpers shared by the bridge routes. Node builtins only.

/**
 * Whether a request-target is origin-form (`/path?query`). Absolute-form
 * (`http://host/...`), authority-form (`host:port`, CONNECT), and asterisk-form
 * (`*`) are refused: the bridge is not a forward proxy.
 * @param {unknown} rawUrl `req.url`.
 * @returns {boolean}
 */
export function isOriginFormPath(rawUrl) {
  return typeof rawUrl === 'string' && rawUrl.startsWith('/');
}

/**
 * Write a JSON response with no-store caching (pairing/state responses are
 * per-request and must never be cached or sniffed).
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON-serializable body.
 * @param {Record<string, string|string[]>} [headers] extra headers.
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  let payload;
  try {
    payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  } catch {
    payload = Buffer.from('{"ok":false,"error":"internal"}\n', 'utf8');
    status = 500;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * Write a plain-text response (used for proxy-gateway failures and simple
 * protocol errors).
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {string} message body text.
 * @param {Record<string, string|string[]>} [headers] extra headers.
 */
export function sendText(res, status, message, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = Buffer.from(`${message}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} limitBytes maximum accepted body size.
 * @returns {Promise<unknown>} parsed JSON value.
 * @throws {Error & {code: string}} `body-too-large`, `bad-json`, or `aborted`.
 */
export async function readJsonBody(req, limitBytes) {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limitBytes) {
    const error = new Error('request body too large');
    error.code = 'body-too-large';
    throw error;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > limitBytes) {
      const error = new Error('request body too large');
      error.code = 'body-too-large';
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    const error = new Error('empty request body');
    error.code = 'bad-json';
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body is not valid JSON');
    error.code = 'bad-json';
    throw error;
  }
}

/**
 * Keep-alive-aware read of a tiny upstream response body (probe requests): the
 * bytes are discarded and the socket returned to the agent.
 * @param {import('node:http').IncomingMessage} response upstream response.
 * @returns {Promise<void>}
 */
export function drainResponse(response) {
  return new Promise((resolve) => {
    if (response.destroyed || response.readableEnded) {
      resolve();
      return;
    }
    response.on('error', () => resolve());
    response.on('end', () => resolve());
    response.resume();
  });
}
