// Static file serving for the mobile shell mounted at `/m/`. Node builtins only.
//
// Paths are resolved under one root directory, decoded once, and walked as
// segments so `..` can never escape the mount root (both raw `/m/../x` and
// percent-encoded traversal forms are refused). Directory requests render
// their `index.html`; `/m` and `/m/` are the shell root.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sendText } from './http-util.js';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.apk', 'application/vnd.android.package-archive'],
]);

const NO_CACHE_EXTENSIONS = new Set(['.html', '.htm', '.webmanifest']);

/** File types that stay revalidated on every load; everything else is a cacheable asset. */
const MISSING_FILE_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR']);

/** MIME type for one file path (octet-stream fallback). */
export function contentTypeFor(filePath) {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/** Cache policy for one file path. */
export function cacheControlFor(filePath) {
  return NO_CACHE_EXTENSIONS.has(extname(filePath).toLowerCase()) ? 'no-cache' : 'public, max-age=3600';
}

/**
 * Stream one file as a GET/HEAD response.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {string} filePath absolute file path.
 * @param {{cacheControl?: string, notFoundMessage?: string}} [options]
 * @returns {Promise<void>}
 */
export async function serveFile(req, res, filePath, options = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed\n');
    return;
  }
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error?.code)) {
      sendText(res, 404, options.notFoundMessage ?? 'not found');
      return;
    }
    throw error;
  }
  if (!info.isFile()) {
    sendText(res, 404, options.notFoundMessage ?? 'not found');
    return;
  }
  const headers = {
    'content-type': contentTypeFor(filePath),
    'content-length': String(info.size),
    'cache-control': options.cacheControl ?? cacheControlFor(filePath),
    'last-modified': info.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  };
  // Android browsers must treat the package as a download, not a page.
  if (extname(filePath).toLowerCase() === '.apk') {
    headers['content-disposition'] = 'attachment; filename="DSH-Mobile.apk"';
    headers['cache-control'] = 'no-cache';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(filePath), res);
  } catch {
    if (!res.destroyed) res.destroy();
  }
}

/**
 * Serve a request under the `/m` mount from a static root directory.
 *
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {object} options
 * @param {string} options.rootDir static root directory (the package `public/`).
 * @param {string} options.pathname decoded URL pathname beginning with `/m`.
 * @param {string} [options.mount] mount prefix, default `/m`.
 * @returns {Promise<void>}
 */
export async function serveStaticPath(req, res, options) {
  const mount = options.mount ?? '/m';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed\n');
    return;
  }
  if (typeof options.pathname !== 'string' || !options.pathname.startsWith(mount)) {
    sendText(res, 404, 'not found');
    return;
  }
  const rawSuffix = options.pathname.slice(mount.length);
  let decoded;
  try {
    decoded = decodeURIComponent(rawSuffix);
  } catch {
    sendText(res, 400, 'invalid path encoding');
    return;
  }
  if (decoded.includes('\0')) {
    sendText(res, 400, 'invalid path');
    return;
  }
  const wantsDirectory = decoded === '' || /[/\\]$/u.test(decoded);
  const segments = decoded.split(/[/\\]+/u).filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    sendText(res, 403, 'forbidden');
    return;
  }
  let relative = segments.join('/');
  if (wantsDirectory) relative = relative === '' ? 'index.html' : `${relative}/index.html`;
  if (relative === '') relative = 'index.html';

  const root = resolve(options.rootDir);
  const target = resolve(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      const indexPath = join(target, 'index.html');
      if (!indexPath.startsWith(root + sep)) {
        sendText(res, 403, 'forbidden');
        return;
      }
      await serveFile(req, res, indexPath, { notFoundMessage: 'mobile shell not found' });
      return;
    }
  } catch (error) {
    if (MISSING_FILE_CODES.has(error?.code)) {
      sendText(res, 404, 'not found');
      return;
    }
    throw error;
  }
  await serveFile(req, res, target, { notFoundMessage: 'mobile shell not found' });
}
