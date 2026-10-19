/**
 * bridge.mjs -- launches the plugin's standalone `startBridge()` against the
 * isolated DSH instance for E2E testing.
 *
 * Two modes:
 *  - in-process stack (default): boots/reuses DSH (boot-dsh.mjs) and starts the
 *    real bridge from packages/dsh-plugin-mobile-bridge in THIS process, so a
 *    single node process owns the whole lifecycle and can tear everything down
 *    (sandbox: a process may only kill its own direct children).
 *  - external stack: when E2E_BRIDGE_ORIGIN is set, tests are pure HTTP clients
 *    against a stack started by tests/harness/run-suite.mjs.
 *
 * Exported contract from the package (verified 2026-10-19):
 *   startBridge({ targetOrigin, authenticatedUrl, bindHost, port, publicHost,
 *                 pin, pairAttempts, staticDir, pairPageDir, logger })
 *     -> Promise<{ port, host, pin, urls, targetOrigin, pairPageUrl, close }>
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { start, stop, WORKSPACE } from './boot-dsh.mjs';

export const PKG_DIR = path.join(WORKSPACE, 'packages', 'dsh-plugin-mobile-bridge');
export const STATIC_DIR = path.join(PKG_DIR, 'public');
export const PAIR_PAGE_DIR = path.join(PKG_DIR, 'pair-page');
export const DEFAULT_BRIDGE_PORT = Number(process.env.E2E_BRIDGE_PORT || 7861);
/** Fixed PIN for tests/dev only (never used by a real profile). */
export const TEST_PIN = process.env.E2E_PIN || '123456';
export const PAIR_ATTEMPTS = 8;

/** import the plugin's startBridge (lib/bridge.js, re-exported from lib/plugin.js). */
export async function loadStartBridge() {
  const candidates = [
    path.join(PKG_DIR, 'lib', 'bridge.js'),
    path.join(PKG_DIR, 'lib', 'plugin.js'),
  ];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (typeof mod.startBridge === 'function') return mod.startBridge;
      failures.push(`${candidate}: no startBridge export`);
    } catch (error) {
      failures.push(`${candidate}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`bridge: cannot import startBridge from the plugin package\n${failures.join('\n')}`);
}

/** @returns {Promise<{stack: object}>} */
export async function acquireStack(options = {}) {
  const externalOrigin = process.env.E2E_BRIDGE_ORIGIN;
  if (externalOrigin && !options.forceLocal) {
    const origin = externalOrigin.replace(/\/$/, '');
    const pin = process.env.E2E_PIN || TEST_PIN;
    return {
      external: true,
      origin,
      pin,
      targetOrigin: process.env.E2E_DSH_ORIGIN || null,
      bridgePort: Number(new URL(origin).port),
      logs: [],
      bridge: { port: Number(new URL(origin).port), close: async () => {} },
      dsh: { reused: true, owned: false, port: Number(new URL(origin).port) },
      close: async () => {},
    };
  }
  return startTestStack(options);
}

/** Boot DSH (reuse the isolated 8899 instance when healthy) and the real bridge on 7861. */
export async function startTestStack(options = {}) {
  const bridgePort = options.bridgePort ?? DEFAULT_BRIDGE_PORT;
  const pin = options.pin ?? TEST_PIN;
  const dsh = options.dsh ?? await start({ bootTimeoutMs: options.bootTimeoutMs ?? 90000 });
  const targetOrigin = `http://${dsh.host}:${dsh.port}`;
  const logs = [];
  const logger = {
    info: (message) => logs.push(`INFO ${message}`),
    warn: (message) => logs.push(`WARN ${message}`),
    error: (message) => logs.push(`ERROR ${message}`),
  };
  const startBridge = await loadStartBridge();
  const bridge = await startBridge({
    targetOrigin,
    authenticatedUrl: (base) => `${base}?token=${dsh.token}`,
    bindHost: options.bindHost ?? '0.0.0.0',
    port: bridgePort,
    pin,
    pairAttempts: options.pairAttempts ?? PAIR_ATTEMPTS,
    staticDir: STATIC_DIR,
    pairPageDir: PAIR_PAGE_DIR,
    logger,
  });
  const bridgeOrigin = `http://127.0.0.1:${bridge.port}`;
  let closed = false;
  const stack = {
    external: false,
    dsh,
    bridge,
    targetOrigin,
    origin: bridgeOrigin,
    bridgePort: bridge.port,
    pin,
    logs,
    async close() {
      if (closed) return;
      closed = true;
      try { await bridge.close(); } catch { /* ignore */ }
      try { await stop({ port: dsh.port }); } catch { /* ignore */ }
    },
  };
  return stack;
}

/** first non-internal IPv4 address of this machine (for the non-loopback guard test). */
export function lanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.internal === false) return { address: address.address, name };
    }
  }
  return null;
}
