# plugin-core selftest

本目录是 `dsh-plugin-mobile-bridge` **插件核心**（proxy / pairing / routes / Cordis 启动）的
自测脚本与证据，使用真实隔离的 DSH Web 实例验证。所有脚本只读取 `.test-home` 与
DSH 的启动日志，不会写入 DSH、不会重启它，也不会使用正在使用的桌面 DSH（端口 6326）。

## 1. `bridge-selftest.mjs` — 独立桥接器全量检查（35 项）

前提：隔离 DSH Web 实例运行在 `http://127.0.0.1:8899`（见仓库 `tests/` 的 harness）。
token 默认自动从 `<workspace>/.test-home/web.log` 读取（兼容 UTF-16LE 日志），
也可显式传入。

```powershell
# 默认目标 127.0.0.1:8899；staticDir 自动使用真实 public/（不存在时回退 fixtures）
node packages/dsh-plugin-mobile-bridge/selftest/bridge-selftest.mjs

# 显式参数
node .../selftest/bridge-selftest.mjs --target http://127.0.0.1:8899 --token <launchToken>
node .../selftest/bridge-selftest.mjs --static <dir> --verbose
```

覆盖范围：

- Cordis `apply()` 在 `webServer.getOrigin()` 前几次抛错时的重试启动路径（fake context）；
- `/m/`、`/m`、静态资源、HEAD、404、405、路径穿越（`%2e%2e` 变体）；
- `/m/api/state`（未配对 `paired:false` / Cookie 重放后 `paired:true`，不泄漏 token）；
- `/m/api/pair`：错误 PIN×N→401、随后 429 锁定、非 JSON 415、坏 JSON 400、正确 PIN 返回带 token 的 URL；
- 代理：token URL→303+Set-Cookie、Cookie 重放→真实 DSH index（含 `__DSH_BOOT__` 与注入）、
  未认证 `/`→401/303；
- `/m/pair`、`/m/pair/info`、`/healthz` 仅回环；从 LAN IP 访问→403；
- WebSocket `/api/remote.mux`：带 Cookie + 浏览器 Origin→101（验证 Origin 重写），无 Cookie→DSH 401，不挂起；
- 拒绝绝对形式 URL/CONNECT；不可达上游 502、静默上游 504；未知 `/m/api/*` 404；`close()` 释放端口；
- 启动日志格式、PIN 行、桌面配对页行，且任何日志都不出现 DSH token。

退出码：全部通过为 `0`，有失败为 `1`，无法找到 token 为 `2`。每次运行覆盖本目录
`bridge-selftest.log`（可保留作为证据）。

## 2. `integration-check.mjs` — 真实 profile 启动后的端到端检查（10 项）

用于验证「安装 → 重启 DSH → 插件真的在 profile 里启动」这条链路（与 `install.ps1` 配合）。
前提：一个隔离 `DSH_HOME`，已安装本 bundle，并以该 home 启动 DSH（桥接端口按配置，
例如 7862），日志文件可读。

```powershell
# 1) 用 install.ps1 装进隔离 home（示例）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web -DshHome <临时 home>
# 2) 以该 home 启动 DSH（建议单独端口）
$env:DSH_HOME = '<临时 home>'
dsh.cmd web --no-open --host 127.0.0.1 --port 8898 *> <临时 home>\web.log
# 3) 运行检查
node .../selftest/integration-check.mjs --bridge http://127.0.0.1:7862 --log <临时 home>\web.log --pin 246810
```

覆盖：真实 `public/` 外壳、state、桌面配对页/PIN、配对 URL、token 交换 303+Cookie、
Cookie 重放得到真实 GUI、GUI 内注入的「手机连接」按钮、未认证访问被拦截、
WebSocket 101、错误 PIN 401。

## `fixtures/public/`

最小的静态外壳 fixture：当 `public/` 还没有 `index.html` 时（例如只验证核心插件），
`bridge-selftest.mjs` 用它验证静态路由；一旦手机端外壳就位，自动改用真实 `public/`。
