# DSH Mobile — 手机端 Web 应用外壳（`public/`）

这是由 `dsh-plugin-mobile-bridge` 插件在 `/m/` 路径下提供的手机端单页应用（PWA 风格外壳），
用于在同一局域网内、经过 PIN 配对后，把桌面 DSH Web GUI 嵌进一个为手机优化的全屏界面。

**v0.3.6「沉浸式原生」** 起，本页面同时供 **浏览器 H5** 与 **Android APK（WebView）** 使用：
深空黑 + 玻璃卡片 + 蓝青渐变、悬浮状态胶囊、玻璃 Dock、会话抽屉、快捷面板、设置/诊断页与
数字键盘配对；主界面隐藏 DSH 左侧图标栏、Dock「会话」直接弹出真实 GUI 侧边栏（仅保留工作区内容），
并屏蔽会弹出**电脑端原生文件/目录对话框**的操作（添加/打开/新建工作区等）。
全部落在这一套真实可用的生产页面里（设计存档见 `../../design/preview/`）。

- **纯静态**：原生 HTML / CSS / JavaScript，无框架、无构建步骤、无 CDN、无外网请求。
- **同源 iframe**：外壳与真实 GUI 都由插件监听器提供（`/m/` 与 `/`），因此可以同源嵌入并注入移动端适配 CSS。
- **认证流程**：`/m/api/pair` 返回带 DSH 启动 token 的 URL；外壳把它放进**隐藏的同源 iframe** 加载，
  让 DSH 为本源写入 HttpOnly Cookie，不离开外壳即可完成登录（失败时回退到“手动登录”整页导航）。
- **离线可用**：不依赖 Service Worker（局域网 HTTP 非安全上下文，SW 无法注册），所有资源本地化。
- **原生 App 模式**：安卓 APK 以 UA 后缀 ` DSHMobileApp/0.1` 且 `?app=1` 打开时自动进入全屏模式。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.html` | 单页外壳：启动检查屏、配对页（品牌 hero + 6 格 PIN + 数字键盘 + 扫码占位 + APK 入口）、主界面（真实 DSH GUI iframe 全屏 + 悬浮状态胶囊 + 玻璃 Dock）、设置/诊断页、会话抽屉、快捷操作 sheet、配对成功动效、APK 恢复热区、离线横幅、toast。内联 SVG 图标精灵，零外链。 |
| `app.css` | 「沉浸式原生」样式：深空主题/极夜/幽蓝主题变量、电光蓝等 4 组强调色、玻璃卡片（`backdrop-filter`）、状态胶囊自动收起与状态点唤出、底部玻璃 Dock、会话抽屉/快捷 sheet 动画、数字键盘与配对成功环、APK 全屏模式、键盘伸缩、横屏、`prefers-reduced-motion`。由 `design/preview/index.html` 的已评审样式移植，并叠加生产层。 |
| `app.js` | 全部逻辑：`/m/api/state` 探测、数字键盘 PIN 配对与自动提交、401 bad-pin/剩余次数、429 锁定倒计时、隐藏 iframe 换取 Cookie、手动登录 fallback、主 iframe 加载、401 认证页识别、移动端 CSS 注入（含 v0.3.6 侧边栏简化与桌面对话框屏蔽规则）、5s 看门狗/离线横幅、Dock「会话」切换真实 GUI 侧边栏（toggle 不可用时回退 shell 会话抽屉）、Dock→真实 GUI 按钮映射、快捷 sheet、设置/诊断（origin/host/状态/延迟/运行模式/原生接口/快捷操作可用性/APK 下载/断开）、主题-强调色-字号持久化、APK 全屏模式、胶囊自动隐藏、键盘/安全区处理。 |
| `manifest.webmanifest` | PWA manifest：名称 `DSH Mobile`、`start_url`/`scope` 为 `/m/`、`standalone`、192/512 图标（未改动）。 |
| `icons/` | 全部本地 PNG 图标：`icon-192/512`、`icon-maskable-192/512`、`apple-touch-icon-180`、`favicon-32/16`、`favicon.svg`。由 `dev/gen-icons.mjs` 生成。 |
| `download/DSH-Mobile.apk` | 安卓安装包（由 Lead 构建并放入；网关按 `/m/download/DSH-Mobile.apk` 提供）。配对页与设置页都以 `HEAD` 探测后提供友好下载入口。 |
| `dev/mock-server.mjs` | **仅开发用** 本地假后端：静态服务 `public/`、模拟 `/m/api/state`、`/m/api/pair`（PIN `123456`）、token 登录握手、401 页面和一个深色聊天 GUI 假页面。 |
| `dev/verify.mjs` | 可重复的自动检查（31 项）：静态资源/manifest/图标尺寸/路径穿越、API 契约、隐藏 iframe 登录取 Cookie、429 锁定、v0.3.6 设计落地 DOM 与代码契约、侧边栏简化 / Dock 会话切换 / 桌面对话框屏蔽契约、DOM id/class 完整性、单文件无外链。 |
| `dev/dom-smoke.mjs` | 无浏览器环境下解析**真实 `index.html`** 并在最小 DOM 树中执行**真实 `app.js`**：浏览器模式（12 项：配对全流程、真实 GUI 映射、Dock 会话切换真实侧边栏、降级抽屉、桌面对话框命中/拦截/不误伤、**无工作区空状态 chooser 屏蔽**、设置/主题/字号、错误 PIN/锁定、离线/键盘）与 `--app-mode`（5 项：APK 全屏检测、DshApp inset、mini 胶囊唤出、Dock 会话切换、App 设置）。 |
| `dev/ui-smoke.mjs` | **真实 headless Chrome（CDP）手机视口 UI 测试**（6 项）：配对页、键盘配对→真实 GUI+Dock、**侧边栏简化**、**桌面对话框屏蔽（双环境感知：有工作区时菜单中「添加工作区…」/侧栏入口隐藏且点击兜底；无工作区空状态时「选择工作区」chooser 也被隐藏/拦截并 toast，选择工作区触发器在有工作区时保持可用）**、APK 全屏模式、控制台错误检查；输出 6 张 `optimized-*.png` + JSON 报告。 |
| `dev/smoke-real-bridge.mjs` | 用插件真实的 `startBridge()` + 隔离 DSH 实例做端到端 HTTP 冒烟测试（11 项）。 |
| `dev/gen-icons.mjs` | 无依赖 PNG 生成器（`node:zlib` 手写 PNG），改图标后重新生成即可。 |
| `dev/screenshots/` | 手机视图截图目录（由 `dev/ui-smoke.mjs` 生成 `optimized-*.png`）。 |

## v0.3.6 沉浸式原生设计

### 1. 五个屏幕（全部真实可用）

| 屏幕 | 内容 |
| --- | --- |
| 启动检查 | 读取 `/m/api/state` 时显示品牌 spinner；已配对直接进入主界面，未配对进入配对页，离线时给可重试的提示。 |
| 配对页 | 品牌 hero（「连接桌面 DSH」/同 Wi-Fi 说明/等待配对状态胶囊）、6 格 PIN + **自绘数字键盘**（不需要系统键盘）、错误抖动 + 剩余次数、429 锁定倒计时、扫码配对占位「即将支持」、安卓 App 下载入口、手动登录 fallback（内联操作行）。 |
| 主界面 | 真实 DSH GUI iframe 全屏（底部为 Dock 预留一条玻璃悬浮区，不遮挡 composer）；**默认收起并彻底隐藏 DSH 左侧图标栏（无 56px 空列，主内容全宽）**；顶部悬浮状态胶囊，底部**玻璃 Dock**（会话 / 新建 / 刷新 / 更多）；点「会话」弹出真实 GUI 侧边栏（仅工作区内容），再点或点原生 scrim 关闭。 |
| 会话抽屉 | **降级路径**（仅真实侧栏 toggle 不可用时）：底部 sheet 居左滑出：搜索框、新建会话、最近会话列表；优先从真实 GUI 侧栏 DOM 抓取，抓不到时降级为「打开桌面会话列表」按钮 + 说明。 |
| 设置与诊断 | 连接（服务器地址 / 桌面端 / 状态+延迟 / 运行模式）、外观（主题 / 强调色 / 字号）、安卓 App（版本 / 下载更新 / 原生设置）、诊断（原生接口 / 快捷操作可用性 / 最近错误 / 复制诊断 / 重新检测 / 重载）、危险操作（断开连接并回到配对）。 |

### 2. 浮游状态胶囊（浏览器 / PWA）

- 顶部胶囊显示连接点 + `DSH Mobile` + 连接状态（桌面端 host / 延迟），右侧为刷新与更多；
- 在 iframe 内**向下滚动自动收起**、向上滚动/回到顶部滑出；收起后右上角保留一个圆点胶囊，点一下即可唤出；
- 读的是同源 GUI 的所有滚动容器（`scroll` capture + passive），不影响 GUI 自身滚动；
- 键盘打开、抽屉/sheet/设置打开或离线时不会自动收起。

### 3. 玻璃 Dock → 真实 GUI 映射

| Dock | 行为 | 真实 GUI 选择器（DSH 0.2.1-rc.2 client bundle 中确认） |
| --- | --- | --- |
| 会话 | **切换真实 GUI 侧边栏（弹出/关闭）**：主界面无侧栏全宽；展开后仅显示工作区内容 | `button[aria-label="打开侧边栏"]` / `button[aria-label="收起侧边栏"]`（en：`Open sidebar` / `Collapse sidebar`） |
| 新建 | 在同源 iframe 内点击 GUI 的新建会话按钮，并 toast「已新建会话」 | `button[aria-label="新建会话"]` / `button[aria-label="New session"]` |
| 刷新 | 外壳重载 iframe | —（外壳自身实现） |
| 更多 | 打开快捷操作 sheet（会话列表 / 新会话 / 刷新 / 诊断 / 设置 / 断开连接） | —（外壳自身实现） |

- 侧栏开关/新建会话先按精确 `aria-label` 查找，再用中英文 aria-label/title 正则兜底；
- GUI React 树在 iframe `load` 之后渲染，外壳在 load 后 0/400/1200/2600ms 静默重试探测；
  **探测期间不弹 toast**；「新建」在确认不可用时静默隐藏，其余 Dock 项始终可用；
- 只有用户真的点击了无法执行的快捷操作时才 toast 提示，并引导在桌面界面中手动操作。

#### v0.3.6 侧边栏简化（Dock 会话直接控制真实侧栏）

Lead 在真实 GUI 上验证的注入 CSS 已落进 `buildAdaptiveCss()`（收起态必须用 `visibility:hidden`，
不能用 `display:none`，否则 grid 自动排布会把主内容列压成 0 宽）：

```css
/* 收起状态：彻底隐藏 56px 图标栏并回收宽度，保留网格占位 */
html.dsh-mobile [data-sidebar-collapsed="true"] { grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px) !important; }
html.dsh-mobile [data-sidebar-collapsed="true"] > :first-child { visibility: hidden !important; overflow: hidden !important; min-width: 0 !important; }
/* 展开的侧边栏只保留「工作区」内容 */
html.dsh-mobile [class*="brand"] { display: none !important; }
html.dsh-mobile [class*="newSession"] { display: none !important; }
html.dsh-mobile [class*="panelRow"] { display: none !important; }
html.dsh-mobile [aria-label="插件"], html.dsh-mobile [aria-label="自动化任务"], html.dsh-mobile [aria-label="账号菜单"] { display: none !important; }
```

- 主界面默认无侧栏、无 56px 空列，主内容从 x=0 全宽显示（`centerCol x=0, w≈视口宽`）；
- 点 Dock「会话」：`打开侧边栏` 存在 → 点击展开真实侧栏（仅「工作区/默认工作区/会话列表/搜索/视图/添加工作区」等），
  Dock 会话项高亮；再次点击或点原生 scrim → 收起并恢复全宽；
- shell 会话抽屉**降级保留**：仅当真实 toggle 不可用（选择器解析失败、GUI 未加载）时打开，
  并提示「无法切换桌面侧边栏，已打开会话抽屉」；
- APK 全屏模式下行为一致。

### 4. 外壳会话抽屉（降级路径）

真实侧栏 toggle 不可用时才使用，保证功能不缺失：

1. 打开抽屉时，外壳先尝试**展开真实 GUI 侧栏**（点击 `打开侧边栏`），从侧栏列 DOM 读取会话按钮文本
   （排除侧栏开关/新建会话/全局面板/插件/自动化任务/账号菜单等已知控件），然后**收起侧栏**；
2. 读取成功 → 在外壳抽屉中渲染会话列表（可搜索）；点击某会话时重新展开侧栏、按文本/序号定位并点击，
   再收起侧栏，完成真实切换；
3. 读取失败（DOM 变化 / 无会话 / 跨域异常 / toggle 缺失）→ 显示「打开桌面会话列表」按钮（尝试触发真实侧栏）
   与说明文案，**绝不白屏**；8s 内会重试一次抓取。

### 5. 数字键盘配对 + 动效

- 6 位数字自动提交，PIN 输入格逐位点亮；错误 PIN：卡片抖动 + 输入清空 + 「还可尝试 N 次」；
- 429：锁定倒计时（保留 `Retry-After` / `retryAfterMs`），键盘禁用，到点自动恢复；
- 配对成功：全屏对勾动画 → 隐藏 iframe 换取 Cookie → 主界面；失败则显示内联「手动登录 / 重试自动登录」；
- 扫码配对为壳层占位（`扫码配对 · 即将支持`），不发送网络请求。

### 6. APK 全屏 App 模式（保留）

安卓 APK（WebView）以 UA 后缀 ` DSHMobileApp/0.1`、URL 带 `?app=1` 打开页面（存在 `window.DshApp`
JS 接口也视为 App 模式）。检测到后：

- 不渲染可见顶栏：`data-mode="apk"` + `data-bars="hidden"`，DSH GUI iframe 从 y=0 起全屏；
- `--apk-top-inset`（优先 `window.DshApp.getTopInsetPx()`，其次 `env(safe-area-inset-top)` 探针）
  注入页面/iframe 供 mini 胶囊与 GUI padding 使用，不占用全屏高度；
- 顶部保留**不占布局**的可恢复热区（绝对定位 200×18px，含连接点与短横线）：轻点唤出 mini 胶囊（8s 自动收起）、
  双击/长按打开设置诊断、下滑唤出；所有原生调用 try/catch 包裹，没有 `window.DshApp` 也不报错；
- 存在 `DshApp.openSettings()` 时，配对页与设置页显示「App 设置」入口（调用原生设置页）；
- **Dock 在 APK 模式同样保留**，底部为 Dock 预留一条不遮挡 composer 的悬浮区。

### 7. 设置 / 诊断 / 外观

- 真实信息：`location.origin`、`/m/api/state` 返回的 `host`、状态 + 实测延迟（state 请求耗时）、
  运行模式（浏览器 / standalone / APK 全屏）、原生接口、快捷操作解析结果、最近错误、User Agent 诊断文本；
- 下载 / 更新 APK：`HEAD ./download/DSH-Mobile.apk`，404 时 toast「安装包稍后可用」且不跳转；
- 外观：3 套深空主题、4 组强调色、字号 90–115%（localStorage 持久化；字号同时作为注入 GUI 的 `zoom`，
  保留原“界面缩放”能力）；
- 断开连接：回到配对页并停止后台会话（不销毁桌面端 Cookie，重新配对即可恢复；提示语义已写明）。

### 8. 屏蔽会弹电脑原生文件/目录对话框的操作（v0.3.6）

WebView 无法显示桌面端原生文件选择器，因此这些入口在手机上被隐藏并兜底拦截：

- **静态 CSS 隐藏**已知入口：`[aria-label="添加工作区"]`、`[aria-label*="打开工作区"]`、
  `[aria-label*="新建工作区"]`、`[aria-label*="打开文件夹"]`、`[aria-label*="打开目录"]`、
  `[aria-label*="选择文件夹"]`、`[aria-label*="选择目录"]`、`[aria-label*="打开方式"]`、`[aria-label*="Open in"]`；
- **JS 通用匹配器**（`button`/`[role="menuitem"]`/`[role="button"]`/`a`：
  `innerText + aria-label + title + aria-keyshortcuts`）命中
  `/(打开工作区|新建工作区|添加工作区|打开文件夹|打开目录|选择文件夹|选择目录|打开方式|Open (workspace|folder|directory)|New workspace|Add workspace|Open in)/i`
  的元素会被标记 `data-dsh-mobile-blocked="1"`、`aria-hidden="true"`、`style.display="none"`；
- **MutationObserver** 持续处理动态下拉菜单（打开「选择工作区」时注入的「添加工作区…」项）；
- **无工作区空状态保护**：隔离/新建 DSH 没有工作区时，侧栏显示的是「选择工作区」命令入口，
  点击会走桌面原生目录选择（创建默认工作区）。此时（页面含「无法创建默认工作区 / 暂无工作区 /
  选择一个工作区」等文案，且该 trigger 不显示真实工作区名）guard 会把该 trigger 也标记
  `data-dsh-mobile-blocked="1"` 并隐藏，点击 toast「手机端暂不支持，请在电脑端打开/新建工作区」；
  有工作区时 trigger 显示真实行业名（如「默认工作区」）则保持可用、正常打开切换菜单；
- **误标记自动撤销（v0.3.6）**：workspace 数据可能在 iframe 首屏**之后**才加载，早期空状态扫描
  可能把 composer 里的 trigger 暂时标记；`scanGuardedGuiActions()` 现在会先用**当前**页面状态
  对所有已标记元素重新匹配，不再命中则撤销 `data-dsh-mobile-blocked` / 恢复 `aria-hidden` 与
  inline `display`（原始值由 `guardedElementSnapshots` 记录）；同时 MutationObserver 增加
  `characterData` 监听，并在 0/400/800/1200/1600/2600/3200ms 补扫，workspace 就绪后 trigger 自动恢复，
  而真正的 `添加工作区` / 菜单项 / `*打开新建工作区` 仍按当前 label 保持隐藏；
- **点击兜底**：iframe 文档 capture 阶段 `click` / `pointerdown` 命中即
  `preventDefault + stopImmediatePropagation`，并通过
  `parent.postMessage({ type:'dsh-mobile-toast', text:'手机端暂不支持该操作（需在电脑端选择）' }, '*')`
  （无工作区空状态用专用文案）让壳层 toast（700ms 去重，`blockedAction` 写入诊断）；
- **不误伤**：「选择工作区」触发器（有工作区时）、已有工作区切换项（默认工作区等）、会话列表、搜索/视图、
  上传文件（WebView 自带 file chooser 可用）均保持可用；判断时先排除
  `[class*="session"]` / composer 区域（**空状态 chooser 例外**，它位于 composer 内但会先被空状态判定拦截）；
- APK 全屏模式同样生效（同一注入层）。

### 9. 交互 / 显示细节

- iOS/Android 键盘：`--app-height` 跟随 `visualViewport.height`，iframe 随之收缩；基线高度差判定键盘打开
  （`data-keyboard="open"`）时隐藏 Dock 与胶囊；
- 禁用双击缩放/点击高亮：`viewport maximum-scale=1`、`touch-action: manipulation`、
  `-webkit-tap-highlight-color: transparent`（外壳与 iframe 内都处理）；
- 输入框字号 ≥16px（`(pointer: coarse)` 下）防止 iOS 聚焦自动放大；正文/代码字号在手机上略增；
- 底部安全区 `env(safe-area-inset-bottom)`、刘海 `env(safe-area-inset-top)`、横屏紧凑布局；
- 过渡动画轻柔（180–340ms `cubic-bezier`/spring），完整兼容 `prefers-reduced-motion`；无外部图片/字体。

## 与插件核心的契约

外壳只依赖以下接口（实现见 `../lib/bridge.js`，归 plugin-core 所有，本目录不修改）：

```text
GET  /m/api/state -> 200 { ok, paired, host, dshUrl:"/", pinRequired }
POST /m/api/pair  { code } -> 200 { ok:true, url, expiresInMs }
                           -> 401 { ok:false, error:"bad-pin", attemptsLeft? }
                           -> 429 { ok:false, error:"locked", retryAfterMs } + Retry-After
GET  /?token=…    -> 303 + Set-Cookie（DSH 登录，代理到桌面 GUI）
GET  /            -> 代理后的真实 DSH Web GUI（未认证时为 401 纯文本认证页）
GET  /m/download/DSH-Mobile.apk -> 安卓安装包（静态文件）
```

E2E DOM/行为契约（`tests/e2e.test.mjs` 断言，不能被破坏）：`<title>DSH Mobile</title>`、
`lang="zh-CN"`、viewport `width=device-width` + `viewport-fit=cover`、`rel="manifest" href="./manifest.webmanifest"`、
`#pairingView`、`#pairForm`、6×`.pin-cell`、`#guiFrame[src="about:blank"]`、`#offlineBanner`、
`#diagBtn`（快捷 sheet 中的诊断动作）、`./app.css?v=…` / `./app.js?v=…`（deferred），以及 app.js 中的
`/m/api/state`、`/m/api/pair`、`guiFrame`、`dsh-mobile-adaptive-style` 字符串。

所有资源引用均为相对路径，因此无论插件监听地址的 LAN IP 是什么都能工作。
`app.css` / `app.js` 带 `?v=0.3.6` 版本查询串，用于绕过静态资源的 1h 缓存。

## 本地开发（无需 DSH / 无需插件）

```powershell
# 默认 127.0.0.1:7862，PIN 123456，初始未配对
node packages/dsh-plugin-mobile-bridge/public/dev/mock-server.mjs --port 7862

# 启动即已配对（直接看主 iframe 界面）
node .../mock-server.mjs --port 7862 --paired

# 自定义 PIN / 端口
node .../mock-server.mjs --port 7862 --pin 654321
```

打开 <http://127.0.0.1:7862/m/>：

- 配对页：用页面数字键盘输入 `123456`（6 位自动提交）；错误 PIN 抖动并提示剩余次数；
  连续输错 8 次触发 429 锁定（30 秒倒计时）。
- 登录成功后自动切换到嵌入的假 GUI（可看到“模拟登录失效”按钮，用来验证 401 检测后回退配对页）。
- `http://127.0.0.1:7862/__mock/pair` 直接设置 Cookie 并跳转 `/m/`；`POST /__mock/logout` 清除；
  `GET /__mock/reset` 重置锁定与 token。`--paired` 时 `/__mock/logout` 也会关闭强制配对。
- 开发手机调试：同一局域网手机打开 `http://<电脑IP>:7862/m/`（mock 默认只监听 127.0.0.1，
  需要 `--host 0.0.0.0`）。
- 模拟 APK 模式：打开 `http://127.0.0.1:7862/m/?app=1`（或让 UA 包含 `DSHMobileApp/0.1`）。

> mock-server 仅用于开发；生产由插件按 `public/` 目录静态提供，不会执行这些脚本。

## 自动验证

```powershell
# 1) shell + mock 后端（无外部依赖，约 1 秒，31 项检查）
node packages/dsh-plugin-mobile-bridge/public/dev/verify.mjs

# 2) 无浏览器环境下的真实 app.js 运行时（DOM shim；浏览器模式 12 项）
node packages/dsh-plugin-mobile-bridge/public/dev/dom-smoke.mjs

# 2b) 同一套运行时在 APK 全屏模式下的检查（5 项）
node packages/dsh-plugin-mobile-bridge/public/dev/dom-smoke.mjs --app-mode

# 3) 真实插件桥 + 隔离 DSH（需要 8899 上的隔离实例与 token）
node packages/dsh-plugin-mobile-bridge/public/dev/smoke-real-bridge.mjs `
  --target http://127.0.0.1:8899 --token-file .test-home/ui-dsh.log --pin 112233

# 4) 真实 headless Chrome UI 测试（需要 Chrome/Edge；需要 7876 上运行中的 bridge）
node packages/dsh-plugin-mobile-bridge/public/dev/ui-smoke.mjs `
  --bridge http://127.0.0.1:7876 --pin 112233
```

`ui-smoke.mjs` 输出 `optimized-pair.png`、`optimized-main.png`、`optimized-sidebar.png`、
`optimized-quick-actions.png`、`optimized-apk.png`、`optimized-sidebar-guard.png` 与
`ui-smoke-report.json` 到 `dev/screenshots/`，并打印侧边栏简化断言结果（rail 宽度 / 主内容 x /
展开侧栏可见工作区）、桌面对话框屏蔽断言（入口隐藏 / 点击拦截 / 选择工作区可用）以及实际命中的
快捷操作选择器；任何非良性控制台错误都会让它以非零码退出。隔离 DSH + bridge 的启动方式：

```powershell
# .test-home/mobile-ui-patch.yml 覆盖 mobile-bridge 端口 7876 / PIN 112233
$env:DSH_HOME = '<workspace>\.test-home'
& 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd' --patch '<workspace>\.test-home\mobile-ui-patch.yml' `
  --profile web --no-open --host 127.0.0.1 --port 8899
```

> 说明：委托代理（subagent）会话的沙箱依旧禁止 Chromium 启动（mojo 命名管道被拒），
> 因此 `ui-smoke.mjs` 由具备浏览器权限的 Lead 会话执行；`dom-smoke.mjs` 是本沙箱内最接近
> 浏览器运行时的自动验证。全量回归：`tests\run-all.ps1`（10/10）。

## 重新生成图标

```powershell
node packages/dsh-plugin-mobile-bridge/public/dev/gen-icons.mjs
```

## 手机端适配细节

注入到真实 GUI iframe 的 CSS（`buildAdaptiveCss()`）刻意保持**非破坏性**：

- `html`/`body`/`#root` 使用 `100dvh`，修复 iOS 动态地址栏与 iframe 高度问题；
- 注入 `--dsh-mobile-safe-*` 安全区变量（`env(safe-area-inset-*)`）与 APK 模式下的
  `--dsh-mobile-app-top/bottom`；实际安全区由外壳在 iframe 外预留，因为 iframe 内 `env()` 可能为 0；
- `overflow-x: hidden`、`overscroll-behavior: none`、`touch-action: manipulation`，避免横向滚动、滚动链与双击缩放；
- `@media (pointer: coarse)` 下把输入框/可编辑区字号提升到 ≥16px，阻止 iOS 聚焦自动放大；
- 桌面端稳定 data 钩子（非哈希类名）：`[data-shell-overlay]`/`[data-rightbar-col]` 限制在 `100vw`，
  `[data-shell-bottom]`（输入区）保持可见、不隐藏；`html[data-windows-titlebar]` 若出现则清零其
  caption 预留高度（Windows Electron 专用标记，普通浏览器文档一般没有）；
- **侧边栏简化（v0.3.6）**：收起态 `[data-sidebar-collapsed="true"]` 的 frame 强制三列网格为
  `0px minmax(0px,1fr) 0px`，第一列（56px 图标栏）用 `visibility: hidden` 隐藏并回收宽度
  （必须保留网格占位，`display:none` 会让 centerCol 变 0 宽导致主内容空白）；
  展开态只保留工作区内容，`[class*="brand"]` / `[class*="newSession"]` / `[class*="panelRow"]`
  以及 `插件`/`自动化任务`/`账号菜单` 行全部隐藏；Dock「会话」通过这个轨道上的原生 toggle 打开/关闭；
- **桌面对话框屏蔽（v0.3.6）**：`buildAdaptiveCss()` 追加已知入口隐藏规则；注入 JS
  在 iframe 文档上安装 `MutationObserver` + capture `click`/`pointerdown` 兜底，
  命中动作词的元素统一加 `data-dsh-mobile-blocked="1"` / `aria-hidden="true"` / `display:none`，
  点击被拦截并通过 `postMessage({type:'dsh-mobile-toast'})` 通知壳层 toast；会话/composer 区域不参与匹配；
- 设置页「字号」90/100/110/125%（localStorage 持久化）同时作为外壳字号与注入 GUI 的 `zoom`，
  Safari 17.4+ 支持 `zoom`；默认 100% 不生效。

安全区由外壳负责：状态胶囊使用 `env(safe-area-inset-top)`（APK 模式叠加 `--apk-top-inset`），
iframe 容器底部预留 Dock strip 与 `env(safe-area-inset-bottom)` 并将滚动条底色对齐 GUI 主题色
（`data-ds-dark-theme`），避免 Home 指示条/Dock 遮挡输入区。

## 兼容性与限制

- 目标浏览器：移动版 Chromium（Android）与 Safari（iOS 16+）；桌面浏览器仅作预览（居中手机宽列）。
- 依赖同源 iframe：插件必须同时代理 `/` 与 `/m/`（当前架构如此）。
- 401 检测基于同源 `contentDocument` 文本/标题包含 `authentication required`/`unauthorized`
  以及隐藏 iframe 登录后的 `/m/api/state` 复核；若未来 DSH 认证页文案变化，只需改
  `detectAuthPage()`。
- 隐藏 iframe 登录依赖浏览器允许同源 Cookie；极端情况下自动回退“手动登录”整页导航。
- 快捷操作依赖 DSH GUI 的 `aria-label`（已验证 zh/en 两套词典）；DSH 若改动按钮标签，
  「新建」会自动隐藏、Dock「会话」会降级为外壳会话抽屉，不会误触；更新
  `GUI_ACTION_SELECTORS` / `GUI_ACTION_PATTERNS` 即可恢复。
- 侧边栏简化依赖真实 GUI 的 `[data-sidebar-collapsed="true"]` frame 属性与三个 `class*` 命名
  （`brand` / `newSession` / `panelRow`）以及 `插件`/`自动化任务`/`账号菜单` aria-label；
  DSH 若改结构，主界面最多退回「图标栏可见」，Dock 会话 toggle 仍按 aria-label 工作。
- 桌面对话框屏蔽依赖真实 GUI 的动作文案/aria-label；DSH 若新增其它桌面专属入口，
  只需扩充 `DESKTOP_DIALOG_PATTERN` / `DESKTOP_DIALOG_HIDE_SELECTORS`；匹配器先排除会话与
  composer 区域，因此不会误伤会话标题、工作区切换或上传。无工作区空状态由
  `EMPTY_WORKSPACE_STATE_PATTERN` / `isWorkspaceChooserInEmptyState()` 识别：只有页面明确处于空状态
  且 trigger 不显示真实工作区名时才屏蔽，避免误伤正常的工作区下拉。
- 外壳会话抽屉（降级路径）的 GUI 抓取是基于真实侧栏 DOM 的启发式（排除已知控件 + 可见文本按钮）；
  DSH 结构大改时自动降级到「打开桌面会话列表」，功能可用性不受影响。
- 无 Service Worker：局域网 HTTP 非安全上下文，PWA 安装/全屏体验在 Safari“添加到主屏幕”和
  Android Chrome 的“安装应用”下可用；不承诺离线打开。
- 诊断信息会隐去 URL 中的 `token` 参数，配对 token 不写入日志或 localStorage。
