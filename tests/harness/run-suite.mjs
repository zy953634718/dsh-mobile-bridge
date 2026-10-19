#!/usr/bin/env node
/**
 * run-suite.mjs -- the one-command E2E orchestrator.
 *
 * Why this file exists instead of a plain `node --test` invocation:
 * the DSH Windows sandbox only lets a process kill its OWN direct children and
 * `node --test`'s default process isolation cannot spawn test children at all
 * (piped stdio -> EPERM). So ONE node process owns the full lifecycle here:
 *
 *   1. boot the isolated DSH instance (reuse the healthy 8899 instance if up)
 *   2. start the real bridge plugin on 7861 in-process
 *   3. run `node --test --test-isolation=none tests/e2e.test.mjs` as a child,
 *      with the stack passed through the environment (tests become pure HTTP clients)
 *   4. print a compact PASS/FAIL table parsed from TAP
 *   5. ALWAYS tear down: bridge.close() + DSH stop() (finally)
 *
 * Usage:
 *   node tests/harness/run-suite.mjs
 *   powershell -File tests/run-all.ps1          (thin wrapper)
 *   node --test --test-isolation=none tests/e2e.test.mjs   (self-boot alternative)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startTestStack } from './bridge.mjs';
import { WORKSPACE } from './boot-dsh.mjs';

const ARTIFACTS = path.join(WORKSPACE, 'tests', 'artifacts');
const TEST_FILE = path.join(WORKSPACE, 'tests', 'e2e.test.mjs');
const RUN_LOG = path.join(ARTIFACTS, 'e2e-run.log');
const SUMMARY_FILE = path.join(ARTIFACTS, 'e2e-summary.json');
const SUITE_TIMEOUT_MS = Number(process.env.E2E_SUITE_TIMEOUT_MS || 300000);

fs.mkdirSync(ARTIFACTS, { recursive: true });

const summary = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  stack: null,
  childExit: null,
  tests: [],
  pass: 0,
  fail: 0,
  skip: 0,
  teardown: null,
  logFile: RUN_LOG,
};

function printResult(status, number, name) {
  const tag = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP' }[status];
  const code = String(number).padStart(2, '0');
  console.log(`${tag}  [${code}] ${name}`);
}

function parseTap(log) {
  const tests = [];
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^(ok|not ok) (\d+) - (.*)$/);
    if (!m) continue;
    const numberOfTest = Number(m[2]);
    const directive = /# (SKIP|TODO)\b/.exec(m[3]);
    const name = m[3].replace(/\s+# (SKIP|TODO)\b.*$/, '').trim();
    let status;
    if (m[1] === 'not ok') status = 'FAIL';
    else if (directive && directive[1] === 'SKIP') status = 'SKIP';
    else if (directive && directive[1] === 'TODO') status = 'SKIP';
    else status = 'PASS';
    if (status === 'PASS') pass++;
    else if (status === 'FAIL') fail++;
    else skip++;
    tests.push({ number: numberOfTest, name, status });
  }
  return { tests, pass, fail, skip };
}

let stack = null;
let exitCode = 1;
try {
  console.log('run-suite: starting isolated DSH + mobile-bridge stack (ports 8899 / 7861)...');
  stack = await startTestStack();
  summary.stack = {
    bridgeOrigin: stack.origin,
    bridgePort: stack.bridgePort,
    dshTarget: stack.targetOrigin,
    dshReused: stack.dsh?.reused ?? null,
    dshOwned: stack.dsh?.owned ?? null,
    pin: stack.pin,
  };
  console.log(`run-suite: stack ready bridge=${stack.origin} -> dsh=${stack.targetOrigin} pin=${stack.pin} (dsh reused=${stack.dsh?.reused}, owned=${stack.dsh?.owned})`);
  console.log(`run-suite: node --test --test-isolation=none ${path.relative(WORKSPACE, TEST_FILE)} (log: ${path.relative(WORKSPACE, RUN_LOG)})`);
  console.log('');

  const fd = fs.openSync(RUN_LOG, 'w');
  const child = spawn(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', TEST_FILE], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      E2E_BRIDGE_ORIGIN: stack.origin,
      E2E_PIN: stack.pin,
      E2E_DSH_ORIGIN: stack.targetOrigin,
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  const watchdog = setTimeout(() => {
    console.error(`run-suite: suite timeout after ${SUITE_TIMEOUT_MS}ms, terminating test process`);
    try { child.kill(); } catch { /* ignore */ }
  }, SUITE_TIMEOUT_MS);
  const childExit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error: error.code ?? error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  summary.childExit = childExit;
  summary.stack.bridgeLog = stack.logs.filter((line) => !line.includes('token=')).slice(-20);

  const log = fs.readFileSync(RUN_LOG, 'utf8');
  const parsed = parseTap(log);
  summary.tests = parsed.tests;
  summary.pass = parsed.pass;
  summary.fail = parsed.fail;
  summary.skip = parsed.skip;
  for (const entry of parsed.tests) printResult(entry.status, entry.number, entry.name);

  console.log('');
  console.log(`run-suite: ${parsed.pass} passed, ${parsed.fail} failed, ${parsed.skip} skipped (test process exit=${childExit.code}${childExit.error ? ' error=' + childExit.error : ''})`);
  if (parsed.fail > 0) {
    console.log('run-suite: failure details:');
    const lines = log.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^not ok /u.test(lines[i])) {
        console.log('  ' + lines[i].trim());
        for (const next of lines.slice(i + 1, i + 26)) {
          if (/^\s+(error|code|name):/.test(next) || /^\s+\.\.\./.test(next)) {
            if (/^\s+\.\.\./.test(next)) break;
            console.log('    ' + next.trim());
          }
        }
      }
    }
    console.log(`  full log: ${RUN_LOG}`);
  }
  exitCode = childExit.code === 0 && parsed.fail === 0 ? 0 : 1;
} catch (error) {
  console.error(`run-suite: FATAL ${error?.stack ?? error}`);
  summary.error = String(error?.message ?? error);
  exitCode = 1;
} finally {
  if (stack) {
    const started = Date.now();
    try {
      await stack.close();
      summary.teardown = {
        bridgeClosed: true,
        dshStopped: true,
        dshAdopted: stack.dsh?.owned === false,
        elapsedMs: Date.now() - started,
      };
      console.log(`run-suite: teardown ok (bridge closed${stack.dsh?.owned === false ? '; adopted DSH left running' : '; owned DSH stopped'})`);
    } catch (error) {
      summary.teardown = { bridgeClosed: false, error: String(error?.message ?? error) };
      console.error(`run-suite: teardown error: ${error?.message ?? error}`);
    }
  }
  try {
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n');
    console.log(`run-suite: summary written to ${path.relative(WORKSPACE, SUMMARY_FILE)}`);
  } catch { /* ignore */ }
  console.log('');
  console.log(exitCode === 0 ? 'RESULT: E2E ALL PASS' : 'RESULT: E2E FAILURES (see above)');
  process.exitCode = exitCode;
}
