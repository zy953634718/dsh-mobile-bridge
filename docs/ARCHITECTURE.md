# DSH Mobile Bridge — Architecture & Contracts

Status: implemented and verified (v0.1). This document is the contract the implementation was
built against; the verification results are recorded in the top-level `README.md` and
`docs/media/VERIFY.md`.

## Goal

A DeepSeek Harness (DSH) **bundle plugin** that exposes the running desktop DSH Web GUI to a
phone on the same LAN with safe pairing/authentication, plus a **mobile web app** (PWA-style
shell) served by that plugin that wraps the real GUI in a phone-optimized experience.

Non-goals (v1): reimplementing DSH chat UI, cloud relay/TURN, Android/iOS native binaries,
multi-user accounts, QR-code rendering (stretch), HTTPS/TLS termination.

## Core idea (verified against DSH 0.2.1-rc.2 internals)

DSH's Web GUI is a normal HTTP app bound to loopback (`http://127.0.0.1:6326` on this desktop).
Its browser auth works like this (verified in `dsh-client-connection` host lib):

1. Process launch token: `GET /?token=<launchToken>` mints an `HttpOnly; SameSite=Strict`
   cookie bound to the request's **Host authority**, then `303 Location: ./`.
2. Every later request carries that cookie; Host authority must match the signed cookie.
3. `ctx.connection.authenticatedUrl(baseUrl)` (Host Cordis service) appends the current
   process launch token to any URL — this is how our plugin gets a login URL without
   knowing shell history.
4. Static assets are public; only the index and `/api` need auth. No `X-Frame-Options`/CSP
   frame blocking, so the GUI can be embedded in a same-origin iframe.

Therefore the plugin **reverse-proxies the DSH GUI through its own LAN listener** and keeps a
single public origin (the plugin's origin). The proxy rewrites `Host`/`Origin`/`Referer` to the
loopback DSH authority, so DSH's trust fence and cookie validation keep working while the
phone's browser stores the cookie for the plugin's origin. The mobile shell lives on the same
origin at `/m/`, so it can iframe `/` same-origin and inject mobile CSS.

```
 phone browser (LAN)                     desktop DSH process (host Cordis tree)
 ───────────────────                     ──────────────────────────────────────
 http://192.168.x.y:7860/  ──proxy──▶    http://127.0.0.1:6326/  (real GUI)
 http://192.168.x.y:7860/m/─shell──┐
                                   └── iframe(same-origin) ──▶ /
 pairing: PIN on desktop page +  POST /m/api/pair
```

## Components / write scopes

| Component | Path | Owner |
|---|---|---|
| Bundle + host plugin + proxy + pairing + desktop pair page + install script | `packages/dsh-plugin-mobile-bridge/{package.json,cordis.patch.yml,lib/,pair-page/,install.ps1}` | plugin-core |
| Mobile shell PWA (served as `/m/*`) | `packages/dsh-plugin-mobile-bridge/public/` | mobile-app |
| E2E harness + tests + verification scripts | `tests/`, `.test-home/` | qa-integration |
| Spec, top-level README, integration/final verification | `docs/`, `README.md` | Lead |

All paths are under the session workspace
`C:\Users\95363\Documents\deepseek-harness\default-workspace`.

## Bundle package contract

`packages/dsh-plugin-mobile-bridge/package.json`:

```json
{
  "name": "dsh-plugin-mobile-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/plugin.js",
  "exports": { ".": "./lib/plugin.js", "./package.json": "./package.json", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- No npm dependencies and no peerDependencies (zero-import Node builtins only) so that
  `dsh plugin --profile <p> add <abs path>` passes DSH's compatibility check offline.
- `cordis.patch.yml` inserts exactly one row:
  `- insert: [{ id: mobile-bridge, name: dsh-plugin-mobile-bridge, config: {...} }]`.
- `lib/plugin.js` exports `name`, `inject: ['webServer', 'connection']`, `apply(ctx, config)`.
  Must be defensive: if `webServer`/`connection` are missing, log and return (never throw during
  profile boot). Server start must be wrapped so an EADDRINUSE etc. logs and does not crash DSH.

## Plugin behavior contract

Config (all optional, defaults shown):

```yaml
enabled: true
bindHost: 0.0.0.0        # own listener; wildcard allowed here (unlike DSH webserver)
port: 7860               # 0 => OS-assigned
publicHost: null         # override host used in pairing URLs (e.g. tailscale name)
pin: null                # fixed PIN for tests/dev only; null => random 6 digits per process
pairAttempts: 8          # failed attempts per IP per 10 min before 429
```

Startup:
1. `targetOrigin = ctx.webServer.getOrigin()` (e.g. `http://127.0.0.1:6326`). If unavailable: log, no server.
2. Start `node:http` server on `bindHost:port`; use `server.listen(port, bindHost)`.
3. Log one line: `mobile-bridge: phone URL http://<lan-ip>:<port>/m/  pin <PIN>` (console.log).
4. Resolve LAN IPv4 candidates via `os.networkInterfaces()`; prefer private ranges
   (192.168/10/172.16-31), skip link-local/loopback/virtual adapters when possible; config
   `publicHost` wins. Pairing URLs per candidate.
5. `ctx.effect(() => { ...start...; return () => closeServer(); })` so plugin unload disposes.

HTTP routes (plugin's own listener):

| Route | Auth | Behavior |
|---|---|---|
| `GET /m`, `GET /m/`, `GET /m/*` | none (static shell) | Serve files from `public/`, with `/m` + `/m/` → `index.html`. Correct content types, no path traversal. Cache-Control: no-cache for html, 1h for assets. |
| `GET /m/api/state` | none | JSON `{ ok, paired: bool, host, dshUrl: "/", pinRequired: bool }`. `paired` = request already carries a valid DSH cookie (proxy a cheap authenticated probe: forward `GET /` with request cookie; 200 => paired; 401/303 => false). |
| `POST /m/api/pair` | none | Body JSON `{ code }`. Validate against current PIN (constant-time) with per-IP attempt limit (429 after limit, 30s cool-down). Success: `{ ok:true, url: "<publicOrigin>/?token=<launchToken>", expiresInMs }` — built with `ctx.connection.authenticatedUrl(publicOrigin + "/")`. Failure: `{ ok:false, error:"bad-pin" }` 401. |
| `GET /m/pair` | **loopback socket only** (else 403) | Desktop pairing page (`pair-page/index.html`): shows LAN URL(s), current PIN, copy button, instructions. Inline HTML/CSS/JS only (no external requests). Poll `GET /m/pair/info` every 5s to refresh pairing URLs. |
| `GET /m/pair/info` | loopback only | JSON `{ pin, urls: [string], port, targetOrigin }`. |
| `GET /healthz` | loopback only | `{ ok: true }`. |
| everything else (incl. `/api`, `/plugins/*`, WS `/api/remote.mux`) | pass-through | Reverse proxy to `targetOrigin` preserving method/body/headers/status/streaming. Rewrite `Host` → target authority; when request has `Origin`/`Referer`, rewrite to target origin. Keep `Cookie` header unchanged (DSH cookie name/signature stays valid because Host is rewritten). Must support WebSocket upgrade for `/api/remote.mux` (raw TCP pipe after 101 through a `net.connect` to target). |

The tokenised `url` returned by `/m/api/pair` navigates the phone to `<plugin-origin>/?token=...`;
the proxy forwards it to DSH, DSH sets the cookie on the plugin origin and 303s to `./`; from
then on the phone is authenticated for both `/` and `/m/`.

Verified during implementation against the isolated DSH instance: token exchange through a
Host-rewriting proxy returns 303 + `dsh-auth-*` cookie; cookie replay yields 200 real DSH index
HTML; and the `/api/remote.mux` WebSocket upgrade returns 101 only when its `Origin` header is also
rewritten to the target origin (unchanged public origin => 403). The proxy rewrites Origin/Referer
on the upgrade path too, and never forwards undefined header values.

Security invariants:
- PIN page (`/m/pair`, `/m/pair/info`) must never be reachable from non-loopback peers.
- PIN comparison constant-time; attempt window enforced.
- Pairing response token is the DSH launch token: treat as secret, never log it.
- Don't expose arbitrary internet proxies: only forward to `targetOrigin`; reject absolute-form
  request URLs and `CONNECT`. Only listen on the configured port.
- Do not modify or restart the running DSH process or its profile from plugin code.

## Mobile shell contract (`public/`)

Served at `/m/`; all asset URLs relative (`./app.js`) so it works under `/m/`. Single-page
vanilla JS (no build step, no external CDNs). Files (names flexible):

- `index.html` — shell: top status bar (title + status dot + reload), main area, pairing view,
  settings/diagnostics drawer.
- `app.js`, `app.css` — logic/styles. Decide view:
  - call `GET /m/api/state`; if `paired` → show `<iframe src="/">` full-screen (same origin),
    inject mobile adaptation CSS into `iframe.contentDocument` when same-origin is available
    (on load, retry briefly); handle iframe 401/auth page: detect document text containing
    `authentication required` → show pairing view.
  - if not paired → pairing view: PIN input (numeric, 6 digits), "pair" button, POST
    `/m/api/pair`, then set `location.href = url` (full login navigation). After redirect it
    lands back on `/` — show a warning hint: instruct that after login they should return to
    `/m/` (or auto-return by the shell's pairing view "I am logged in" button). Better: after
    pairing success, navigate the TOP window to url; DSH redirects to `/`; the shell cannot
    auto-come-back. Provide `/m/` bookmark + manifest start_url. (v1 acceptable: pairing page
    says "登录成功后请回到手机应用"; also try `window.open`? no.)
  - static analysis: the shell may instead use a hidden iframe for the token URL to set the
    cookie without leaving the shell! Token URL inside iframe is same-origin (plugin origin)
    and its 303 + Set-Cookie applies to the browser cookie jar; then shell reloads iframe `/`.
    Verify with real browser; prefer this flow (no navigation away). Keep top-level nav fallback.
- Mobile adaptation CSS (injected into the DSH iframe): safe-area insets, prevent body
  horizontal overflow, ensure `height: 100dvh`, make composer stick above keyboard, hide
  desktop-only chrome only if verified safe (QA/UI check via browser-skill); at minimum set
  viewport/meta and font-size to avoid iOS zoom, and `.dsh-mobile` class hooks.
- PWA bits: `manifest.webmanifest` (name "DSH Mobile", start_url `/m/`, display standalone,
  theme/background colors, 192/512 icons), icons under `./icons/`, `<link rel=manifest>`,
  apple-touch-icon, theme-color meta. Service worker optional (LAN HTTP is not a secure context
  so SW may not register; guard with try/catch and do not rely on it).
- Must work in mobile Chromium & Safari; no frameworks; no TypeScript; no build.

## Test harness contract

Isolated DSH web instance (already proven):

```powershell
$env:DSH_HOME = "<workspace>\.test-home"          # never the real C:\Users\95363\.dsh
& "D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd" web --no-open --host 127.0.0.1 --port 8899
# stdout line: dsh web: http://127.0.0.1:8899/?token=<TOKEN>
```

Standalone bridge harness (no Cordis) — plugin exports an internal test-friendly starter:

```js
// packages/dsh-plugin-mobile-bridge/lib/plugin.js also exports:
export function startBridge(options) // -> { port, close(), pin, urls }
```

`options` = plugin config + `targetOrigin`, `authenticatedUrl(base)`, `staticDir`, `pairPageDir`,
`logger`. QA uses this to boot the proxy against the isolated DSH and drive it with plain HTTP.

E2E acceptance (must all pass):

1. `GET http://127.0.0.1:<bridge>/m/` → 200 HTML (mobile shell), assets load.
2. `POST /m/api/pair {"code":"<pin>"}` → 200 JSON with tokenised URL.
3. GET that token URL through bridge → 303 + Set-Cookie; replay cookie to bridge `GET /` → 200
   DSH index HTML; `GET /m/api/state` → `paired:true`.
4. Unauthenticated `GET /` through bridge → 401 or redirect, not GUI.
5. `GET /m/pair` from LAN IP simulation → 403; from 127.0.0.1 → 200.
6. WebSocket `/api/remote.mux` upgrade through bridge reaches DSH (expect 101 with valid cookie,
   or DSH's 401 without; verify headers/raw pipe, no hang).
7. Wrong PIN × limit → 429.
8. Mobile shell in browser (browser-skill Chromium, mobile viewport): pairing view renders,
   after injecting cookie/login the DSH GUI loads inside iframe, no console errors, screenshot.
9. `dsh plugin --profile web add "<abs path to package>"` in the isolated DSH_HOME succeeds,
   boot with that profile activates `mobile-bridge` row (or document exact blocker + fallback
   install script that edits profile files).

## Verified DSH internals reference (do not re-derive)

- CLI: `D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd` (`dsh [--profile] <name> ...`,
  `dsh plugin --profile <name> add|remove <pnpm args>`, `--patch <file>` overlay).
- Bundle package format: `package.json.dsh.bundle.patch` → `cordis.patch.yml`; patch entries
  `- insert: [{id, name, config}]`; patch rows replace whole `config` by id.
- Real desktop Web GUI origin: `http://127.0.0.1:6326` (env `DSH_WEB_URL`); DSH profile at
  `C:\Users\95363\.dsh\profiles\desktop` (outer workspace; read-only for teammates).
- `dsh-host-webserver` service: `ctx.webServer.getOrigin()`, `.host`, `.port`, `.register(route)`.
- `dsh-client-connection` host service: `ctx.connection.authenticatedUrl(baseUrl)`,
  `.authorizeIndex(req,res)`, `.browserPeer`. Cookie: `dsh-auth-<b64url(sha256(authority))>`;
  303 to `./`; requires Host authority match; static assets public; index auth-gated.
- DSH reference sources (package docs and bundled lib JS) were extracted from
  `D:\soft\dsh\resources\app.asar` during development with a throwaway ASAR reader; that scratch
  extraction is not part of the deliverable.
- Do not run writes against `C:\Users\95363\.dsh` or the running desktop DSH process.

## Workflow rules

- Write only inside your assigned scope. Report interface changes to Lead instead of editing
  another owner's files.
- Keep every file ASCII unless Chinese text is required (README/UI copy may be Chinese).
- No network installs; everything is hand-written static code.
- Tests: `node --test` (built-in) under `tests/`.
