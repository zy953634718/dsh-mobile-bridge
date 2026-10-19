# dsh-plugin-mobile-bridge

把正在运行的 **DeepSeek Harness (DSH) Web GUI** 安全地暴露到同一局域网的手机浏览器上：
插件在电脑上启动一个 LAN 监听器，把发往 `/` 的请求反向代理给 DSH 的回环 Web 服务，
并把手机端 UI（`/m/`）与 PIN 配对流程放在同一个源上。手机无需安装任何 App，
配对后即可在手机浏览器里使用完整的桌面 DSH 界面。

- **零 npm 依赖**：只用 Node.js 内置模块（`node:http` / `node:net` / `node:crypto` / `node:os` …），
  离线可安装、可审阅。
- **一个公开源**：手机只访问插件监听端口；`/m/` 是手机外壳，`/` 是反向代理后的真实 GUI，
  两者同源，因此外壳可以安全地用同源 iframe 嵌入 GUI 并注入移动端样式。
- **PIN 配对**：6 位随机 PIN（每次 DSH 进程启动重新生成），只在桌面本机可见；
  配对成功后手机拿到带 DSH 进程 token 的登录 URL，由 DSH 自行下发 HttpOnly Cookie。
- **WebSocket 透传**：`/api/remote.mux` 等 Upgrade 请求按原始 TCP 隧道转发，
  实时会话、任务流、工具输出在手机上照常工作。
- **桌面可发现**：DSH GUI 右下角会注入「📱 手机连接」按钮（仅回环地址显示），
  点击即打开本机配对页。

## 架构

```
 手机浏览器 (LAN)                          桌面 DSH 进程 (Cordis)
 ─────────────────                          ──────────────────────
 http://192.168.x.y:7860/  ──反向代理──▶    http://127.0.0.1:6326/   (真实 GUI)
 http://192.168.x.y:7860/m/ ──手机外壳──┐
                                        └── 同源 iframe ──▶ /
 配对：桌面 /m/pair 显示 PIN + POST /m/api/pair
        → { url: http://<LAN-IP>:7860/?token=<launchToken> }
        → DSH 用该 token 换 Cookie（303 + Set-Cookie），之后所有请求携带 Cookie
```

代理的关键重写：`Host` → DSH 目标 authority，`Origin` / `Referer` → DSH 目标 origin，
`Cookie` 原样双向透传。DSH 基于 Host authority 校验的 Cookie 因此继续有效，
而手机浏览器把 Cookie 存在插件源上——一个源同时服务手机外壳和 GUI。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `package.json` | DSH bundle 包声明（`dsh.bundle.patch`，零依赖）。 |
| `cordis.patch.yml` | Bundle patch 层：插入唯一的 `mobile-bridge` 行及其默认配置。 |
| `lib/plugin.js` | Cordis 插件入口：`name` / `inject` / `apply`，等待 webServer 就绪、防御式启动、清理注册、GUI 按钮注入。 |
| `lib/bridge.js` | 独立可用的 `startBridge(options)`：HTTP 监听、路由、静态文件、配对 API、优雅关闭。 |
| `lib/proxy.js` | HTTP + WebSocket 反向代理（头重写、流式转发、502/504、拒绝 CONNECT/绝对 URL）。 |
| `lib/pairing.js` | 随机 PIN、常量时间比较、按 IP 的错误次数限流。 |
| `lib/static.js` | `/m/` 静态文件服务（路径穿越防护、MIME、缓存策略）。 |
| `lib/network.js` | 回环判断、LAN IPv4 候选发现、URL host 解析。 |
| `lib/http-util.js` | JSON/文本响应、请求体读取等小工具。 |
| `pair-page/index.html` | 桌面配对页（中文、纯内联 CSS/JS、每 5 秒刷新 PIN 与地址）。 |
| `public/` | 手机端 PWA 外壳（由 mobile-app 维护）。 |
| `install.ps1` / `uninstall.ps1` | Windows 安装/卸载脚本（备份 profile、调用官方 `dsh plugin` 命令）。 |
| `selftest/` | 插件自测：真实隔离 DSH 上的 HTTP/WS/配对代理测试与集成检查。 |

## 安装

前置条件：Windows + Node.js 24（随 DSH 一起提供即可）、已安装并可运行的 DSH。
无需联网安装任何 npm 包。

> **重要：请先完全退出 DeepSeek Harness（包括托盘图标与后台进程），再运行安装脚本；
> 安装完成后重新启动 DeepSeek Harness。**
> 运行中的 DSH 会锁住 profile 文件，且插件只会在重启后加载。

### 方式 A：一键脚本（推荐）

```powershell
# 默认安装到 desktop profile
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 可选：安装到 web profile、指定端口、添加防火墙入站规则（需管理员权限）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web -Port 7860 -Firewall

# 只查看将执行的操作，不做任何修改
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

脚本会：

1. 校验包完整性（`package.json` / `cordis.patch.yml` / `lib/plugin.js`）；
2. 备份目标 profile 的 `package.json` 与 `cordis.patch.yml` 为 `*.bak-<时间戳>`；
3. 执行官方安装命令：
   `dsh plugin --profile <Profile> add "<本包绝对路径>"`；
4. 校验 profile 依赖与 `dsh.profile.bundles` 已包含本插件；
5. 打印重启与配对页地址。

可用参数：`-Profile`、`-PackagePath`、`-DshCli`、`-DshHome`、`-Port`、`-Firewall`、`-DryRun`。
脚本本身**绝不会自动运行**，也不会自动重启 DSH。

### 方式 B：手动安装

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh"    # 或你的 DSH_HOME
& 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile web add "$PWD"
```

随后确认 `<DSH_HOME>\profiles\<profile>\package.json` 同时包含：

```json
{
  "dependencies": { "dsh-plugin-mobile-bridge": "link:<本包路径>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-plugin-mobile-bridge"] } }
}
```

### 验证安装

```powershell
# 组合后的 profile 树中应出现 id 为 mobile-bridge 的行
& 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd' --profile web --dump-config | Select-String mobile-bridge
```

重启 DSH 后，在启动日志（CLI 启动时是控制台，桌面版可用配对页确认）应看到：

```
mobile-bridge: phone URL http://<LAN-IP>:7860/m/  pin 123456
mobile-bridge: desktop pairing page http://127.0.0.1:7860/m/pair
mobile-bridge: proxying http://127.0.0.1:6326 on 0.0.0.0:7860
```

## 外网访问（隧道 + 访问码）

桥接本身提供的是局域网 HTTP；要在外网（移动网络）访问，可临时套一层反向隧道（localhost.run / serveo / Cloudflare Quick Tunnel），公网侧仍用同一个 6 位 PIN 作为访问码配对。

- 启动脚本：`scripts/external-access.ps1`（默认 `-Provider lhr`，可选 `serveo` / `cloudflared`）；脚本读取本机 `/m/pair/info` 的当前 PIN 并打印「外网地址 + 访问码」。
- 桥接的配对 URL 生成已支持反向代理：优先取 `X-Forwarded-Proto/Host`；无转发头时，公网 Host 自动使用 `https`，回环/内网 Host 保持 `http`。这样隧道下的 token 配对 URL 不会退化成 http。
- 安全边界：`/m/pair`、`/m/pair/info`、`/healthz` 仅允许**本机直连**——除了 socket 回环外还要求 Host 为 `127.0.0.1/localhost/[::1]` 且无转发头；隧道流量 Host 是公网域名，因此外部无法读取 PIN。
- PIN 限流按 socket 地址计数（不信任可伪造的 `X-Forwarded-For`）；隧道用户共享回环 key，公网暴力尝试实际不可行。
- 已验证：外网 shell/PWA 可加载；`/m/api/pair` 经隧道返回 https token URL；token→cookie→GUI HTML 正常；WebSocket(`/api/remote.mux`) 经 localhost.run/serveo 升级为 101；`/m/pair*` 与 `/healthz` 经隧道返回 403。

## 配置

默认值写在 bundle 的 `cordis.patch.yml` 中；**推荐不要改包内文件**，而是在
`<DSH_HOME>\profiles\<profile>\cordis.patch.yml`（profile 自己的覆盖层）中按 id 覆盖。
注意 patch 对自己的 id 是「整段 config 替换」，所以要重写所有想保留的键：

```yaml
# <DSH_HOME>\profiles\desktop\cordis.patch.yml
- id: mobile-bridge
  config:
    enabled: true
    bindHost: 0.0.0.0
    port: 7860
    publicHost: null
    pin: null
    pairAttempts: 8
    guiButton: true
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时完全不启动 LAN 监听（但插件已安装）。 |
| `bindHost` | `0.0.0.0` | 监听地址。`0.0.0.0` = 所有网卡；只给本机用可设 `127.0.0.1`。 |
| `port` | `7860` | 监听端口；`0` 表示由系统分配（端口会打印在启动日志中）。 |
| `publicHost` | `null` | 配对 URL 中使用的 host authority，例如 Tailscale MagicDNS 名称 `my-pc.tailnet-name.ts.net`。设置后优先于自动探测的 LAN IP。 |
| `pin` | `null` | 固定 PIN（**仅测试/开发**）。`null` = 每个进程随机 6 位数字。 |
| `pairAttempts` | `8` | 同一 IP 在 10 分钟内允许的错误次数；超出后返回 HTTP 429 并锁定到窗口结束。 |
| `guiButton` | `true` | 是否在桌面 GUI 注入「📱 手机连接」按钮（只在回环 hostname 显示）。 |

其他可选（主要给测试/自测用）：`pairWindowMs`、`probeTimeoutMs`、`upstreamTimeoutMs`、`staticDir`、`pairPageDir`、`logger`。

端口修改后记得同步 `install.ps1 -Port`（用于防火墙规则与提示信息）。

## 使用

1. 启动 DSH（桌面版或 `dsh web`）。
2. 在电脑上打开配对页：<http://127.0.0.1:7860/m/pair>
   （或点击 DSH GUI 右下角的「📱 手机连接」按钮）。
   页面显示当前 PIN 与所有可用的手机访问地址，每 5 秒自动刷新。
3. 手机连接与电脑相同的 Wi-Fi / 局域网，用手机浏览器打开 `http://<LAN-IP>:7860/m/`。
4. 输入桌面页显示的 6 位 PIN，点「配对」。
5. 配对成功后手机自动登录并进入 DSH 界面；建议「添加到主屏幕」，下次直接打开。

PIN 每次 DSH 进程重启都会重新生成；配对页只能从本机（127.0.0.1 / ::1）打开。
配对成功后手机浏览器持有 DSH 下发的 HttpOnly Cookie，长期有效（直至 DSH 重启或
Cookie 过期）；DSH 重启后需要重新配对。

## 安全模型

- **绝不记录 token**：配对返回的 URL 携带 DSH 进程启动 token，插件不会把它写入日志。
- **PIN 页仅本机**：`/m/pair`、`/m/pair/info`、`/healthz` 检查 TCP 对端地址必须是回环，
  否则 403；PIN 不会出现在任何 LAN 可达的响应里。
- **常量时间比较**：PIN 比较先对两侧做 SHA-256 再 `timingSafeEqual`，长度不同也保持恒定时间。
- **限流**：`pairAttempts` 次错误后按 IP 锁定至窗口结束（默认 10 分钟），返回 429。
- **不是开放代理**：只转发到 `targetOrigin`；拒绝 CONNECT 与绝对形式 URL；
  监听端口是唯一入口。
- **DSH 信任边界不变**：代理把 Host 重写为 DSH 回环 authority、Origin/Referer 重写为目标 origin，
  DSH 的 Host/Origin 信任围栏和 Cookie 校验仍然生效；未认证的手机访问 `/` 只会得到 401/303。
- **明文 HTTP**：v1 不做 TLS（局域网内使用）。若需要跨不可信网络，请配合 Tailscale 等
  加密隧道，并用 `publicHost` 指定隧道域名。

## 故障排查

| 现象 | 排查 / 解决 |
| --- | --- |
| 重启后没有任何 `mobile-bridge:` 日志 | 确认安装到了**当前启动的 profile**；用 `--dump-config` 检查 `mobile-bridge` 行；确认 `dsh.profile.bundles` 含本包名。 |
| 日志 `EADDRINUSE` / `could not start the LAN listener` | 端口被占用：`netstat -ano | findstr :7860`，换 `port` 或结束占用进程。DSH 本身不会因此崩溃。 |
| 手机打不开地址 | ① 手机与电脑是否同一网段；② Windows 防火墙是否放行入站 TCP：`install.ps1 -Firewall` 或手动放行；③ 用了 VPN/虚拟网卡时用 `publicHost` 指定正确地址；④ 配对页 `urls` 列表里换一个地址试。 |
| 页面提示「桥接不可用」 | DSH 未运行或目标 origin 不可达；确认 DSH 的 Web 服务正常（桌面版默认 `http://127.0.0.1:6326`）。 |
| 手机打开 `/m/` 正常，但配对后 GUI 仍是 401 | 重新配对一次；确认没有清理站点 Cookie；确认 DSH 没有重启（token 已变）。 |
| 手机上看不到「手机连接」按钮 | 该按钮只在桌面 GUI 的回环 hostname 下注入，手机 iframe 中按设计不显示。 |
| 忘记 PIN | 打开 <http://127.0.0.1:7860/m/pair>，或重启 DSH 生成新 PIN（`pin` 固定时除外）。 |
| WebSocket / 实时输出断流 | 确认中间没有会拦截 Upgrade 的反向代理；插件对 `/api/remote.mux` 走原始 TCP 隧道。 |
| 修改配置后不生效 | profile 补丁需要重启 DSH（除非启用了 HMR）。 |

日志位置：CLI 启动时输出到 stdout；桌面版建议直接看配对页/通过启动脚本重定向日志。
`/healthz`（仅本机）可用于确认监听器存活。

## 卸载

```powershell
# 同样先完全退出 DeepSeek Harness
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile desktop
```

脚本会先备份 profile 文件，再执行
`dsh plugin --profile <Profile> remove dsh-plugin-mobile-bridge`，并校验依赖与
`dsh.profile.bundles` 已不再引用本插件。之后重启 DSH，LAN 监听器即消失。

## 开发与自测

```powershell
# 1) 独立桥接器全量自测（需要隔离的 DSH Web 实例，默认 127.0.0.1:8899）
node packages/dsh-plugin-mobile-bridge/selftest/bridge-selftest.mjs

# 2) 真实 profile 启动后的端到端检查（见 selftest/README.md）
node packages/dsh-plugin-mobile-bridge/selftest/integration-check.mjs `
  --bridge http://127.0.0.1:7862 --log <DSH_HOME>/web.log --pin 246810
```

测试只连接隔离实例与本插件自己的监听端口，绝不触碰正在使用的桌面 DSH。

无 Cordis 时的集成入口（QA / 开发可直接 import）：

```js
import { startBridge } from './lib/bridge.js';   // 或 './lib/plugin.js'（同名再导出）

const bridge = await startBridge({
  targetOrigin: 'http://127.0.0.1:8899',          // 必填：被代理的 DSH Web origin
  authenticatedUrl: (base) => base + '?token=' + launchToken, // 可选；缺省时配对返回 503
  bindHost: '127.0.0.1',                          // 默认 0.0.0.0
  port: 0,                                        // 默认 7860；0 = 系统分配
  pin: '123456',                                  // 可选；缺省随机
  pairAttempts: 8,                                // 可选
  staticDir: '<pkg>/public',                      // 可选
  pairPageDir: '<pkg>/pair-page',                 // 可选
  logger: console,                                // 可选 { info, warn, error }
});
// bridge = { port, host, pin, urls, targetOrigin, pairPageUrl, close() }
await bridge.close();
```

## 已知限制（v1）

- 无 TLS：仅适合可信局域网 / 加密隧道。
- 单用户：一个 DSH 进程对应一组 PIN / Cookie，没有多账号。
- 依赖 DSH 的 Web 认证：DSH 重启后手机需要重新配对。
- `install.ps1 -Firewall` 需要管理员权限；失败只提示，不阻断安装。


## 安卓 App（APK）

`public/download/DSH-Mobile.apk` 是配套的安卓安装包（由仓库根目录 `android/` 构建的 WebView 外壳，
包名 `ai.deepseek.dshmobile`，minSdk 26 / targetSdk 34，已用本地自签名证书签名，可直接侧载安装）。

- 手机与电脑同一 Wi-Fi 时，用手机浏览器打开
  `http://<电脑IP>:7860/m/download/DSH-Mobile.apk` 下载安装；
- 首次打开已预填电脑地址，点「连接」后输入配对 PIN 即可；换电脑/网络可在 App 设置页改地址；
- 构建、签名、修改默认地址、重新打包等详见 [`android/README.md`](../../android/README.md)，
  安装步骤见 [`docs/mobile-install.md`](../../docs/mobile-install.md)。

## 旧版 Android WebView 兼容（v0.3+）

局域网 HTTP 属于非安全上下文，部分华为/旧版 WebView 缺少 `Promise.withResolvers`、`AbortSignal.any`、
`AbortSignal.prototype.throwIfAborted`、`crypto.randomUUID` 等 API，会导致 DSH GUI 无法启动。
代理层会对代理的 `text/html` 响应注入幂等兼容脚本（`data-dsh-mobile-compat`，见 `lib/proxy.js`），
仅影响 HTML 文档、不改变业务数据；浏览器 H5 与安卓 APK 共用该通道。
