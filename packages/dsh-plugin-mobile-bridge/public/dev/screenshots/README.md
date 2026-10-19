# 截图目录（`optimized-*.png`，由 `dev/ui-smoke.mjs` 生成）

本目录存放手机视口（390×844）下的 shell 截图，供 Lead/QA 做 **v0.3.6「沉浸式原生」** 视觉验收。
截图由 **`dev/ui-smoke.mjs`（真实 headless Chrome + CDP）** 自动生成；它同时验证配对流程、
真实 DSH GUI iframe + 玻璃 Dock、**侧边栏简化（主界面无图标空列、Dock 会话弹出仅工作区的真实侧栏）**、
**桌面对话框屏蔽（添加/打开工作区入口隐藏 + 点击兜底 + 选择工作区仍可用）**、快捷 sheet、
APK 全屏模式，并输出 `ui-smoke-report.json`。

## 生成方式（需要浏览器权限）

```powershell
# 1) 启动隔离 DSH（8899）+ 内置 bridge（7876 / PIN 112233）
$env:DSH_HOME = '<workspace>\.test-home'
& 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd' --patch '<workspace>\.test-home\mobile-ui-patch.yml' `
  --profile web --no-open --host 127.0.0.1 --port 8899

# 2) 运行 headless Chrome UI 测试（Chrome/Edge 自动查找，可用 --chrome 指定）
node packages/dsh-plugin-mobile-bridge/public/dev/ui-smoke.mjs --bridge http://127.0.0.1:7876 --pin 112233
```

脚本会打印侧边栏简化与桌面对话框屏蔽断言结果、每条检查的 PASS/FAIL、非良性控制台错误（若有），
并写入以下文件：

| 文件 | 内容 |
| --- | --- |
| `optimized-pair.png` | 390×844 配对页：品牌 hero、等待配对胶囊、6 格 PIN、数字键盘、扫码占位、安卓 App 下载入口 |
| `optimized-main.png` | 配对后：真实 DSH GUI 在 iframe 内、**左侧图标栏已隐藏（无 56px 空列，主内容全宽）**、悬浮状态胶囊、玻璃 Dock |
| `optimized-sidebar.png` | 点 Dock「会话」后：真实 GUI 侧边栏展开，**仅保留工作区内容**（brand/新建会话/插件/自动化任务/账号菜单均已隐藏），Dock 会话项高亮 |
| `optimized-quick-actions.png` | Dock「更多」打开的快捷操作 sheet（会话列表/新会话/刷新/诊断/设置/断开） |
| `optimized-apk.png` | APK 全屏模式（UA `DSHMobileApp/0.1` + `?app=1`）：图标栏同样隐藏、胶囊默认隐藏、GUI iframe 从 y=0 开始、Dock 保留、顶部不占布局的可恢复热区 |
| `optimized-sidebar-guard.png` | 展开「选择工作区」下拉菜单：`添加工作区…` 菜单项被隐藏/标记，**选择工作区触发器与已有工作区项仍可见可用**；侧栏 `[aria-label="添加工作区"]` 为 `display:none` |
| `ui-smoke-report.json` | 检查结果、耗时、截图路径、侧边栏简化证明、桌面对话框屏蔽证明（隐藏/拦截/toast）、APK 模式状态、控制台错误 |

## 脚本自动断言

1. 浏览器模式 390×844：配对页可见、6 个 PIN 格、11 键数字键盘、配对页无胶囊/无 Dock、安卓下载入口存在；
2. 数字键盘输入 PIN → 隐藏 iframe 换 Cookie → 真实 GUI iframe 渲染、注入
   `dsh-mobile-adaptive-style`（100dvh / 安全区变量 / `[data-shell-bottom]` / 16px 输入防缩放 / APK inset 变量 /
   侧边栏简化规则 / 桌面对话框隐藏规则），胶囊与 Dock 可见；
3. **侧边栏简化**：
   - 主界面：GUI frame 带 `data-sidebar-collapsed="true"`，第一列 rail `visibility:hidden` 且宽度 ≤1px，
     grid 第一列为 `0px`，主内容列 x≈0 且宽≈视口宽（无 56px 空列）；Dock 会话未选中、shell 抽屉未打开；
   - 点 Dock「会话」→ 真实侧边栏展开：`打开侧边栏` 变为 `收起侧边栏`、侧栏宽度 >120px、
     `[class*="brand"]`/`[class*="newSession"]`/`[class*="panelRow"]`/插件/自动化任务/账号菜单 全部计算样式为隐藏、
     `[class*="workspace"]` 可见且侧栏文本含「工作区」；Dock 会话高亮；shell 抽屉仍未打开；
   - 再点 Dock「会话」→ 恢复收起：rail 再次 hidden/0px，主内容回到 x≈0 全宽，Dock 取消选中；
   - Dock「更多」→ 快捷 sheet ≥6 动作且含 `#diagBtn`；Dock「新建」→ toast「已新建会话」；
4. **桌面对话框屏蔽（v0.3.6，真实 GUI，双环境感知）**：
   - 先读取 GUI 是否处于「无工作区」空状态（`无法创建默认工作区` / `暂无工作区` / `选择一个工作区` 等文案）：
   - **有工作区（live 桌面）**：Dock 会话展开侧栏后「选择工作区」触发器可见、未被标记 blocked；
     点开下拉菜单 → `[aria-label="添加工作区"]` 计算样式 `display:none`、`添加工作区…` 菜单项被隐藏、
     已有工作区切换项可见且未被标记；对隐藏入口 `.click()` → capture 守卫拦截（GUI 处理器计数 0），
     toast「手机端暂不支持该操作（需在电脑端选择）」；选择工作区与已有工作区项保持可用；
   - **无工作区（隔离 DSH 空状态）**：「选择工作区」命令入口同样会弹电脑端目录对话框，因此 guard 会把它
     标记 `data-dsh-mobile-blocked="1"` 并隐藏，`[aria-label="添加工作区"]` 亦隐藏；`.click()` 被拦截并
     toast「手机端暂不支持，请在电脑端打开/新建工作区」；不会出现工作区下拉菜单；
   - 两种环境都恢复主界面全宽（无白屏/无报错）；
5. APK 模式：UA 覆盖 + `?app=1` 重新打开（复用同一浏览器 Cookie）→ 断言 `data-mode="apk"`、
   `html.dsh-app`、胶囊 opacity<0.05、**rail 隐藏且宽度 0**、**GUI iframe top <2px**、
   iframe 填满 Dock 以上区域、Dock 仍可见、可恢复热区 `position:absolute` 且高度≤24px、
   `--apk-top-inset` 变量存在；再点击热区断言 mini 胶囊真实拉出（opacity>0.5）后可收起；
6. 收集 `Runtime.exceptionThrown` / `console.error` / `Log.error`，除 favicon/net::ERR_ABORTED 等
   良性项外任何错误都会导致测试失败（非零退出码）。

> 说明：委托代理（mobile-app）的沙箱禁止 Chromium 启动（mojo 命名管道被拒），
> 该脚本由具备浏览器权限的 Lead 会话执行；代理侧已用 `dev/dom-smoke.mjs`（浏览器模式 12 项 +
> `--app-mode` 5 项）在 DOM 层覆盖同一批状态机（含侧边栏展开/收起、降级抽屉与桌面对话框守卫、
> 无工作区空状态保护）。
