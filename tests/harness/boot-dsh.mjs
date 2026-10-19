#!/usr/bin/env node
/**
 * Boots / stops / inspects the ISOLATED DSH web instance used by QA.
 *
 *   node tests/harness/boot-dsh.mjs start [--restart] [--port N] [--home DIR] [--json]
 *   node tests/harness/boot-dsh.mjs stop   [--port N] [--home DIR]
 *   node tests/harness/boot-dsh.mjs status [--port N] [--home DIR] [--json]
 *
 * Isolation contract (docs/ARCHITECTURE.md, "Test harness contract"):
 *   - DSH_HOME is ALWAYS <workspace>/.test-home   (never C:\Users\<user>\.dsh)
 *   - listens on 127.0.0.1:8899 (never the live desktop DSH on 6326)
 *   - only processes booted by this module in the CURRENT node process are
 *     killed; a foreign listener on 8899 is never killed -- if it looks like the
 *     shared isolated DSH we "adopt" it (read token from web.log) instead.
 *
 * Two sandbox constraints shaped this design (verified 2026-10-19):
 *   1. Grandchild processes cannot use piped stdio (EPERM). So the DSH child's
 *      stdout/stderr are redirected to a FILE fd (web.log), not a pipe.
 *   2. The Windows sandbox denies tasklist/taskkill and cross-process kills.
 *      A process may reliably terminate only its own direct children, via the
 *      handle from spawn() (`child.kill()`). Therefore the whole E2E lifecycle
 *      (boot -> tests -> teardown) must run inside ONE node process; run
 *      boot/stop from the same process. DSH is spawned directly
 *      (DeepSeek Harness.exe with ELECTRON_RUN_AS_NODE=1, as dsh.cmd does) so
 *      it IS a direct child; wrapping through cmd.exe would leak.
 *
 * The child process tree of a sandboxed shell invocation is reaped by the
 * harness when that invocation ends, so a crashed run cannot leak a DSH
 * process past the end of the command that started it.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(__dirname, '..', '..');

export const DEFAULTS = {
  dshHome: path.join(WORKSPACE, '.test-home'),
  host: '127.0.0.1',
  port: 8899,
  dshCmd: process.env.DSH_CMD || 'D:\\soft\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd',
};

export function paths(opts = {}) {
  const dshHome = opts.dshHome || DEFAULTS.dshHome;
  return {
    dshHome,
    runtimeFile: path.join(dshHome, 'runtime.json'),
    logFile: path.join(dshHome, 'web.log'),
  };
}

/** live children booted by THIS process: pid -> ChildProcess */
const liveChildren = new Map();

const ANSI = /\x1b\[[0-9;]*m/g;
const TOKEN_RE = /dsh web:\s*(http:\/\/\S+?\/\?token=([^\s&#]+))/;
const AUTH_COOKIE_RE = /^(dsh-auth-[\w.-]+)=/i;

function readRuntime(opts) {
  const p = paths(opts);
  try { return JSON.parse(fs.readFileSync(p.runtimeFile, 'utf8')); } catch { return null; }
}
function writeRuntime(opts, data) {
  const p = paths(opts);
  fs.mkdirSync(p.dshHome, { recursive: true });
  fs.writeFileSync(p.runtimeFile, JSON.stringify(data, null, 2) + '\n');
}
function removeRuntime(opts) {
  try { fs.unlinkSync(paths(opts).runtimeFile); } catch {}
}
/** read web.log; tolerates UTF-16LE output produced by PowerShell redirection. */
export function readLog(opts = {}) {
  try {
    const buf = fs.readFileSync(paths(opts).logFile);
    const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.toString('utf16le') : buf.toString('utf8');
    return text.replace(/^\uFEFF/, '').replace(ANSI, '');
  } catch { return ''; }
}
function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** is something accepting TCP connections on host:port ? */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * pid owning a listening TCP port, via netstat.
 * NOTE: piped stdio is EPERM in the sandbox, so stdout goes to a temp FILE.
 */
export function listenPid(port) {
  const tmp = path.join(paths().dshHome, `netstat-${process.pid}.txt`);
  let text = '';
  try {
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      spawnSync('netstat', ['-ano', '-p', 'TCP'], { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    } finally { fs.closeSync(fd); }
    text = fs.readFileSync(tmp, 'utf8');
  } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch {} }
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

/** exchange a launch token: expect 303 + dsh-auth Set-Cookie. */
export async function verifyTokenExchange(tokenUrl) {
  const { httpRequest } = await import('./phone.mjs');
  const res = await httpRequest(tokenUrl, { method: 'GET' });
  const setCookies = res.setCookies;
  const authCookie = setCookies.find((c) => AUTH_COOKIE_RE.test(c)) || null;
  return {
    ok: res.statusCode === 303 && !!authCookie,
    status: res.statusCode,
    location: res.location,
    authCookie,
  };
}

/** Recover the launch token from web.log (last printed `dsh web:` line). */
export function tokenFromLog(opts = {}) {
  const log = readLog(opts);
  const all = [...log.matchAll(new RegExp(TOKEN_RE.source, 'g'))];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { tokenUrl: m[1], token: m[2] };
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

/**
 * dsh.cmd launches:  "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "...cli.js" %*
 * Resolve those two relative paths so we can spawn the DSH process directly.
 */
export function resolveLaunch(dshCmd = DEFAULTS.dshCmd) {
  const dir = path.dirname(dshCmd);
  let text = '';
  try { text = fs.readFileSync(dshCmd, 'utf8'); } catch {}
  const exeM = text.match(/%~dp0([^"\r\n]*?DeepSeek Harness\.exe)/i);
  const cliM = text.match(/%~dp0([^"\r\n]*?\.js)/i);
  const exe = exeM ? path.resolve(dir, exeM[1].trim()) : null;
  const cliJs = cliM ? path.resolve(dir, cliM[1].trim()) : null;
  // NOTE: cliJs lives INSIDE app.asar, which plain node's fs cannot stat (only the
  // Electron runtime resolves asar paths), so only the exe is probed here.
  const direct = !!(exe && cliJs && fs.existsSync(exe));
  return { dshCmd, exe, cliJs, direct };
}

/** terminate a pid that THIS process spawned (or a direct child of it). */
async function terminate(pid, { timeoutMs = 10000 } = {}) {
  const child = liveChildren.get(pid);
  if (child) {
    let exited = false;
    child.once('exit', () => { exited = true; });
    try { child.kill(); } catch {}
    const ok = await waitFor(() => exited || child.exitCode !== null || child.signalCode !== null,
      { timeoutMs, intervalMs: 100, label: `child ${pid} exit` }).then(() => true).catch(() => false);
    liveChildren.delete(pid);
    return { ok, how: 'child.kill' };
  }
  try {
    process.kill(pid);
    return { ok: true, how: 'process.kill' };
  } catch (e) {
    return { ok: e.code === 'ESRCH', how: `process.kill:${e.code}`, note: e.code === 'EPERM' ? 'not our child under sandbox; cannot kill cross-process' : undefined };
  }
}

export function status(opts = {}) {
  const rt = readRuntime(opts);
  return {
    running: false,
    owned: !!rt?.owned,
    port: rt?.port ?? (opts.port ?? DEFAULTS.port),
    host: rt?.host ?? (opts.host ?? DEFAULTS.host),
    pid: rt?.pid ?? null,
    pidAlive: rt ? pidAlive(rt.pid) : false,
    hasRuntime: !!rt,
    startedAt: rt?.startedAt || null,
    tokenUrl: rt?.tokenUrl || null,
    launchMode: rt?.launchMode || null,
    runtimeFile: paths(opts).runtimeFile,
    logFile: paths(opts).logFile,
  };
}

export async function start(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const p = paths(o);
  fs.mkdirSync(p.dshHome, { recursive: true });

  // 1. reuse the recorded running instance if it is actually healthy
  const existing = readRuntime(o);
  if (existing && existing.tokenUrl && (existing.owned ? pidAlive(existing.pid) || (await isPortOpen(existing.port ?? o.port)) : true)) {
    const v = await verifyTokenExchange(existing.tokenUrl).catch(() => null);
    if (v?.ok) {
      return { reused: true, adopted: !existing.owned, ...existing, tokenExchange: v };
    }
  }
  // 2. stale *owned* instance -> terminate it (only possible from the booting process)
  if (existing && existing.owned && !opts.keepStale) {
    await terminate(existing.pid);
    removeRuntime(o);
  }
  // 3. port occupancy by a foreign/unknown process: adopt if it is a working isolated DSH
  if (await isPortOpen(o.port, o.host)) {
    const recovered = tokenFromLog(o);
    if (recovered) {
      const v = await verifyTokenExchange(recovered.tokenUrl).catch(() => null);
      if (v?.ok) {
        const pid = listenPid(o.port);
        const adopted = {
          pid,
          port: o.port,
          host: o.host,
          token: recovered.token,
          tokenUrl: recovered.tokenUrl,
          startedAt: new Date().toISOString(),
          adopted: true,
          owned: false,
          launchMode: 'adopted',
          dshHome: o.dshHome,
          dshCmd: o.dshCmd,
          logFile: p.logFile,
          runtimeFile: p.runtimeFile,
          note: 'adopted: an isolated DSH was already listening on this port (token recovered from web.log); this harness did NOT start it and will not kill it',
        };
        writeRuntime(o, adopted);
        return { reused: true, ...adopted, tokenExchange: v };
      }
    }
    throw new Error(`port ${o.host}:${o.port} is in use by an unidentified process (pid ${listenPid(o.port)}); refusing to kill it. Stop it manually or use another --port.`);
  }

  // 4. boot a fresh instance (direct spawn => reliable child.kill teardown)
  if (opts.restart) removeRuntime(o);
  const launch = resolveLaunch(o.dshCmd);
  fs.writeFileSync(p.logFile, '');
  const fd = fs.openSync(p.logFile, 'a');
  const env = { ...process.env, DSH_HOME: o.dshHome };
  let child;
  let launchMode;
  try {
    if (launch.direct) {
      launchMode = 'direct-electron-node';
      child = spawn(launch.exe, ['--expose-internals', launch.cliJs, 'web', '--no-open', '--host', o.host, '--port', String(o.port)], {
        cwd: WORKSPACE,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } else {
      // fallback (may leak on sandboxed hosts: cmd.exe wrapper cannot be killed as a tree)
      launchMode = 'cmd-wrapper';
      child = spawn(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `${o.dshCmd} web --no-open --host ${o.host} --port ${o.port}`],
        { cwd: WORKSPACE, env, stdio: ['ignore', fd, fd], windowsHide: true });
    }
  } finally { fs.closeSync(fd); }
  liveChildren.set(child.pid, child);

  // surface early crashes instead of polling until timeout
  let earlyExit = null;
  child.once('exit', (code, signal) => { earlyExit = { code, signal }; liveChildren.delete(child.pid); });
  child.once('error', (e) => { earlyExit = { error: e.code }; });

  try {
    const recovered = await waitFor(() => {
      if (earlyExit) throw new Error(`dsh process exited early (${JSON.stringify(earlyExit)}); log:\n${readLog(o).split(/\r?\n/).slice(-15).join('\n')}`);
      return tokenFromLog(o);
    }, { timeoutMs: o.bootTimeoutMs || 90000, label: `DSH "dsh web:" token line in ${p.logFile}` });

    const v = await waitFor(async () => {
      if (earlyExit) throw new Error(`dsh process exited early (${JSON.stringify(earlyExit)})`);
      const r = await verifyTokenExchange(recovered.tokenUrl);
      return r.ok ? r : false;
    }, { timeoutMs: o.readyTimeoutMs || 30000, label: 'timed 303 + Set-Cookie token exchange' });

    const rt = {
      pid: child.pid,
      port: o.port,
      host: o.host,
      token: recovered.token,
      tokenUrl: recovered.tokenUrl,
      startedAt: new Date().toISOString(),
      owned: true,
      adopted: false,
      launchMode,
      dshHome: o.dshHome,
      dshCmd: o.dshCmd,
      logFile: p.logFile,
      runtimeFile: p.runtimeFile,
    };
    writeRuntime(o, rt);
    return { reused: false, ...rt, tokenExchange: v };
  } catch (e) {
    await terminate(child.pid);
    removeRuntime(o);
    throw e;
  }
}

export async function stop(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rt = readRuntime(o);
  const port = rt?.port ?? o.port;
  const busy = await isPortOpen(port, o.host);
  if (!rt) {
    if (busy) return { stopped: false, reason: `port ${port} in use (pid ${listenPid(port)}) but no runtime.json; refusing to kill an unowned process` };
    return { stopped: false, reason: 'no running instance recorded' };
  }
  if (rt.adopted || rt.owned === false) {
    return { stopped: false, reason: `instance pid ${rt.pid} was adopted, not owned; leaving it running` };
  }
  const t = await terminate(rt.pid);
  const freed = await waitFor(async () => !(await isPortOpen(port, o.host)), { timeoutMs: 15000, label: `port ${port} release` })
    .then(() => true).catch(() => false);
  if (freed) removeRuntime(o);
  return { stopped: freed, port, pid: rt.pid, kill: t, reason: freed ? `terminated via ${t.how}` : `kill via ${t.how} did not release port ${port}` };
}

async function main(argv) {
  const cmd = (argv[0] || 'status').toLowerCase();
  const opts = { restart: argv.includes('--restart') };
  const json = argv.includes('--json');
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--home') opts.dshHome = path.resolve(argv[++i]);
    else if (a.startsWith('--home=')) opts.dshHome = path.resolve(a.slice(7));
  }
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
    console.error('invalid --port'); return 2;
  }
  try {
    if (cmd === 'start' || cmd === 'ensure') {
      const r = await start(opts);
      console.log('BOOT_OK ' + JSON.stringify({
        ok: true, reused: r.reused, owned: r.owned !== false, pid: r.pid, port: r.port,
        tokenUrl: r.tokenUrl, token: r.token, tokenExchangeStatus: r.tokenExchange?.status,
        launchMode: r.launchMode, logFile: r.logFile, runtimeFile: paths(opts).runtimeFile,
      }));
      console.log('NOTE standalone start cannot outlive this node process under the sandbox job; use start() in-process for the test suite');
      return 0;
    }
    if (cmd === 'stop') {
      const r = await stop(opts);
      console.log('STOP ' + JSON.stringify(r));
      return r.stopped || /no running|already|adopted|not owned/.test(r.reason || '') ? 0 : 2;
    }
    if (cmd === 'status') {
      const rt = readRuntime(opts);
      const st = status(opts);
      if (rt?.tokenUrl) {
        try {
          const v = await verifyTokenExchange(rt.tokenUrl);
          st.tokenExchange = { ok: v.ok, status: v.status };
          st.running = v.ok && (pidAlive(rt.pid) || rt.owned === false);
        } catch (e) { st.tokenExchange = { ok: false, error: e.message }; }
      }
      console.log(JSON.stringify(st, null, json ? 0 : 2));
      return st.running ? 0 : 1;
    }
    console.error(`unknown command ${cmd}; use start|stop|status`);
    return 2;
  } catch (e) {
    console.error(`BOOT_FAIL ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
