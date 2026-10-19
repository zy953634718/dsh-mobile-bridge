/**
 * boot-profile-proof.mjs -- boots a DSH_HOME whose `web` profile has the
 * mobile-bridge bundle installed and proves the Cordis plugin activated:
 *  - the plugin must log `mobile-bridge: phone URL ... pin <PIN>` during boot
 *  - GET 127.0.0.1:<bridgePort>/healthz -> 200 {"ok":true}
 *  - GET 127.0.0.1:<bridgePort>/m/ -> 200 mobile shell HTML
 *  - GET 127.0.0.1:<bridgePort>/m/pair/info -> 200 with the configured PIN
 * Then it always stops the DSH process it booted (same process => child.kill).
 *
 *   node tests/harness/boot-profile-proof.mjs --home <DSH_HOME> --port 8898 --bridge-port 7862 [--pin 654321]
 *
 * Prints a single `PROFILE_PROOF_OK {json}` line on success, or
 * `PROFILE_PROOF_FAIL {json}` + exit 1.
 */
import path from 'node:path';
import { start, stop, readLog } from './boot-dsh.mjs';
import { httpRequest } from './phone.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  return fallback;
}

const home = path.resolve(arg('home', ''));
const port = Number(arg('port', '8898'));
const bridgePort = Number(arg('bridge-port', '7862'));
const expectedPin = arg('pin', '');
const bootTimeoutMs = Number(arg('timeout', '120000'));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const result = {
  home,
  dshPort: port,
  bridgePort,
  expectedPin: expectedPin || null,
  tokenLine: null,
  bridgeLogLine: null,
  healthz: null,
  shell: null,
  pairInfo: null,
  ok: false,
  error: null,
};

let booted = false;
try {
  console.log(`# booting DSH_HOME=${home} on 127.0.0.1:${port}`);
  const runtime = await start({ dshHome: home, port, bootTimeoutMs });
  booted = true;
  result.dshPid = runtime.pid;
  result.tokenLine = runtime.tokenUrl ? 'dsh web: token URL present' : null;

  const activation = await waitFor(() => {
    const log = readLog({ dshHome: home });
    const line = log.match(/^mobile-bridge: phone URL (\S*\/m\/)\s+pin (\d+)\s*$/m);
    return line ? { phoneUrl: line[1], pin: line[2] } : null;
  }, 30000, 'mobile-bridge activation log line');
  result.bridgeLogLine = activation;
  const pin = expectedPin || activation.pin;

  const health = await httpRequest(`http://127.0.0.1:${bridgePort}/healthz`, { timeoutMs: 5000 });
  result.healthz = { status: health.statusCode, body: health.text.trim().slice(0, 100) };
  if (health.statusCode !== 200) throw new Error(`bridge /healthz -> ${health.statusCode}`);

  const shell = await httpRequest(`http://127.0.0.1:${bridgePort}/m/`, { timeoutMs: 5000 });
  result.shell = { status: shell.statusCode, bytes: shell.text.length, isShell: /<title>DSH Mobile<\/title>/.test(shell.text) };
  if (shell.statusCode !== 200 || !result.shell.isShell) throw new Error(`bridge /m/ -> ${shell.statusCode} (not the mobile shell)`);

  const info = await httpRequest(`http://127.0.0.1:${bridgePort}/m/pair/info`, { timeoutMs: 5000 });
  const infoBody = (() => { try { return JSON.parse(info.text); } catch { return null; } })();
  result.pairInfo = { status: info.statusCode, pin: infoBody?.pin ?? null, port: infoBody?.port ?? null, targetOrigin: infoBody?.targetOrigin ?? null };
  if (info.statusCode !== 200 || !result.pairInfo.pin) throw new Error(`bridge /m/pair/info -> ${info.statusCode}`);
  if (pin && result.pairInfo.pin !== pin) throw new Error(`pair/info pin ${result.pairInfo.pin} != expected ${pin}`);

  result.ok = true;
} catch (error) {
  result.error = String(error?.message ?? error);
} finally {
  let teardown = null;
  try {
    teardown = booted ? await stop({ dshHome: home, port }) : { stopped: false, reason: 'not booted' };
  } catch (error) {
    teardown = { stopped: false, error: String(error?.message ?? error) };
  }
  result.teardown = teardown;
}
console.log(`${result.ok ? 'PROFILE_PROOF_OK' : 'PROFILE_PROOF_FAIL'} ${JSON.stringify(result)}`);
process.exitCode = result.ok ? 0 : 1;
