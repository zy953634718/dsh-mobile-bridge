// Network helpers for the LAN bridge: loopback classification, LAN IPv4
// candidate discovery, and host-authority formatting. Node builtins only.
import os from 'node:os';

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether a textual IPv4 address is loopback (127.0.0.0/8). */
function isLoopbackIPv4(text) {
  if (!IPV4_PATTERN.test(text)) return false;
  const parts = text.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  return parts[0] === 127;
}

/**
 * Strip an IPv6 zone id and the IPv4-mapped `::ffff:` prefix so one address
 * compares as the IPv4 literal the peer actually reaches us from.
 * @param {unknown} address socket address text.
 * @returns {string} normalized text ('' for non-strings).
 */
export function normalizeAddress(address) {
  if (typeof address !== 'string') return '';
  let text = address;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.toLowerCase().startsWith('::ffff:')) text = text.slice(7);
  return text;
}

/**
 * Whether a node:http socket address is the local loopback peer. Accepts
 * 127.0.0.0/8 (incl. mapped form), `::1`, and `localhost` (defensive).
 * @param {unknown} address `req.socket.remoteAddress`.
 * @returns {boolean} true only for loopback peers.
 */
export function isLoopbackAddress(address) {
  const text = normalizeAddress(address);
  if (text === '') return false;
  if (text === '::1' || text.toLowerCase() === 'localhost') return true;
  return isLoopbackIPv4(text);
}

/** Whether a textual IPv4 address is in a private / carrier-grade NAT range. */
export function isPrivateIPv4(text) {
  if (!IPV4_PATTERN.test(text)) return false;
  const parts = text.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, e.g. Tailscale
  return false;
}

/** Preference rank: lower wins. Private LAN first, then CGNAT/VPN, then other. */
function rankIPv4(text) {
  const parts = text.split('.').map(Number);
  const [a, b] = parts;
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 100 && b >= 64 && b <= 127) return 3;
  return 9;
}

/** Interface-name fragments of virtual/auxiliary adapters to rank last. */
const VIRTUAL_INTERFACE_HINTS = [
  /vethernet/i,
  /virtualbox/i,
  /vmware/i,
  /hyper-v/i,
  /loopback/i,
  /wsl/i,
  /teredo/i,
  /isatap/i,
  /bluetooth/i,
  /npcap/i,
  /virtual adapter/i,
];

/** Whether an interface name looks like a virtual/auxiliary adapter. */
function isVirtualInterface(name) {
  return typeof name === 'string' && VIRTUAL_INTERFACE_HINTS.some((hint) => hint.test(name));
}

/**
 * Discover usable LAN IPv4 host candidates for pairing URLs.
 *
 * Non-internal, non-loopback, non-link-local IPv4 addresses are returned,
 * de-duplicated, ordered by preference (private LAN ranges first, virtual
 * adapter names ranked last). An empty list is normal on an offline machine.
 *
 * @param {NodeJS.ProcessEnv} [env] unused; kept for call-site symmetry.
 * @returns {Array<{host: string, interfaceName: string, rank: number}>}
 */
export function lanHostCandidates(env = process.env) {
  void env;
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const seen = new Set();
  const found = [];
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    if (!Array.isArray(addresses)) continue;
    for (const address of addresses) {
      if (address === undefined || address === null) continue;
      const family = address.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (address.internal === true) continue;
      const host = String(address.address ?? '').trim();
      if (host === '' || seen.has(host)) continue;
      if (!IPV4_PATTERN.test(host)) continue;
      if (isLoopbackIPv4(host)) continue;
      if (host.startsWith('169.254.')) continue; // link-local
      if (host.startsWith('0.')) continue;
      seen.add(host);
      const virtual = isVirtualInterface(interfaceName);
      found.push({
        host,
        interfaceName,
        rank: rankIPv4(host) + (virtual ? 50 : 0),
      });
    }
  }
  found.sort((left, right) => left.rank - right.rank || left.host.localeCompare(right.host));
  return found;
}

/**
 * Normalize one host authority for URL building: a bare host, host:port, an
 * IPv6 literal in brackets, or a full http(s) URL. Returns `null` when the
 * value cannot name a usable authority.
 *
 * @param {unknown} value configured `publicHost`.
 * @returns {{hostname: string, authority: string, explicitPort: string}|null}
 */
export function parseHostAuthority(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(text)) {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const authority = url.host;
      if (authority === '') return null;
      return { hostname: url.hostname.replace(/^\[|\]$/gu, ''), authority, explicitPort: url.port };
    }
    const probe = new URL(`http://${text}`);
    if (probe.host === '') return null;
    return { hostname: probe.hostname.replace(/^\[|\]$/gu, ''), authority: probe.host, explicitPort: probe.port };
  } catch {
    return null;
  }
}

/** Format an IP literal for a URL authority (IPv6 keeps its brackets). */
function urlHostText(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Build the pairing/phone URL host list.
 *
 * `publicHost` wins outright (a single candidate). A concrete (non-wildcard)
 * `bindHost` is the only reachable interface, so it becomes the single
 * candidate. Otherwise every discovered LAN IPv4 candidate produces
 * `http://<ip>:<port>`, and when nothing is discovered the loopback address is
 * the sole fallback so the desktop can still open the mobile shell.
 *
 * @param {object} options
 * @param {unknown} [options.publicHost] configured override.
 * @param {string} [options.bindHost] listener bind address.
 * @param {number} options.port actual listening port.
 * @returns {Array<{host: string, authority: string, base: string}>}
 */
export function resolveUrlHosts({ publicHost, bindHost, port } = {}) {
  const override = parseHostAuthority(publicHost);
  if (override !== null) {
    const authority = override.explicitPort !== '' ? override.authority : `${override.authority}:${port}`;
    return [{ host: override.hostname, authority, base: `http://${authority}` }];
  }
  const bound = typeof bindHost === 'string' ? bindHost.trim() : '';
  if (bound !== '' && bound !== '0.0.0.0' && bound !== '::' && bound !== '::0') {
    const host = normalizeAddress(bound);
    const authority = `${urlHostText(host)}:${port}`;
    return [{ host, authority, base: `http://${authority}` }];
  }
  const candidates = lanHostCandidates();
  if (candidates.length === 0) {
    const authority = `127.0.0.1:${port}`;
    return [{ host: '127.0.0.1', authority, base: `http://${authority}` }];
  }
  return candidates.map((candidate) => {
    const authority = `${candidate.host}:${port}`;
    return { host: candidate.host, authority, base: `http://${authority}` };
  });
}
