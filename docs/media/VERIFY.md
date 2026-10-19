# 视觉验证与截图说明

本目录的截图由 Lead 在最终集成阶段用**真实浏览器**（headless Chrome + CDP）对**真实运行中的插件**拍摄，
不是设计稿或示意图。

## 验证环境

- DSH 实例：隔离的 `DSH_HOME = <workspace>/.test-home`，`dsh web --no-open --host 127.0.0.1 --port 8899`
  （**不接触**用户真实的 `%USERPROFILE%\.dsh` 与桌面 DSH 6326 端口）。
- 插件：`dsh-plugin-mobile-bridge` 已用 `dsh plugin --profile web add` 安装进该隔离 profile，
  由 DSH 进程内加载，监听 `0.0.0.0:7860`（PIN 随机）。
- 浏览器：headless Chrome，手机视口 390×844（DPR=3）；手机场景通过**局域网地址**
  `http://<LAN-IP>:7860/m/` 访问，与真机访问路径一致。
- 桌面场景通过 `http://127.0.0.1:7860/m/pair`（仅 loopback 可开）与 `http://127.0.0.1:7860/?token=…` 访问。

## 验证结果（全部通过）

| 检查 | 结果 |
| --- | --- |
| 手机配对页渲染：6 位 PIN 输入、连接按钮、状态栏 | PASS |
| 在手机页面输入真实 PIN：`POST /m/api/pair` → 一次性登录 URL → 自动登录 | PASS |
| 登录后手机 iframe 从**局域网 origin** 加载真实 DSH GUI（`DeepSeek Harness` 文档、真实界面渲染） | PASS |
| 手机 origin 下桌面专用「📱 手机连接」悬浮按钮**不出现**（只在 loopback 桌面 GUI 注入） | PASS |
| 桌面配对页显示当前 PIN + 局域网访问地址 + 使用说明 | PASS |
| 桌面 GUI 经网关注入「📱 手机连接」按钮 | PASS |

补充：`tests/run-all.ps1` 的 10 项 HTTP/WS/安装 E2E 全部通过；
插件包自带自测 35/35；手机外壳 DOM 冒烟 11/11（详见 `tests/artifacts/` 与
`packages/dsh-plugin-mobile-bridge/selftest/`）。

## 截图

| 文件 | 内容 |
| --- | --- |
| `mobile-pair.png` | 手机端配对页（PWA 外壳，390×844） |
| `mobile-main.png` | 手机端已配对：同源 iframe 中加载真实 DSH GUI（局域网 origin） |
| `pair-desktop.png` | 桌面配对页：PIN、手机访问地址、操作方法（仅本机可打开） |
| `desktop-gui.png` | 桌面 DSH GUI 经网关访问，右下角为插件注入的「手机连接」按钮 |

> 说明：隔离 DSH 实例没有登录模型凭据，所以 `mobile-main.png` 中 GUI 显示「开始使用 /
> 登录 DeepSeek 账号」引导层；用户真实桌面 DSH 已登录，手机上会直接看到其真实会话界面。

## 手动复现（无需自动化）

1. `powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-all.ps1` 会启动隔离 DSH + 测试网关（7861）。
2. 浏览器手机视口打开 `http://127.0.0.1:7861/m/`，输入 `tests/run-all.ps1` 输出的 PIN（默认 123456）。
3. 即可看到与截图一致的效果。


## 安卓 APK（真机）

配套安卓安装包由 `android/` 构建（WebView 外壳，包名 `ai.deepseek.dshmobile`，versionName 0.1.0，
minSdk 26 / targetSdk 34，INTERNET 权限，v1+v2+v3 签名）：

| 检查 | 结果 |
| --- | --- |
| `apksigner verify`（v1/v2/v3 + cert） | PASS（自签名证书 SHA-256 `cd3e09c6…5d`） |
| `aapt2 dump badging` | PASS：package/label/minSdk/targetSdk/launchable activity 正确 |
| `zipalign -c -v 4` | PASS |
| `adb install -r`（真机 HONOR HPB-AN00，Android 14 / API 34） | **Success**，包已安装并可启动 |
| 真机启动 → 原生设置页（预填 `http://192.168.17.174:7860/m/`） | PASS（`android-setup-screen.png`） |
| 真机 WebView 加载桌面网关手机页（`?app=1`） | PASS（`android-loading.png` / `android-pairing.png`） |
| 手机 → 桌面 TCP（`curl http://192.168.17.174:7860/m/`） | HTTP 200（同一 Wi-Fi，ICMP 被系统禁用属正常） |

设备证据原件：`android/artifacts/`（截图 + uiautomator dump + VERIFICATION.txt）。
APK SHA-256：`D7466F3833D2B16B5F9FBA3C598787D6B8F303A1E072148F28C06B8E602619C0`（66,583 bytes）。


## 优化后的手机界面（shell v0.2）

| 检查 | 结果 |
| --- | --- |
| 手机视口浏览器 UI 自动化（配对视图、PIN 登录、真实 GUI、快捷操作、APK 全屏模式） | **5/5 PASS**（`public/dev/ui-smoke.mjs`，报告 `docs/media/ui-smoke-report.json`） |
| 快捷操作点击真实 GUI：`button[aria-label="打开侧边栏"]` → `[data-sidebar-collapsed]` true→false | PASS |
| APK 全屏模式断言：bar 高度<2 / opacity<0.05 / iframe top<2 / iframe 高度≈视口 / 顶部 handle 绝对定位不占位 / 点按 handle 可唤出 mini bar | PASS |
| 控制台无错误（browser + APK 模式） | PASS |
| `tests/run-all.ps1` 最终回归（shell 全部改动后） | **10/10 PASS** |
| `public/dev/verify.mjs` / `dom-smoke.mjs` / `smoke-real-bridge.mjs` | 34/34 · 13/13 + 12/12 · 11/11 |

优化要点：APK 全屏模式（隐藏顶栏、GUI 从 0 高度开始、顶部隐藏式拖拽条/手势唤出 mini bar）、
浏览器模式 40px 自动隐藏紧凑栏、浮动快捷操作（侧栏/新会话/刷新/诊断，选择器已对真实 GUI 验证）、
键盘可视区域处理、安全区、禁双击缩放、APK 下载卡片（Android 浏览器）等。

## 真实安卓手机验收

- 设备：**HONOR HPB-AN00（Android 14 / API 34）**，USB 调试连接（serial `A6SJUT2613000658`）。
- 安装：`adb install -r android/build/DSH-Mobile.apk` → **Success**（包 `ai.deepseek.dshmobile`，versionName 0.1.0）。
- 启动：原生设置页预填 `http://192.168.17.174:7860/m/`；WebView 加载 `/m/?app=1`。
- 网络：手机 `wlan0=192.168.17.156/22` 与桌面 `192.168.17.174` 同一 Wi-Fi；
  手机侧 `curl http://192.168.17.174:7860/m/` → **HTTP 200**（ICMP 被系统禁用属正常）。
- **真机已连接**：APK 内全屏显示桌面 DSH 的真实 GUI，无外壳顶栏，顶部只有隐藏式拖拽条
  （截图：`android-app-connected.png`）。
- 页面资源通过版本号 `?v=0.2.1` 强制刷新，避免 WebView 旧缓存；桌面插件改动
  `public/` 即时生效（无需重启 DSH）。

## v0.3 重设计落地与真机 WebView 兼容（2026-10-19）

- 用户评审通过「沉浸式原生」5 屏设计后落地到 `public/`（v0.3.0）：配对页（PIN + 数字键盘）、主界面（真实 GUI iframe + 悬浮胶囊 + 玻璃 Dock）、会话抽屉、快捷面板、设置/诊断；H5 与 APK 共用同一页面。
- 生产校验：`tests/run-all.ps1` **10/10 PASS**；`public/dev/verify.mjs` **29/29**；`dom-smoke.mjs` **10/10 + APK 模式 4/4**；`smoke-real-bridge.mjs` **11/11**；Lead 的 headless-Chrome `ui-smoke.mjs` **5/5**（截图 `mobile-*.png`）。
- APK v0.2.0（versionCode 2）重新签名并通过 `adb install -r` 覆盖安装到真机（HONOR HPB-AN00 / Android 14）。
- **真机兼容问题与修复**：华为 WebView（UA 仍报 `Chrome/99.0.4844.88`）在局域网 HTTP（非安全上下文）下缺少 `Promise.withResolvers`、`AbortSignal.any`、`AbortSignal.prototype.throwIfAborted`、`crypto.randomUUID` 等 API，导致真实 DSH GUI 在 iframe 中停在「正在加载桌面界面…」。通过桌面网关 `lib/proxy.js` 对代理的 text/html 响应注入幂等兼容脚本（`data-dsh-mobile-compat`）修复，无需改动 APK 或 DSH。
- 修复后真机验证：shell `frameLoaded=true`、`quickActions.sidebar/newSession=true`、iframe `readyState=complete`、真实 GUI 渲染且 Dock 正常；截图 `android-app-connected.png`。

## v0.3.2 侧边栏体验（2026-10-19）

- 主界面隐藏左侧图标栏：注入 CSS 在折叠态把 frame 第一列设为 0，并用 `visibility:hidden`（**不能用 display:none**，否则 grid 错位导致主内容宽度为 0）隐藏 sidebarCol → centerCol x=0、宽度≈全宽。
- 点 Dock「会话」：通过真实 GUI toggle（`aria-label` 打开/收起侧边栏）弹出/关闭；展开侧栏只保留工作区内容——brand / newSession / panelRow / 插件 / 自动化任务 / 账号菜单全部隐藏，工作区与会话列表可见；关闭后恢复全宽；toggle 不可用时回退内置会话抽屉。
- 验证：`ui-smoke.mjs` 第 3 步（headless Chrome，390×844，APK UA）**5/5 PASS**；`verify.mjs` **30/30**；`dom-smoke.mjs` **10/10 + APK 模式 5/5**；`smoke-real-bridge.mjs` **11/11**；`tests/run-all.ps1` **10/10 PASS**。
- Lead 对 **live 桌面桥（7860）** 用 headless Chrome 实测：收起态 sidebarCol width≈1px、center x=0 w=390；点 Dock 会话后 sidebar width=280、隐藏断言全部 true、Dock 高亮；点收起恢复全宽。
- 截图：`mobile-main.png`（无侧栏全宽）、`mobile-sidebar.png`（仅工作区侧栏）、`mobile-screens.png`（5 屏总览）。

## v0.3.5–v0.3.6 手机端桌面专用入口屏蔽（2026-10-19）

- 需求：隐藏/拦截手机端需要电脑端原生文件/目录对话框的操作（打开工作区、新建工作区、添加工作区、打开文件夹/目录、打开方式/Open in 等）。
- 实现（`public/app.js` 注入 iframe 适配层）：
  - 静态 CSS 隐藏已知入口（`[aria-label="添加工作区"]`、`*打开/新建工作区`、`*打开/选择文件夹/目录`、`*打开方式`、`*Open in`）；
  - 通用 matcher（innerText / aria-label / title / aria-keyshortcuts）+ MutationObserver（120ms 节流）标记动态菜单项 `data-dsh-mobile-blocked=1`、aria-hidden、display:none；
  - capture click/pointerdown 兜底：preventDefault + stopImmediatePropagation + postMessage 壳层 toast「手机端暂不支持该操作（需在电脑端选择）」；诊断记录 blockedAction；
  - 空工作区状态（隔离 DSH）下「选择工作区」本身会弹电脑目录选择框 → 识别空状态文案并特别提示「手机端暂不支持，请在电脑端打开/新建工作区」；
  - v0.3.6：早期渲染误标自动 unmark（workspace 就绪后恢复 composer 工作区切换器），并监听 characterData + 多档 rescan。
- 验证：隔离环境 `ui-smoke` **6/6 PASS**（含 guard 步骤与空状态提示）；verify 31/31、dom-smoke 12/12 + APK 5/5、smoke-real-bridge 11/11、`tests/run-all.ps1` 10/10。
- live 7860（有默认工作区）headless 实测：composer「默认工作区」可见可点（早期 825ms 误标 → 1166ms 自动恢复），侧栏「添加工作区」隐藏、菜单仅「添加工作区…」被隐藏、「默认工作区」可切换；点击隐藏项被拦截（GUI handler hit=0、toast、blockedAction 记录）；关闭侧栏恢复全宽；console errors 0。
- 截图：`mobile-sidebar-guard.png`、`mobile-screens.png`（6 屏总览）。

## 外网访问（隧道 + 访问码，2026-10-19）

- 桥接支持反向代理：`pairingOrigin` 优先 `X-Forwarded-Proto/Host`；无转发头时公网 Host 自动用 https；`isLoopbackRequest` 要求 socket 回环 + Host 回环 + 无转发头；PIN 限流改为 socket 地址（不信任可伪造的 X-Forwarded-For）。
- 新脚本 `packages/dsh-plugin-mobile-bridge/scripts/external-access.ps1`：默认 localhost.run，支持 serveo/cloudflared，打印外网地址 + 当前 PIN 访问码。
- 实测（Cloudflare Quick Tunnel 被本机 DNS 拦截；localhost.run / serveo / pinggy 可用）：
  - 外网 shell 200、`app.js?v=0.3.13`；
  - `POST /m/api/pair` 经隧道返回 **https** token URL，token 交换 303 + Set-Cookie，带 cookie 取 GUI HTML 200（含 `__DSH_BOOT__`）；
  - WebSocket `/api/remote.mux` 经 localhost.run/serveo 升级 **101**；
  - `/m/pair`、`/m/pair/info`、`/healthz` 经隧道全部 **403**（本机访问仍正常）；
  - serveo 免费版首次浏览器访问会出现警告页，带 `serveo-skip-browser-warning=true` 或点 Continue 后放行；GUI iframe 可加载（frameLoaded=true）。
- 说明：第三方免费隧道速度/稳定性有限，首次加载 GUI 可能较慢；长期建议 Tailscale 组网。

## 安卓 App v0.2.1：可切换服务器地址 + 真机外网访问（2026-10-19）

- APK v0.2.1（versionCode 3）构建+签名+覆盖安装成功；设置页新增「服务器地址」输入框与「保存并连接」（调用 native `DshApp.loadUrl` 持久化并重连），配对页新增「更换服务器地址」；原生连接页支持 https 外网地址。
- 真机（HONOR HPB-AN00 / Android 14）切到 5G 移动数据（局域网不可达）后：App 载入外网隧道地址 → 显示配对页 → 输入访问码（PIN）→ 配对成功（token 交换 303 + cookie）；页面版本 v0.3.14、原生版本 0.2.1。
- 页面契约回归：`verify.mjs` 31/31、`dom-smoke.mjs` 12/12；`tests/run-all.ps1` 见最新结果。

## 安卓 App v0.2.3：软键盘遮挡修复（2026-10-19）

- 根因：App 使用 edge-to-edge 全屏窗口（`FLAG_LAYOUT_NO_LIMITS` / decorFitsSystemWindows=false），软键盘弹出时窗口不缩放，聊天输入框被拼音输入法面板遮挡。
- 修复（native）：改为监听 WindowInsets IME 高度并给 WebView 容器加底部 padding（键盘关闭时用导航栏高度），WebView 视口随之缩小；同时保留 adjustResize。页面 v0.3.20 在输入框 focus / resize 时多次重算 `--app-height` 兜底。
- 版本：APK **v0.2.3**（versionCode 5，70,678 B，SHA-256 `850120E6…4B570B`）；页面 **v0.3.20**。
