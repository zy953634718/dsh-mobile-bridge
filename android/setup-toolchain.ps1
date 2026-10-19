# DSH Mobile - manual toolchain setup (Windows, no Gradle)
#
# Downloads a standalone Temurin JDK 17 and the Android command-line tools, then installs
# platforms;android-34 + build-tools;34.0.0 + platform-tools into .\toolchain\sdk.
#
# Run once from the android/ directory:   pwsh -ExecutionPolicy Bypass -File .\setup-toolchain.ps1
# Everything stays inside android\toolchain\ (roughly 1.5 GB after extraction).

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Toolchain = Join-Path $Root 'toolchain'
$JdkDir = Join-Path $Toolchain 'jdk'
$SdkDir = Join-Path $Toolchain 'sdk'
$JdkZip = Join-Path $Toolchain 'jdk17.zip'
$CltZip = Join-Path $Toolchain 'cmdline-tools.zip'

# If a complete toolchain already exists (env override, machine-wide copy, or a previous run of
# this script) there is nothing to download. build.ps1 uses the same detection order.
function Test-Toolchain([string]$Dir) {
    return ($Dir -and
        (Test-Path (Join-Path $Dir 'jdk\bin\javac.exe')) -and
        (Test-Path (Join-Path $Dir 'sdk\platforms\android-34\android.jar')))
}
if (Test-Toolchain $env:DSH_ANDROID_TOOLCHAIN) {
    Write-Host "= toolchain already available via DSH_ANDROID_TOOLCHAIN: $env:DSH_ANDROID_TOOLCHAIN"
    exit 0
}
foreach ($candidate in @($Toolchain, 'D:\ai\android-toolchain')) {
    if (Test-Toolchain $candidate) {
        Write-Host "= toolchain already available at $candidate - nothing to download"
        exit 0
    }
}

New-Item -ItemType Directory -Force -Path $Toolchain | Out-Null

function Download($Url, $OutFile) {
    if (Test-Path $OutFile) {
        Write-Host "= cached $OutFile"
        return
    }
    Write-Host "> downloading $Url"
    & curl.exe -L --fail --retry 3 --connect-timeout 30 -o $OutFile $Url
    if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $Url" }
    $size = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
    Write-Host "= $OutFile ($size MB)"
}

# 1. Temurin JDK 17 (x64, zip) -------------------------------------------------------------
if (-not (Test-Path (Join-Path $JdkDir 'bin\javac.exe'))) {
    Download 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' $JdkZip
    Write-Host '> extracting JDK'
    if (Test-Path $JdkDir) { Remove-Item -Recurse -Force $JdkDir }
    Expand-Archive -Path $JdkZip -DestinationPath (Join-Path $Toolchain 'jdk-extract') -Force
    $inner = Get-ChildItem (Join-Path $Toolchain 'jdk-extract') -Directory | Select-Object -First 1
    Move-Item $inner.FullName $JdkDir
    Remove-Item -Recurse -Force (Join-Path $Toolchain 'jdk-extract')
}
& (Join-Path $JdkDir 'bin\java.exe') -version

# 2. Android command-line tools --------------------------------------------------------------
$SdkManager = Join-Path $SdkDir 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $SdkManager)) {
    Download 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $CltZip
    Write-Host '> extracting cmdline-tools'
    $tmp = Join-Path $Toolchain 'clt-extract'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $CltZip -DestinationPath $tmp -Force
    $latest = Join-Path $SdkDir 'cmdline-tools\latest'
    New-Item -ItemType Directory -Force -Path (Split-Path $latest) | Out-Null
    if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
    Move-Item (Join-Path $tmp 'cmdline-tools') $latest
    Remove-Item -Recurse -Force $tmp
}

# 3. SDK packages: accept licenses, then install ---------------------------------------------
$env:JAVA_HOME = $JdkDir
$env:Path = "$JdkDir\bin;$env:Path"
$answers = ("y`r`n" * 60)
$answers | & cmd /c "`"$SdkManager`" --licenses"
$answers | & cmd /c "`"$SdkManager`" --sdk_root=`"$SdkDir`" `"platforms;android-34`" `"build-tools;34.0.0`" `"platform-tools`""

foreach ($f in @(
        'build-tools\34.0.0\aapt2.exe',
        'build-tools\34.0.0\d8.bat',
        'build-tools\34.0.0\apksigner.bat',
        'build-tools\34.0.0\zipalign.exe',
        'platforms\android-34\android.jar')) {
    $p = Join-Path $SdkDir $f
    if (-not (Test-Path $p)) { throw "missing expected SDK file: $p" }
    Write-Host "= ok $p"
}
Write-Host 'Toolchain ready.'
