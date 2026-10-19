# DSH Mobile Bridge v0.4.0

把桌面 **DeepSeek Harness (DSH)** 装进手机：局域网配对即用，无需在手机上安装 DSH/模型客户端。

## 组件

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Cordis 插件 | **0.4.0** | `packages/dsh-plugin-mobile-bridge`，自带 LAN 反向代理 + PIN 配对 + WebSocket 隧道 |
| 手机 Web 页面 | **0.3.20** | PWA/浏览器直达真实桌面 GUI，移动适配（底部 Dock、侧边栏、快捷面板） |
| 安卓 App | **0.2.3** | 轻量 WebView 外壳（APK），全屏沉浸、可切换局域网/外网地址 |

## 功能

- 6 位 PIN 配对；手机与电脑同一 Wi-Fi 时打开页面即可控制桌面 DSH。
- 手机端就是真实 DSH GUI（同源 iframe）：会话、模型、工具、审批、终端/文件侧栏全部可用。
- 移动端体验增强：
  - 主界面隐藏侧边栏，点 Dock「会话」弹出、点会话后自动切换并收起；
  - 侧边栏只保留「工作区」；顶部功能按块换行，不挤在一条线上；
  - 桌面专用入口（打开/新建工作区、文件夹对话框等）在手机上隐藏并拦截；
  - 软键盘弹出时输入框保持可见（APK v0.2.3）；切换会话/加载后不自动弹键盘；
  - 浮动胶囊、玻璃 Dock、快捷操作面板、诊断/设置页。
- **外网访问（可选）**：`scripts/external-access.ps1` 一键弹出隧道（localhost.run / serveo / cloudflared），打印外网地址 + 访问码，手机在移动网络下输入访问码即可使用。
- 安全：PIN 限流、Cookie 会话、桌面配对页/健康检查仅本机可访问（隧道流量会被拒绝）。

## 安装

1. 下载 `dsh-plugin-mobile-bridge-v0.4.0.zip`，解压到任意目录。
2. 在 DSH 桌面端退出后执行：

```powershell
dsh plugin add <解压目录>\dsh-plugin-mobile-bridge
```

3. 启动 DSH → 桌面右下角/配对页 <http://127.0.0.1:7860/m/pair> 查看配对信息。
4. 手机浏览器打开配对页里列出的 `http://<电脑IP>:7860/m/`，输入 6 位 PIN。
5. 安卓用户可直接安装 Release 附件 `DSH-Mobile-0.2.3.apk`（全屏体验更好）。

> 详细安装、卸载、排障见仓库 `README.md` 与 `docs/mobile-install.md`。

## 外网访问

```powershell
powershell -ExecutionPolicy Bypass -File scripts\external-access.ps1
```

按提示在手机打开外网地址并输入访问码即可（用完 Ctrl+C 关闭隧道）。

## 已知限制

- 仅在你自己的电脑/局域网内使用；外网访问依赖第三方隧道，速度与稳定性受线路影响。
- APK 为本地自签名侧载包；升级需同一 keystore 签名。
- 旧版华为 WebView（UA 报 Chrome 99）由网关注入的兼容补丁支持。

**SHA256**：见 Release 附件 `SHA256SUMS.txt`。
