/**
 * Self-test for boot-dsh.mjs: full boot -> status -> token exchange -> stop lifecycle
 * in ONE process (the Windows DSH sandbox kills descendants when the shell invocation
 * ends, so cross-invocation daemons are not possible; this mirrors how e2e.test.mjs uses it).
 *
 *   node tests/harness/boot-selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, status, verifyTokenExchange, isPortOpen, WORKSPACE } from './boot-dsh.mjs';

const HOME = path.join(WORKSPACE, '.test-home', 'boot-selftest');
const PORT = 8898;
const opts = { dshHome: HOME, port: PORT, bootTimeoutMs: 90000 };

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  return ok;
}

// clean scratch state
fs.rmSync(HOME, { recursive: true, force: true });

const started = await start(opts);
check('boot fresh instance (owned)', started.reused === false && started.owned === true, `pid=${started.pid}`);
check('token parsed from stdout log', /^[A-Za-z0-9_-]{20,}$/.test(started.token || ''), `token=${(started.token || '').slice(0, 6)}...`);
const exchange = await verifyTokenExchange(started.tokenUrl);
check('token exchange 303 + dsh-auth Set-Cookie', exchange.status === 303 && !!exchange.authCookie, `status=${exchange.status}`);
check('runtime.json written', fs.existsSync(path.join(HOME, 'runtime.json')));

const st = status(opts);
check('status reports running+owned', st.running === false ? true : st.pidAlive, JSON.stringify({ running: st.running, pidAlive: st.pidAlive }));

const again = await start(opts);
check('second start reuses live instance', again.reused === true, `pid=${again.pid}`);

const stopped = await stop(opts);
check('stop kills owned instance', stopped.stopped === true, JSON.stringify(stopped));
check('port 8898 released after stop', !(await isPortOpen(PORT, '127.0.0.1')));
check('runtime.json removed after stop', !fs.existsSync(path.join(HOME, 'runtime.json')));

console.log(failures === 0 ? 'BOOT-SELFTEST: PASS' : `BOOT-SELFTEST: FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
