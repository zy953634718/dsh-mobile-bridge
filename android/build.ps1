# DSH Mobile - manual APK build (aapt2 + javac + d8 + zipalign + apksigner, NO Gradle)
#
# Prerequisites: run .\setup-toolchain.ps1 once (downloads JDK 17 + Android SDK packages).
# Usage (from the android/ directory):
#     pwsh -ExecutionPolicy Bypass -File .\build.ps1
# Output:
#     build\DSH-Mobile-0.2.3.apk   (signed, installable)
#     build\DSH-Mobile.apk         (same file, stable name)
#
# Everything the script needs lives under android\toolchain\ and the build is fully reproducible
# from AndroidManifest.xml + src\ + res\ + keystore\ (the keystore is only generated when absent).

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

# ----------------------------------------------------------------------------------------------
# Toolchain resolution
#   1. $env:DSH_ANDROID_TOOLCHAIN  - path to a directory containing jdk\ and sdk\
#   2. <repo>\android\toolchain    - the local layout produced by setup-toolchain.ps1
#   3. D:\ai\android-toolchain     - pre-existing machine-wide toolchain (auto-detected)
# The directory is only READ; nothing inside it is modified.
# ----------------------------------------------------------------------------------------------
function Resolve-Toolchain {
    param([string]$Root)
    $candidates = @()
    if ($env:DSH_ANDROID_TOOLCHAIN) { $candidates += $env:DSH_ANDROID_TOOLCHAIN }
    $candidates += (Join-Path $Root 'toolchain')
    $candidates += 'D:\ai\android-toolchain'
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $java = Join-Path $candidate 'jdk\bin\javac.exe'
        $jar = Join-Path $candidate 'sdk\platforms\android-34\android.jar'
        if ((Test-Path $java) -and (Test-Path $jar)) {
            Write-Host "= toolchain: $candidate"
            return $candidate
        }
    }
    throw ("No Android toolchain found. Set `$env:DSH_ANDROID_TOOLCHAIN to a directory containing " +
        "jdk\ and sdk\, or run .\setup-toolchain.ps1 first. Tried: " + ($candidates -join '; '))
}

$ToolchainRoot = Resolve-Toolchain -Root $Root
$JdkDir = Join-Path $ToolchainRoot 'jdk'
$SdkDir = Join-Path $ToolchainRoot 'sdk'
$BuildTools = Join-Path $SdkDir 'build-tools\34.0.0'
$AndroidJar = Join-Path $SdkDir 'platforms\android-34\android.jar'
$Build = Join-Path $Root 'build'
$Keystore = Join-Path $Root 'keystore\dsh-mobile.jks'
$PkgDir = Join-Path $Build 'gen'
$ClassDir = Join-Path $Build 'classes'
$DexDir = Join-Path $Build 'dex'
$Unsigned = Join-Path $Build 'base.apk'
$Aligned = Join-Path $Build 'aligned.apk'
$ApkOut = Join-Path $Build 'DSH-Mobile-0.2.3.apk'
$ApkCopy = Join-Path $Build 'DSH-Mobile.apk'

$env:JAVA_HOME = $JdkDir
$env:Path = "$JdkDir\bin;$BuildTools;$env:Path"

$Javac = Join-Path $JdkDir 'bin\javac.exe'
$Jar = Join-Path $JdkDir 'bin\jar.exe'
$Keytool = Join-Path $JdkDir 'bin\keytool.exe'
$Aapt2 = Join-Path $BuildTools 'aapt2.exe'
$D8 = Join-Path $BuildTools 'd8.bat'
$Zipalign = Join-Path $BuildTools 'zipalign.exe'
$Apksigner = Join-Path $BuildTools 'apksigner.bat'

foreach ($tool in @($Javac, $Jar, $Keytool, $Aapt2, $D8, $Zipalign, $Apksigner, $AndroidJar)) {
    if (-not (Test-Path $tool)) { throw "missing tool: $tool (run setup-toolchain.ps1 first)" }
}

Write-Host '== java version'
& (Join-Path $JdkDir 'bin\java.exe') -version

if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
New-Item -ItemType Directory -Force -Path $PkgDir, $ClassDir, $DexDir | Out-Null

Write-Host '== [1/8] aapt2 compile'
$resZip = Join-Path $Build 'compiled_res.zip'
& $Aapt2 compile --dir (Join-Path $Root 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '== [2/8] aapt2 link (AndroidManifest + resources -> base.apk + R.java)'
# NOTE: compiled resources are passed positionally; -R is only for overlays in aapt2.
& $Aapt2 link -o $Unsigned -I $AndroidJar --manifest (Join-Path $Root 'AndroidManifest.xml') `
    $resZip --java $PkgDir --min-sdk-version 26 --target-sdk-version 34 `
    --version-code 5 --version-name 0.2.3
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '== [3/8] javac'
$sources = @(Join-Path $Root 'src\ai\deepseek\dshmobile\MainActivity.java')
$sources += (Get-ChildItem $PkgDir -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
& $Javac -source 8 -target 8 -encoding UTF-8 -Xlint:-options -classpath $AndroidJar -d $ClassDir @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '== [4/8] d8 (class files -> classes.dex)'
$classFiles = @(Get-ChildItem $ClassDir -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
$d8Args = @('--release', '--min-api', '26', '--lib', $AndroidJar, '--output', $DexDir) + $classFiles
& $D8 @d8Args
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }
if (-not (Test-Path (Join-Path $DexDir 'classes.dex'))) { throw 'classes.dex not produced' }

Write-Host '== [5/8] add classes.dex to base.apk'
& $Jar --update --file $Unsigned -C $DexDir classes.dex
if ($LASTEXITCODE -ne 0) { throw 'jar update failed' }

Write-Host '== [6/8] zipalign'
& $Zipalign -f -p 4 $Unsigned $Aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Write-Host '== [7/8] keystore'
if (-not (Test-Path $Keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Keystore) | Out-Null
    & $Keytool -genkeypair -keystore $Keystore -alias dshmobile -keyalg RSA -keysize 2048 `
        -validity 10000 -storepass dshmobile123 -keypass dshmobile123 `
        -dname 'CN=DSH Mobile, OU=Mobile Bridge, O=DSH, L=Local, S=Local, C=CN' -noprompt
    if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
    Write-Host "= generated $Keystore (password: dshmobile123, alias: dshmobile)"
} else {
    Write-Host "= reusing $Keystore"
}

Write-Host '== [8/8] apksigner sign'
# v1 (JAR) + v2 + v3 are all enabled explicitly so the APK verifies on every API level and the
# acceptance check for the JAR scheme passes too.
& $Apksigner sign --ks $Keystore --ks-pass pass:dshmobile123 --key-pass pass:dshmobile123 `
    --ks-key-alias dshmobile --v1-signing-enabled true --v2-signing-enabled true `
    --v3-signing-enabled true --out $ApkOut $Aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner sign failed' }
Copy-Item $ApkOut $ApkCopy -Force

Write-Host ''
Write-Host '== verification: apksigner verify --verbose --print-certs'
& $Apksigner verify --verbose --print-certs $ApkOut
Write-Host ''
Write-Host '== verification: zipalign -c -v 4'
& $Zipalign -c -v 4 $ApkOut
Write-Host ''
Write-Host '== verification: aapt2 dump badging'
& $Aapt2 dump badging $ApkOut
Write-Host ''
Write-Host '== verification: zip entries (classes.dex / AndroidManifest.xml / resources.arsc / META-INF)'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($ApkOut)
try {
    $names = $zip.Entries | ForEach-Object { $_.FullName }
    foreach ($needle in @('classes.dex', 'AndroidManifest.xml', 'resources.arsc', 'META-INF/MANIFEST.MF')) {
        if ($names -contains $needle) { Write-Host "= ok $needle" } else { Write-Host "= MISSING $needle" }
    }
    Write-Host "= entries: $($names.Count)"
} finally {
    $zip.Dispose()
}

$sha = (Get-FileHash $ApkOut -Algorithm SHA256).Hash
$size = (Get-Item $ApkOut).Length
Write-Host ''
Write-Host '================================================================'
Write-Host " APK:    $ApkOut"
Write-Host " Copy:   $ApkCopy"
Write-Host " Size:   $size bytes ($([math]::Round($size/1KB,1)) KB)"
Write-Host " SHA256: $sha"
Write-Host '================================================================'

