# E2E test harness — DSH Mobile Bridge

End-to-end verification for `packages/dsh-plugin-mobile-bridge` against an **isolated**
DeepSeek Harness (DSH) web instance. Covers the 9 acceptance items in
`docs/ARCHITECTURE.md` § "E2E acceptance" plus protocol/error-handling extras.

Everything here was built for the DSH Windows sandbox this project runs in, which imposes
three constraints that shaped the design (see [Sandbox constraints](#sandbox-constraints)):

1. only a process's **own direct children** can be killed (taskkill/Stop-Process on other
   processes → access denied; `tasklist`/`wmic` enumeration denied),
2. **piped stdio for grandchildren is EPERM**, so child output is redirected to files,
3. descendants are reaped when the shell invocation ends, so a "daemon" cannot outlive one
   tool call — the whole test lifecycle must run inside **one node process**.

## Quick start (one command)

```powershell
# from the workspace root
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-all.ps1

# also run the install proof first (item 9; mutates only .test-home)
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-all.ps1 -WithInstall
```

It boots/reuses the isolated DSH (`127.0.0.1:8899`, `DSH_HOME=<workspace>\.test-home`),
starts the real bridge plugin (`127.0.0.1:7861`, PIN `123456`), runs the suite, prints a
compact `PASS/FAIL` table and exits nonzero on any failure. Teardown runs in a `finally`
(see [Artifacts](#artifacts) for logs).

## Prerequisites

| Requirement | Value / note |
|---|---|
| OS | Windows 10/11 (tested 2026-10-19) |
| Node.js | v24.x (`node --test --test-isolation=none`); `node` on PATH |
| PowerShell | Windows PowerShell 5.1+ (PS7 also fine) |
| DSH runtime | `D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd` (override with `$env:DSH_CMD` or `-DshCmd`) |
| Isolated home | `<workspace>\.test-home` — **never** `C:\Users\<user>\.dsh` |
| Ports | DSH `8899`, bridge `7861` (tests), install-boot proof `8898` + bridge `7862`, plugin profile default `7860` |

Safety invariants: the harness never targets port `6326` (live desktop DSH), never writes
`C:\Users\<user>\.dsh`, only kills processes it booted (or adopts a healthy 8899 instance
read-only), and records provenance in `.test-home/runtime.json`.

## Files

| File | Purpose |
|---|---|
| `run-all.ps1` | One-command runner (thin wrapper around `harness/run-suite.mjs`). |
| `harness/run-suite.mjs` | Orchestrator: boot DSH → start bridge → `node --test` → PASS/FAIL table → teardown. |
| `e2e.test.mjs` | The 9 acceptance items + extras (`node --test`). Runs against the stack from the env or self-boots. |
| `harness/boot-dsh.mjs` | Isolated DSH lifecycle: `start` / `stop` / `status`; token parsing, `runtime.json`, direct-child teardown. |
| `harness/bridge.mjs` | Starts the plugin's `startBridge()` (port 7861, PIN 123456); `acquireStack()` (in-process or external). |
| `harness/phone.mjs` | Cookie-jar HTTP client (node:http, no redirect following), raw WS upgrade, raw HTTP/1.1 helper. |
| `harness/selfcheck-dsh.mjs` | DSH auth baseline: anon 401, token 303+cookie, replay 200, WS 401/101/403. |
| `harness/boot-selftest.mjs` | Boot harness lifecycle self-test (on port 8898). |
| `harness/boot-profile-proof.mjs` | Boots a DSH_HOME whose profile has the plugin installed; asserts activation. |
| `harness/install-check.ps1` | Install proof (item 9): `dsh plugin add` → dump-config → isolated profile boot; manual fallback with `-ForceManual`. |

## Test mapping (acceptance item → assertion)

| # | Assertion in `e2e.test.mjs` | Evidence |
|---|---|---|
| 1 | `GET /m/` 200 HTML + every referenced local asset (css/js/manifest/icons) 200 | E2E-1 |
| 2 | `POST /m/api/pair {code:PIN}` 200 `{ok,url,expiresInMs}`; token never logged | E2E-2 |
| 3 | token URL → 303 + `dsh-auth` `Set-Cookie` (HttpOnly, SameSite=Strict); cookie replay `GET /` → 200 real DSH HTML; `/m/api/state` → `paired:true` | E2E-3 |
| 4 | unauthenticated `GET /` → 401 (DSH "authentication required"), never GUI HTML | E2E-4 |
| 5 | `/m/pair`, `/m/pair/info`, `/healthz` → 200 from loopback; **403 from the machine LAN IPv4** for all three; forged `X-Forwarded-For` ignored; `isLoopbackAddress` unit cases | E2E-5 |
| 6 | WS `/api/remote.mux` through bridge: cookie + `Origin: <bridge origin>` → **101** <5s; cookie-less → DSH **401** <5s (no hang); absolute-form upgrade target → 400 | E2E-6 |
| 7 | 8 × bad PIN → 401 `bad-pin` (`attemptsLeft` 7…0); 9th → **429 `locked`** + `retryAfterMs` + `Retry-After`; correct PIN while locked still 429 | E2E-7 |
| 8 | mobile shell browser check — **blocked in sandbox** (see limitations), fallback = shell DOM/manifest/app.js contract checks + the full pairing flow at HTTP level | E2E-8 |
| 9 | install proof: `dsh plugin --profile web add <abs pkg>` in `.test-home`, profile manifest dependency + bundle, `--dump-config` row `- id: mobile-bridge`, isolated profile boot activates plugin/PIN | E2E-9 (reads `.test-home/install-proof.json`) |
| X | API misuse JSON errors: 405/415/400/400/404; absolute-form request → 400; `CONNECT` → 405; unknown path proxied | E2E-X |

## Standalone modes

```powershell
# Full suite with self-managed stack (boots DSH+bridge in the test process)
node --test --test-isolation=none --test-reporter=tap tests\e2e.test.mjs

# DSH auth baseline only (fast, no bridge)
node tests\harness\selfcheck-dsh.mjs

# Boot harness lifecycle self-test (scratch home, port 8898; cleans up after itself)
node tests\harness\boot-selftest.mjs

# Isolated DSH lifecycle helpers (CLI; note the process cannot outlive this node process)
node tests\harness\boot-dsh.mjs status --json
node tests\harness\boot-dsh.mjs start --json
node tests\harness\boot-dsh.mjs stop

# Install proof (item 9), idempotent; also writes .test-home/install-proof.json
powershell -NoProfile -ExecutionPolicy Bypass -File tests\harness\install-check.ps1
# manual fallback path (copy package + edit profile package.json; no pnpm)
powershell ... -File tests\harness\install-check.ps1 -ForceManual -ProofFile .test-home\install-proof-manual.json

# The plugin package also ships its own installer (plugin-core): 
powershell -NoProfile -File packages\dsh-plugin-mobile-bridge\install.ps1 -DshHome <isolated-home> -Port <free-port>
```

`--test-isolation=none` is mandatory in this sandbox: `node --test`'s default process
isolation spawns the test file with pipes → `spawn EPERM`.

## Artifacts (`tests/artifacts/`)

| Artifact | Content |
|---|---|
| `e2e-run.log` | Full TAP output of the last `run-all` suite (all EVIDENCE lines). |
| `e2e-summary.json` | Machine-readable summary: tests, PASS/FAIL/SKIP, stack ports, teardown. |
| `e2e-evidence.json` / `.log` | Per-item evidence from the last `node --test` run (also written when self-booting). |
| `install-proof.json` | Item 9 proof: mode (pnpm/manual), install log, dump-config row, boot activation JSON. |
| `install-proof-manual.json` | Same for the `-ForceManual` fallback path (when run). |
| `install-boot-proof.log`, `install-boot-web.log` | Scratch-profile boot proof output and DSH log. |
| `browser-check-FALLBACK.txt` | Why the real-browser check is blocked + manual browser steps. |

## Ports

| Port | Owner / use |
|---|---|
| 8899 | isolated DSH web instance (`DSH_HOME=<workspace>\.test-home`) |
| 7861 | bridge under test (PIN `123456`, fixed for tests only) |
| 8898 | install-proof scratch DSH boot |
| 7862 | install-proof scratch bridge (override via profile `cordis.patch.yml`) |
| 7860 | plugin's profile default; the shared isolated instance may already run a bridge here — do not assume free |
| 6326 | **live desktop DSH — never touched** |

## `.test-home` state after a run

| Path | Meaning |
|---|---|
| `runtime.json` | Last harness-known DSH instance: `{pid, port, token, tokenUrl, owned, launchedAt, launchMode}`. `owned:false` = adopted shared instance (never killed by the harness). |
| `web.log` | DSH stdout/stderr + token line (`dsh web: http://…?token=…`) and plugin activation lines. May be UTF-16LE if written by PowerShell redirection — readers detect the BOM. |
| `profiles/web/` | Isolated DSH profile. After `install-check.ps1`: dependency `dsh-plugin-mobile-bridge` + bundle in `dsh.profile.bundles`, `package.json.bak-*` backups, `.plugin-manager/` pnpm logs. |
| `install-add.log`, `dump-config.log` | Install/dump-config command output (item 9 evidence). |
| `install-check-run.log` | Latest install-check console output. |
| `install-proof.json` | Item 9 proof consumed by E2E-9. |
| `boot-selftest/`, `kill-diag*/`, `install-boot-home/` | Disposable scratch homes; removed by their scripts (leave no running processes). |

## Sandbox constraints (why the harness looks like this)

1. **No cross-process tree kill.** `taskkill /T`, `tasklist`, `wmic` → access denied;
   even `detached` children are reaped when the tool invocation ends. Solution:
   `boot-dsh.mjs` spawns `"DeepSeek Harness.exe" --expose-internals <cli.js> web …` directly
   (`ELECTRON_RUN_AS_NODE=1`, `DSH_HOME` env) and kills it via `child.kill()` — a direct
   child. Wrapping through `cmd.exe` (as `dsh.cmd` does) makes the real listener a grandchild
   that cannot be killed, so it is deliberately not used.
2. **No piped stdio for grandchildren.** DSH stdout/stderr go to a file fd
   (`.test-home/web.log`); token parsed from there. `Invoke-Dsh` in PowerShell writes
   output to files through a generated `.cmd` instead of redirecting pipes (also avoids a
   `ReadToEnd` deadlock when pnpm writes to stderr).
3. **`node --test` needs `--test-isolation=none`** (default isolation spawns with pipes →
   `spawn EPERM`). Consequence: `run-suite.mjs` starts the stack first and passes it to the
   test process through env vars (`E2E_BRIDGE_ORIGIN`, `E2E_PIN`, `E2E_DSH_ORIGIN`).
4. **No `fetch()` in the harness HTTP client.** Node's undici keep-alive + raw net socket +
   `process.exit()` produced a libuv assertion abort (`src/win/async.c:94`, reproduced);
   `phone.mjs` uses `node:http` with `agent:false` instead.

## Known limitations

- **Real-browser check (item 8) is blocked in this sandbox.** `bsk.exe` (browser-skill
  0.3.3) exists but its daemon IPC named pipe is access-denied and headless Chromium/Edge
  launches are terminated immediately under the confined token (confirmed by the Lead).
  Fallback executed instead: shell DOM/manifest/app.js contract checks plus the full
  pairing→cookie→GUI flow at HTTP level; manual browser steps are in
  `tests/artifacts/browser-check-FALLBACK.txt`. Screenshots were not produced by QA.
- **E2E-9 is SKIP until the install proof has run.** Run
  `tests/harness/install-check.ps1` (or `run-all.ps1 -WithInstall`) to write
  `.test-home/install-proof.json`.
- **Adopted shared instance.** When an isolated DSH is already listening on `8899`
  (e.g. another teammate is using it), the harness adopts it: it verifies the token from
  `web.log`, records `owned:false`, and does **not** kill it at teardown.
- **Standalone `boot-dsh.mjs start` cannot outlive the node invocation** under the sandbox;
  use the in-process API (`start`/`stop` from the same script) as the suite does.
- **LAN-IP loopback test** requires a non-internal IPv4 interface. The machine's own LAN
  address is dialed (`192.168.x.y`), and the OS reports it as the socket peer, which
  exercises the real 403 path; without such an interface the test falls back to unit checks.
- `--dump-config`/profile boot require `.test-home/profiles/web/package.json` to be valid
  JSON **without BOM** (DSH uses `JSON.parse`); the scripts always write UTF-8 without BOM.
