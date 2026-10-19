# DSH Mobile — Android WebView 套壳 APK

把桌面 DSH 的手机端页面（默认 `http://192.168.17.174:7860/m/`）包成一个可安装的原生 Android 应用。
纯 framework API + 手工工具链构建（**不使用 Gradle / AndroidX / Android Studio**）。

## 产物

| 项目 | 值 |
| --- | --- |
| APK | `android/build/DSH-Mobile-0.2.3.apk`（稳定副本 `android/build/DSH-Mobile.apk`，内容相同） |
| 大小 | **70,678 字节（约 65.0 KiB）** |
| SHA-256 | **`850120E6BFE87B0A22F91FB7F38C4D31FD46372413718B695323CFF7E74B570B`** |
| 包名 / 版本 | `ai.deepseek.dshmobile`，versionCode 5，versionName 0.2.3 |
| minSdk / targetSdk / compileSdk | 26 / 34 / 34 |
| 应用名 | DSH Mobile |
| 入口 | `ai.deepseek.dshmobile.MainActivity` |
| 权限 | 仅 `android.permission.INTERNET` |
| 签名 | v1(JAR) + v2 + v3；自签名调试证书，见下文 |
| 证书 SHA-256 | `CD:3E:09:C6:69:01:83:B9:1C:56:EF:C6:B0:23:4C:AE:D1:50:E3:80:83:B2:B3:2B:C8:79:CD:69:E0:0D:03:5D` |

下载后校验：

```powershell
Get-FileHash .\DSH-Mobile-0.2.3.apk -Algorithm SHA256
# 850120E6BFE87B0A22F91FB7F38C4D31FD46372413718B695323CFF7E74B570B
```

## 功能

- **WebView 壳**：JavaScript/DOM storage/Database、mixed content 全部允许、第三方 Cookie、媒体自动播放、宽视口；
  UA 追加后缀 **` DSHMobileApp/0.1`**（页面可据此切换 APK 全屏模式），加载地址自动追加 `?app=1`。
- **原生设置页**（简体中文）：标题「连接桌面 DSH」、说明「同一 Wi-Fi 下输入电脑上的手机访问地址」、
  预填默认地址、按钮「连接」「在当前页面重试」「返回页面」、底部提示「地址形如 http://192.168.x.y:7860/m/，可在电脑配对页查看」。
  地址校验：缺 scheme 自动补 `http://`；只有主机/端口时自动补 `/m/`；保存进 SharedPreferences，下次直接进页面。
- **错误恢复**：主框架加载失败自动回到设置页并显示错误原因，可一键重试；硬件返回键 = 历史后退，回到根页面时按一次返回键呼出设置页，再连按两次退出。
- **深色 edge-to-edge**：状态栏透明 + 浅色图标，导航栏 `#0b0f19`；`LAYOUT_FULLSCREEN|LAYOUT_STABLE` + `FLAG_LAYOUT_NO_LIMITS`，
  decor `fitsSystemWindows=false`，页面按状态栏高度做原生避让（页面内容永不压在状态栏下面）。
- **文件选择**：`onShowFileChooser` → `ACTION_GET_CONTENT`（多选、任意类型），`startActivityForResult` 回传 Uri[]。
- **下载**：`DownloadListener` → `DownloadManager`（通知栏显示、Toast「已开始下载」）。API 29+ 写公共 Downloads 目录；API 26–28 写应用专属 Downloads 目录（为了只申请 INTERNET 权限）。
- **外部链接**：host 不是当前 DSH 服务器时用 `ACTION_VIEW` 交给系统浏览器；同 host 留在 WebView。
- **JS 接口** `window.DshApp`（`@JavascriptInterface`）：`getTopInsetPx()` / `getAppVersion()` / `isApp()` / `openSettings()` / `reload()` / `exitApp()` / `loadUrl(url)`。页面可以忽略。
- **旋转/键盘不重载**：manifest `configChanges=orientation|screenSize|smallestScreenSize|keyboardHidden|density|uiMode`，`adjustResize`。
- **启动传参**：`ACTION_VIEW`（http/https 的 data，或 `dsh_url` extra，或 `dshmobile://...?url=`）可直接指定地址。
- **明文 HTTP**：`android:usesCleartextTraffic="true"`。

## 目录结构

```
android/
  AndroidManifest.xml        # 包名/版本/SDK/权限/Activity/主题/configChanges
  src/ai/deepseek/dshmobile/MainActivity.java   # 全部逻辑（约 850 行，单 Activity）
  res/
    values/{strings,colors,styles}.xml          # 中文文案、深色主题 Theme.Material.NoActionBar
    drawable/bg_{input,button_primary,button_secondary}.xml  # 圆角输入框/按钮
    mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png  # 48/72/96/144/192，取自 PWA 图标
  build.ps1                  # 一键构建 + 签名 + 全套验证
  setup-toolchain.ps1        # 可选：没有现成工具链的机器上下载 JDK17 + Android SDK
  keystore/dsh-mobile.jks    # 自签名调试 keystore（已生成，见下文密码）
  build/                     # 构建中间产物 + APK + 验证记录 VERIFICATION.txt + 真机证据图
  artifacts/                 # 真机证据（截图/UI dump/VERIFICATION.txt 的原始副本）
```

## 工具链（自动探测，无需在本机下载）

构建脚本只**读**工具链目录，不会修改它。探测顺序（`build.ps1` 与 `setup-toolchain.ps1` 一致）：

1. 环境变量 `DSH_ANDROID_TOOLCHAIN`（指向包含 `jdk\` 与 `sdk\` 的目录）；
2. `android/toolchain/`（`setup-toolchain.ps1` 的默认下载位置）；
3. `D:\ai\android-toolchain`（本机已有，本次构建实际使用）。

本次构建实际使用（`D:\ai\android-toolchain`）：

- Temurin **JDK 17.0.20.1+1**（`jdk\bin\java.exe`、`javac.exe`、`jar.exe`、`keytool.exe`）
- **build-tools 34.0.0**：`aapt2.exe`（aapt 2.19-10229193）、`d8.bat`、`apksigner.bat`、`zipalign.exe`
- **platforms;android-34**（`android.jar`，compileSdk 34）
- platform-tools（`adb.exe`，本次真机验证用）

其它机器上如果没有工具链，先运行：

```powershell
cd android
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-toolchain.ps1
```

它会下载 Temurin JDK 17 zip + `commandlinetools-win-11076708_latest.zip`，解压到 `android\toolchain\{jdk,sdk}`，
再用 `sdkmanager` 安装 `platforms;android-34`、`build-tools;34.0.0`、`platform-tools`（自动接受 license）。
若已有工具链则直接跳过。

> 本机 PowerShell 是 **Windows PowerShell 5.1**（PATH 中没有 `pwsh`），因此命令用 `powershell.exe`；
> `pwsh` 7 下同样可以运行这两个脚本。

## 构建（一键）

```powershell
cd android
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

脚本流程：清空 `build/` → aapt2 compile → aapt2 link（生成 base.apk + R.java）→ javac →
d8（--min-api 26）→ `jar --update` 把 `classes.dex` 放进 APK → `zipalign -f -p 4` →
首次自动 `keytool -genkeypair` 生成 keystore → `apksigner sign --v1/--v2/--v3` →
`apksigner verify --verbose --print-certs` → `zipalign -c -v 4` → `aapt2 dump badging` → 检查 ZIP 条目 →
复制 `DSH-Mobile.apk` → 打印大小与 SHA256。

等价的完整手工命令（供排错/理解，全部在 `android\` 下执行，`$SDK=D:\ai\android-toolchain\sdk`、`$JDK=D:\ai\android-toolchain\jdk`）：

```powershell
$env:JAVA_HOME = "$JDK"; $env:Path = "$JDK\bin;$SDK\build-tools\34.0.0;$env:Path"
$BT = "$SDK\build-tools\34.0.0"; $JAR = "$SDK\platforms\android-34\android.jar"

New-Item -ItemType Directory -Force build\gen,build\classes,build\dex | Out-Null

& $BT\aapt2.exe compile --dir res -o build\compiled_res.zip

# 注意：编译后的资源包是「位置参数」，aapt2 的 -R 只用于 overlay，用它链接会报
# "resource ... does not override an existing resource"。
& $BT\aapt2.exe link -o build\base.apk -I $JAR --manifest AndroidManifest.xml `
    build\compiled_res.zip --java build\gen --min-sdk-version 26 --target-sdk-version 34 `
    --version-code 5 --version-name 0.2.3

$srcs = @('src\ai\deepseek\dshmobile\MainActivity.java') + (Get-ChildItem build\gen -Recurse -Filter *.java).FullName
& $JDK\bin\javac.exe -source 8 -target 8 -encoding UTF-8 -Xlint:-options -classpath $JAR -d build\classes @srcs

$classes = (Get-ChildItem build\classes -Recurse -Filter *.class).FullName
& $BT\d8.bat --release --min-api 26 --lib $JAR --output build\dex @classes

& $JDK\bin\jar.exe --update --file build\base.apk -C build\dex classes.dex
& $BT\zipalign.exe -f -p 4 build\base.apk build\aligned.apk

& $JDK\bin\keytool.exe -genkeypair -keystore keystore\dsh-mobile.jks -alias dshmobile `
    -keyalg RSA -keysize 2048 -validity 10000 -storepass dshmobile123 -keypass dshmobile123 `
    -dname "CN=DSH Mobile, OU=Mobile Bridge, O=DSH, L=Local, S=Local, C=CN" -noprompt

& $BT\apksigner.bat sign --ks keystore\dsh-mobile.jks --ks-pass pass:dshmobile123 `
    --key-pass pass:dshmobile123 --ks-key-alias dshmobile `
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true `
    --out build\DSH-Mobile-0.2.3.apk build\aligned.apk

& $BT\apksigner.bat verify --verbose --print-certs build\DSH-Mobile-0.2.3.apk
& $BT\aapt2.exe dump badging build\DSH-Mobile-0.2.3.apk
Copy-Item build\DSH-Mobile-0.2.3.apk build\DSH-Mobile.apk
```

## 签名 / Keystore

- 文件：`android/keystore/dsh-mobile.jks`
- alias：`dshmobile`
- storePassword / keyPassword：`dshmobile123`
- 算法：RSA 2048，SHA256withRSA，有效期 10000 天
- DN：`CN=DSH Mobile, OU=Mobile Bridge, O=DSH, L=Local, ST=Local, C=CN`
- 证书 SHA-256：`CD:3E:09:C6:69:01:83:B9:1C:56:EF:C6:B0:23:4C:AE:D1:50:E3:80:83:B2:B3:2B:C8:79:CD:69:E0:0D:03:5D`

这是本地自签名调试 key（用户侧安装无需信任链，Android 允许 sideload）；**不要**用它发布到应用商店。
keystore 已随目录提供，重建时不会重新生成（仅首次缺失时生成），所以同一台机器重签的 APK 可覆盖安装。

### 关于 apksigner 的 "v1 scheme: false"

APK 同时打了 v1(JAR)/v2/v3 三种签名（ZIP 里有 `META-INF/MANIFEST.MF`、`META-INF/DSHMOBIL.SF`、`META-INF/DSHMOBIL.RSA`）。
`apksigner verify --verbose` 在 APK 声明 `minSdkVersion=26` 时只校验实际需要的 v2/v3，因此 v1 一栏显示 `false`（表示“未使用”，不是失败）。
想看到 v1 通过，强制以 minSdk 23 复验即可：

```powershell
& $BT\apksigner.bat verify --verbose --min-sdk-version 23 --max-sdk-version 34 build\DSH-Mobile-0.2.3.apk
# Verified using v1 scheme (JAR signing): true
# Verified using v2 scheme (APK Signature Scheme v2): true
# Verified using v3 scheme (APK Signature Scheme v3): true
```

`jarsigner -verify -strict` 同样输出 “jar 已验证”（自签名证书无信任链/无时间戳会附带 PKIX 警告，属预期）。

## 安装

1. **adb（已在本机真机执行成功）**
   ```powershell
   adb install -r android\build\DSH-Mobile-0.2.3.apk
   # Success
   ```
2. **手机上手动安装**：把 APK 传到手机 → 文件管理器打开 → 允许「安装未知应用」（设置 → 安全 → 安装未知应用）→ 安装。
3. 首次打开会进入原生设置页，默认地址已填好 `http://192.168.17.174:7860/m/`；手机与电脑连同一 Wi-Fi 后点「连接」。
4. 页面加载后按电脑配对页显示的 6 位 PIN 配对，即可在手机上使用 DSH。
5. 更换服务器：在设置页改地址（应用内返回键呼出设置，或页面调用 `window.DshApp.openSettings()`），
   也可以用 `adb shell am start -a android.intent.action.VIEW -e dsh_url "http://<电脑IP>:7860/m/" -n ai.deepseek.dshmobile/.MainActivity`。

> 若装的是新签名（换了 keystore），需要先卸载旧版本；正常重建不会换 key。

## 真机验证记录（本次）

- 设备：**HONOR HPB-AN00，Android 14（API 34）**，序列号 `A6SJUT2613000658`（USB，`adb devices` 可见）。
- `adb install -r` → `Success`，`firstInstallTime=2026-10-19 14:31:34`。
- 启动 `am start -n ai.deepseek.dshmobile/.MainActivity` → `mCurrentFocus=ai.deepseek.dshmobile/...MainActivity`，无崩溃。
- 原生设置页渲染正确（标题/说明/预填 URL/三个按钮/底部提示，见 `build/device-setup-screen.png` 与 `build/device-setup-ui.xml`）。
- WebView 成功加载局域网移动页面（`http://192.168.17.174:7860/m/?app=1`，配对视图/加载视图可见，见 `build/device-webview-pairing.png`、`build/device-webview-loading.png`；`build/device-webview-ui.xml` 同时包含 WebView 与原生节点）。
- 网络：手机 `wlan0=192.168.17.156/22`，电脑 `192.168.17.174`，同一 Wi-Fi/网段；电脑 ping 被 ICMP 拦截，但手机侧 `curl http://192.168.17.174:7860/m/` 返回 **HTTP 200**（TCP 通）。
- 完整 PIN 配对链路：测试时桌面端页面正处于另一 teammate 的在线更新中（新旧资源混合），因此配对 E2E 留待页面稳定后由 Lead 在真机上完成，不影响 APK 本身。
- adb 环境时间点：2026-10-19 14:31–14:34（Asia/Shanghai）。

原始验证输出见 `build/VERIFICATION.txt`（同样的副本在 `artifacts/VERIFICATION.txt`）。
`build/` 是构建产物目录，重新运行 `build.ps1` 会清空并重生成（真机证据的权威副本在 `artifacts/`）。

## 修改默认服务器地址

1. **改源码默认值**：`src/ai/deepseek/dshmobile/MainActivity.java` 里的
   `private static final String DEFAULT_URL = "http://192.168.17.174:7860/m/";`，重新 `build.ps1`。
2. **运行时**：设置页里直接改（保存在 SharedPreferences `dsh_prefs/server_url`），下次启动自动使用。
3. **启动参数**：`dsh_url` extra / `dshmobile://` 链接（见上）。

## 实现要点 / 与任务书的小偏差

1. **工具链**：任务书建议下载 JDK/SDK 到 `android/toolchain/`；实际按 Lead 指示改用本机已有的
   `D:\ai\android-toolchain`（只读使用），`setup-toolchain.ps1` 保留为无工具链机器上的回退方案。
2. **aapt2 link**：编译资源包用位置参数传入（任务书示例里的 `-R` 在 aapt2 中是 overlay 参数，会链接失败）。
3. **edge-to-edge 避让**：窗口按任务书要求做 edge-to-edge（透明状态栏 + `LAYOUT_FULLSCREEN/STABLE` + `FLAG_LAYOUT_NO_LIMITS`），
   但页面内容没有依赖 CSS `env(safe-area-inset-*)`（WebView 对 safe-area 的暴露并不稳定），而是由原生层按状态栏高度
   padding 避让，视觉效果仍是深色通栏、内容不被遮挡；同时通过 `DshApp.getTopInsetPx()` 把状态栏高度暴露给页面，页面需要时可自行使用。
4. **下载目录**：API 29+ 用 `DownloadManager` 写公共 Downloads（带通知）；API 26–28 写应用专属 Downloads 目录，
   以维持「只申请 INTERNET 权限」的约定（否则 26–28 需要运行时存储权限）。
5. **ACTION_VIEW**：代码支持显式指定组件时的 `ACTION_VIEW`（http/https data 或 `dsh_url` extra），
   但 manifest 里没有注册通用 http(s) 的 VIEW filter（只注册了 `dshmobile://`），避免抢走系统里其它 http 链接。
6. **无模拟器**：验证使用真实设备 adb；未跑 instrumentation 测试，UI 行为通过 uiautomator dump + 截图核对。
7. **v1 签名**：见上文说明（三种签名都已启用，apksigner 默认只报告所需的 v2/v3）。

## 已知限制 / 风险

- 没有 AndroidX：文件选择、下载、外链都用系统 Intent；不同厂商 ROM 的“未知来源安装”和后台下载行为可能有差异。
- 自签名证书：升级安装必须使用同一个 keystore（本仓库已附带）；换 key 需先卸载。
- 明文 HTTP：按局域网自托管场景开启，请只在可信 Wi-Fi 下使用。
- 真机 PIN 配对 E2E 未在本次构建窗口内跑完（桌面移动页正在更新），页面稳定后由 Lead 复测。
- 页面若跳转到别的域名，会交给系统浏览器而不是留在 App 内（这是刻意设计）。
- 最低 Android 8.0（API 26）；未在 API 26–33 真机上实测。

## v0.2.0（配合手机端重设计，2026-10-19）

- 版本：versionCode **2** / versionName **0.2.0**；文件 `android/build/DSH-Mobile-0.2.3.apk`（稳定副本 `DSH-Mobile.apk`），大小 **70,678 字节**，SHA-256 `850120E6BFE87B0A22F91FB7F38C4D31FD46372413718B695323CFF7E74B570B`。
- 页面：APK 只是 WebView 外壳，H5 页面由桌面插件（`public/`）实时提供，因此安装本 APK 即获得 v0.3 新设计（与浏览器 H5 同源；后续页面升级无需重装 APK）。
- 新增：为便于本地排障启用 `WebView.setWebContentsDebuggingEnabled(true)`；可用
  `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + Chrome DevTools 检查 WebView。
- 兼容：旧版华为 WebView / 局域网 HTTP（非安全上下文）的 JS 兼容补丁在桌面插件侧注入（`lib/proxy.js`），APK 无需额外配置。

## v0.2.1（服务器地址可编辑，2026-10-19）

- 版本：versionCode **3** / versionName **0.2.1**；文件 `android/build/DSH-Mobile-0.2.3.apk`，大小 **70,678 字节**，SHA-256 `850120E6BFE87B0A22F91FB7F38C4D31FD46372413718B695323CFF7E74B570B`。
- 新增：网页设置页「服务器地址」可直接填写/切换**局域网或外网隧道地址**（https），保存后 App 持久化并重连；原生连接页也支持外网地址（提示文案已更新）。
- 新增：配对页增加「更换服务器地址」入口；外网配对时输入桌面脚本打印的访问码（PIN）即可。
- 真机验证：手机切到 5G 移动数据（无法访问局域网），App 载入外网隧道地址 → 显示配对页 → 输入访问码 → 配对成功。

## v0.2.2（不再自动弹出键盘，2026-10-19）

- 版本：versionCode **4** / versionName **0.2.2**；文件 `android/build/DSH-Mobile-0.2.3.apk`，大小 **70,678 字节**，SHA-256 `850120E6BFE87B0A22F91FB7F38C4D31FD46372413718B695323CFF7E74B570B`。
- 修复：原生连接页/设置页打开时不再自动聚焦「服务器地址」输入框，软键盘只在用户点击输入框后弹出。
- 页面侧（v0.3.19）：切换会话/新建会话/界面加载完成后自动让输入框失焦，避免切换页面时弹键盘；会话点击后自动收起侧边栏。

## v0.2.3（软键盘适配，2026-10-19）

- 版本：versionCode **5** / versionName **0.2.3**；文件 `android/build/DSH-Mobile-0.2.3.apk`，大小 **70,678 字节**，SHA-256 `850120E6BFE87B0A22F91FB7F38C4D31FD46372413718B695323CFF7E74B570B`。
- 修复：全屏（edge-to-edge）窗口下软键盘不会自动 resize，导致聊天输入框被拼音输入法/候选词条挡住。现在通过 `WindowInsets.Type.ime()` 监听键盘高度并收缩 WebView（键盘关闭时按导航栏高度留白），输入框始终在键盘上方。
- 页面侧 v0.3.20：聚焦输入框/窗口 resize 后多次重算视口高度，作为 WebView 兼容兜底。
