# Install-path proof for the DSH mobile-bridge plugin (PowerShell 5.1+ / PS7 compatible).
#
# Proves E2E acceptance item 9 inside the ISOLATED DSH home only (<workspace>\.test-home):
#   1. `dsh plugin --profile web add <abs package dir>` succeeds (pnpm, offline, local path)
#      -> profile package.json gains dependency + `dsh.profile.bundles` gains the bundle
#      -> `.test-home/dump-config.log` from `dsh --profile web --dump-config` contains the
#         `- id: mobile-bridge` row
#   2. a scratch DSH_HOME (`<workspace>\.test-home\install-boot-home`) with the same install
#      is booted on 127.0.0.1:8898 and the plugin must activate: web.log line
#      `mobile-bridge: phone URL ... pin <PIN>`, /healthz 200, /m/ 200 shell,
#      /m/pair/info 200 with the configured PIN. The booted process is always stopped.
#   3. manual fallback: with -ForceManual (or when pnpm fails) the same result is produced by
#      copying the package into <profile>\node_modules and appending dependency + bundle to
#      package.json (no pnpm needed).
#
# Idempotent: re-running is safe (pnpm reports "Already up to date"; scratch home is recreated).
# Never touches C:\Users\<user>\.dsh, port 6326, or the live desktop DSH.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/harness/install-check.ps1
#   powershell ... -File tests/harness/install-check.ps1 -ForceManual -ProofFile .test-home\install-proof-manual.json
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [int]$ProofDshPort = 8898,
    [int]$ProofBridgePort = 7862,
    [string]$ProofPin = '654321',
    [switch]$ForceManual,
    [string]$ProofFile = '',
    [string]$DshCmd = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- paths ----
$here = $PSScriptRoot
$testsDir = Split-Path -Parent $here
$workspace = Split-Path -Parent $testsDir
$pkgDir = Join-Path $workspace 'packages\dsh-plugin-mobile-bridge'
$dshHome = Join-Path $workspace '.test-home'
$artifactsDir = Join-Path $testsDir 'artifacts'
$scratchHome = Join-Path $dshHome 'install-boot-home'
$nodeCmd = (Get-Command node -ErrorAction Stop).Source
if ($DshCmd -eq '') {
    if ($env:DSH_CMD) { $DshCmd = $env:DSH_CMD } else { $DshCmd = 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd' }
}
if ($ProofFile -eq '') { $ProofFile = Join-Path $dshHome 'install-proof.json' }
elseif (-not [System.IO.Path]::IsPathRooted($ProofFile)) { $ProofFile = Join-Path $workspace $ProofFile }

New-Item -ItemType Directory -Force $dshHome | Out-Null
New-Item -ItemType Directory -Force $artifactsDir | Out-Null

$result = [ordered]@{
    ok                          = $false
    mode                        = $null
    timestamp                   = (Get-Date).ToUniversalTime().ToString('o')
    forceManual                 = [bool]$ForceManual
    profile                     = $Profile
    dshHome                     = $dshHome
    packageDir                  = $pkgDir
    installCommand              = $null
    installExit                 = $null
    installLog                  = $null
    packageJsonHasPlugin        = $false
    bundleListHasPlugin         = $false
    nodeModulePresent           = $false
    dumpConfigCommand           = $null
    dumpConfigHasMobileBridge   = $false
    dumpConfigRow               = $null
    dumpConfigLog               = $null
    bootProof                   = $null
    bootProofLog                = $null
    liveActivation              = $null
    artifacts                   = $null
    scratchHome                 = $scratchHome
    error                       = $null
}

function Section([string]$Title) {
    Write-Host ''
    Write-Host "--- $Title ---" -ForegroundColor Cyan
}
function Fail([string]$Message) {
    $result.error = $Message
    Write-Host "FAIL $Message" -ForegroundColor Red
}
function Check([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { Write-Host ("PASS {0}{1}" -f $Name, $(if ($Detail) { " :: $Detail" } else { '' })) -ForegroundColor Green }
    else { Write-Host ("FAIL {0}{1}" -f $Name, $(if ($Detail) { " :: $Detail" } else { '' })) -ForegroundColor Red }
    return $Condition
}
function Assert-UnderHome([string]$PathToCheck, [string]$Root) {
    $full = [System.IO.Path]::GetFullPath($PathToCheck)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to touch path outside ${rootFull}: $full"
    }
}
function Remove-DirSafe([string]$PathToRemove, [string]$Root) {
    if (-not (Test-Path -LiteralPath $PathToRemove)) { return }
    Assert-UnderHome $PathToRemove $Root
    # rmdir handles directory symlinks/junctions without following them
    & cmd.exe /c rmdir /s /q "`"$PathToRemove`"" 2>$null | Out-Null
}
function Read-ProfileManifest([string]$ProfileDir) {
    return (Get-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json)
}
function Write-TextNoBom([string]$PathToWrite, [string]$Text) {
    # DSH parses profile JSON with JSON.parse: a UTF-8 BOM breaks it, so never use
    # PowerShell 5.1 `Set-Content -Encoding UTF8` for files DSH/Node must parse.
    [System.IO.File]::WriteAllText($PathToWrite, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-ProfileManifest([string]$ProfileDir, $Manifest) {
    $json = $Manifest | ConvertTo-Json -Depth 12
    Write-TextNoBom (Join-Path $ProfileDir 'package.json') $json
}
function Get-ManifestBundleList($Manifest) {
    if ($null -eq $Manifest.dsh) { return @() }
    if ($null -eq $Manifest.dsh.profile) { return @() }
    if ($null -eq $Manifest.dsh.profile.bundles) { return @() }
    return @($Manifest.dsh.profile.bundles)
}
function Get-ManifestDependency($Manifest, [string]$Name) {
    if ($null -eq $Manifest.dependencies) { return $null }
    $property = $Manifest.dependencies.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}
function Set-ManualInstall([string]$ProfileDir, [string]$PackageDir) {
    # Manual fallback: copy the package into node_modules and register dependency + bundle.
    $modulesDir = Join-Path $ProfileDir 'node_modules'
    New-Item -ItemType Directory -Force $modulesDir | Out-Null
    $target = Join-Path $modulesDir 'dsh-plugin-mobile-bridge'
    if (Test-Path -LiteralPath $target) { Remove-DirSafe $target $ProfileDir }
    Copy-Item -LiteralPath $PackageDir -Destination $target -Recurse -Force
    $manifest = Read-ProfileManifest $ProfileDir
    if ($null -eq $manifest.dependencies) {
        $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $spec = 'file:' + ($PackageDir -replace '\\', '/')
    $manifest.dependencies | Add-Member -NotePropertyName 'dsh-plugin-mobile-bridge' -NotePropertyValue $spec -Force
    if ($null -eq $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
    if ($null -eq $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
    $bundles = Get-ManifestBundleList $manifest
    if (-not ($bundles -contains 'dsh-plugin-mobile-bridge')) {
        $bundles = @($bundles) + 'dsh-plugin-mobile-bridge'
        $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    }
    Write-ProfileManifest $ProfileDir $manifest
    return $target
}
function Invoke-Dsh([string[]]$DshArguments, [string]$DshHomeForCall, [int]$TimeoutSeconds = 180) {
    # Run the dsh CLI captured to FILES (never pipes): the DSH Windows sandbox
    # denies piped stdio for grandchildren, and reading two redirected pipes can
    # deadlock when pnpm writes a lot to stderr.
    $outFile = Join-Path $dshHome ('dsh-out-' + [guid]::NewGuid().ToString('N') + '.log')
    $errFile = Join-Path $dshHome ('dsh-err-' + [guid]::NewGuid().ToString('N') + '.log')
    $batFile = Join-Path $dshHome ('dsh-run-' + [guid]::NewGuid().ToString('N') + '.cmd')
    $quotedArgs = foreach ($argument in $DshArguments) {
        if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '""') + '"' } else { $argument }
    }
    $bat = @(
        '@echo off',
        'setlocal',
        ('set "DSH_HOME=' + $DshHomeForCall + '"'),
        ('cd /d "' + $workspace + '"'),
        ('call "' + $DshCmd + '" ' + ($quotedArgs -join ' ') + ' > "' + $outFile + '" 2> "' + $errFile + '"'),
        'exit /b %errorlevel%'
    ) -join "`r`n"
    Set-Content -LiteralPath $batFile -Value ($bat + "`r`n") -Encoding ASCII
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/d /s /c "' + $batFile + '"'
    $psi.WorkingDirectory = $workspace
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch { }
        throw "dsh command timed out: $($DshArguments -join ' ')"
    }
    $stdout = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
    $stderr = if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile -Raw } else { '' }
    Remove-Item -LiteralPath $outFile, $errFile, $batFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        exitCode = $process.ExitCode
        stdout   = $stdout
        stderr   = $stderr
        text     = ($stdout + $stderr)
    }
}
function Write-MobileBridgePatch([string]$ProfileDir, [int]$BridgePort, [string]$Pin) {
    $yaml = @(
        '# QA install proof: boot the installed profile on a private port with a fixed PIN',
        '- id: mobile-bridge',
        '  config:',
        '    enabled: true',
        '    bindHost: 127.0.0.1',
        "    port: $BridgePort",
        '    publicHost: null',
        "    pin: `"$Pin`""
    ) -join "`n"
    Set-Content -LiteralPath (Join-Path $ProfileDir 'cordis.patch.yml') -Value ($yaml + "`n") -Encoding ASCII
}

Section "install proof (isolated DSH_HOME=$( $dshHome ))  mode=$(if ($ForceManual) {'manual-fallback (forced)'} else {'dsh-plugin-add'})"
Write-Host "workspace   : $workspace"
Write-Host "package     : $pkgDir"
Write-Host "dsh cli     : $DshCmd"
Write-Host "proof port  : DSH $ProofDshPort, bridge $ProofBridgePort, pin $ProofPin"
Write-Host "proof file  : $ProofFile"

if (-not (Test-Path -LiteralPath $DshCmd)) { throw "dsh CLI not found: $DshCmd" }
if (-not (Test-Path -LiteralPath (Join-Path $pkgDir 'package.json'))) { throw "plugin package not found: $pkgDir" }

$profileDir = Join-Path $dshHome "profiles\$Profile"
$installMode = $null
$backupPath = $null

# Repair a BOM-prefixed profile manifest left by older PowerShell writers: DSH's
# JSON.parse rejects a UTF-8 BOM and would fail to boot the profile.
$profileManifestPath = Join-Path $profileDir 'package.json'
if (Test-Path -LiteralPath $profileManifestPath) {
    $bytes = [System.IO.File]::ReadAllBytes($profileManifestPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host 'repair: stripping UTF-8 BOM from profile package.json'
        Write-TextNoBom $profileManifestPath (Get-Content -LiteralPath $profileManifestPath -Raw)
    }
}

# ------------------------------------------------- 1. install into .test-home
Section 'step 1: install plugin into isolated profile'
if (Test-Path -LiteralPath $profileDir) {
    $existing = Get-Content -LiteralPath (Join-Path $profileDir 'package.json') -Raw -ErrorAction SilentlyContinue
    if ($existing) {
        $backupPath = Join-Path $profileDir ('package.json.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Copy-Item -LiteralPath (Join-Path $profileDir 'package.json') -Destination $backupPath -Force
        Write-Host "profile package.json backed up to $backupPath"
    }
}

$pnpmAttempt = $null
if (-not $ForceManual) {
    $result.installCommand = "dsh plugin --profile $Profile add `"$pkgDir`""
    Write-Host "run: $($result.installCommand)"
    $pnpmAttempt = Invoke-Dsh @('plugin', '--profile', $Profile, 'add', $pkgDir) $dshHome
    $result.installExit = $pnpmAttempt.exitCode
    $installLogPath = Join-Path $dshHome 'install-add.log'
    Write-TextNoBom $installLogPath $pnpmAttempt.text
    $result.installLog = $installLogPath
    Write-Host ($pnpmAttempt.text.Trim())
    if ($pnpmAttempt.exitCode -eq 0) { $installMode = 'dsh-plugin-add' }
    else { Write-Host "pnpm install failed (exit $($pnpmAttempt.exitCode)); falling back to manual install" -ForegroundColor Yellow }
}

if ($null -eq $installMode) {
    $installMode = 'manual-fallback'
    if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
        Section 'step 1b: initialize profile template for manual install'
        $initAttempt = Invoke-Dsh @('plugin', '--profile', $Profile, 'version-exemptions') $dshHome
        Write-Host $initAttempt.text
    }
    $target = Set-ManualInstall $profileDir $pkgDir
    Write-Host "manual install: copied package to $target and updated package.json"
}
$result.mode = $installMode
Write-Host "install mode: $installMode" -ForegroundColor Green

# ---------------------------------------- 2. verify profile manifest + link
Section 'step 2: verify profile manifest'
$manifest = Read-ProfileManifest $profileDir
$dependency = Get-ManifestDependency $manifest 'dsh-plugin-mobile-bridge'
$bundles = Get-ManifestBundleList $manifest
$modulePresent = Test-Path -LiteralPath (Join-Path $profileDir 'node_modules\dsh-plugin-mobile-bridge\package.json')
$result.packageJsonHasPlugin = [bool]$dependency
$result.bundleListHasPlugin = ($bundles -contains 'dsh-plugin-mobile-bridge')
$result.nodeModulePresent = $modulePresent
Write-Host "dependency            : $dependency"
Write-Host "bundles               : $($bundles -join ', ')"
$okManifest = $true
$okManifest = (Check 'package.json dependency present' $result.packageJsonHasPlugin $dependency) -and $okManifest
$okManifest = (Check 'dsh.profile.bundles contains plugin' $result.bundleListHasPlugin) -and $okManifest
$okManifest = (Check 'node_modules/dsh-plugin-mobile-bridge present' $modulePresent) -and $okManifest

# ------------------------------------------- 3. dump-config shows the row
Section 'step 3: dsh --profile web --dump-config'
$result.dumpConfigCommand = "dsh --profile $Profile --dump-config"
$dump = Invoke-Dsh @('--profile', $Profile, '--dump-config') $dshHome
$dumpLogPath = Join-Path $dshHome 'dump-config.log'
Write-TextNoBom $dumpLogPath $dump.text$result.dumpConfigLog = $dumpLogPath
$hasRow = ($dump.text -match '(?m)^- id:\s*mobile-bridge\s*$') -and ($dump.text -match 'name:\s*dsh-plugin-mobile-bridge')
$result.dumpConfigHasMobileBridge = [bool]$hasRow
if ($hasRow) {
    $lines = $dump.text -split "`r?`n"
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match '^-\s*id:\s*mobile-bridge') {
            $result.dumpConfigRow = ($lines[$i..([Math]::Min($i + 9, $lines.Length - 1))] -join "`n")
            break
        }
    }
    Write-Host $result.dumpConfigRow
}
$okDump = Check 'dump-config contains mobile-bridge row' $result.dumpConfigHasMobileBridge $(if ($result.dumpConfigRow) { 'id: mobile-bridge / name: dsh-plugin-mobile-bridge' } else { '' })

# -------------------------- 4. live activation evidence (if already running)
Section 'step 4: live activation evidence (if the shared 8899 instance already loaded it)'
try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7860/healthz' -TimeoutSec 3
    $pairInfo = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7860/m/pair/info' -TimeoutSec 3
    $pairBody = $pairInfo.Content | ConvertFrom-Json
    $result.liveActivation = [ordered]@{
        bridgePort   = 7860
        healthzStatus = [int]$health.StatusCode
        pairInfoPin  = $pairBody.pin
        pairInfoUrls = @($pairBody.urls)
        note         = 'shared isolated DSH instance (pid unknown) had the plugin loaded live (dsh-hmr) - informational only'
    }
    Write-Host ("live 7860 bridge reachable: healthz={0} pin={1} urls={2}" -f $health.StatusCode, $pairBody.pin, (@($pairBody.urls) -join ','))
}
catch {
    $result.liveActivation = [ordered]@{ bridgePort = 7860; reachable = $false; note = $_.Exception.Message }
    Write-Host "live 7860 bridge not reachable (OK, optional): $($_.Exception.Message)"
}

# --------------------------- 5. isolated boot proof in a scratch DSH HOME
Section 'step 5: isolated boot proof of the installed profile (scratch DSH_HOME)'
Assert-UnderHome $scratchHome $dshHome
Remove-DirSafe $scratchHome $dshHome
New-Item -ItemType Directory -Force $scratchHome | Out-Null
$scratchProfileDir = Join-Path $scratchHome "profiles\$Profile"
$bootProofOk = $false
$bootProofLogPath = Join-Path $artifactsDir 'install-boot-proof.log'
try {
    if ($installMode -eq 'dsh-plugin-add') {
        $scratchAdd = Invoke-Dsh @('plugin', '--profile', $Profile, 'add', $pkgDir) $scratchHome
        if ($scratchAdd.exitCode -ne 0) { throw "scratch profile pnpm add failed: $($scratchAdd.text.Trim())" }
    }
    else {
        # manual fallback: seed a normal profile template, then install manually
        & cmd.exe /c mkdir "`"$scratchProfileDir`"" | Out-Null
        $templateManifest = [ordered]@{
            name         = "dsh-profile-$Profile"
            private      = $true
            dependencies = [ordered]@{}
            dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
        }
        $templateJson = $templateManifest | ConvertTo-Json -Depth 8
        Write-TextNoBom (Join-Path $scratchProfileDir 'package.json') $templateJson
        Set-Content -LiteralPath (Join-Path $scratchProfileDir 'pnpm-workspace.yaml') -Value "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $scratchProfileDir 'cordis.patch.yml') -Value "[]`n" -Encoding ASCII
        $null = Set-ManualInstall $scratchProfileDir $pkgDir
    }
    Write-MobileBridgePatch $scratchProfileDir $ProofBridgePort $ProofPin
    Write-Host "scratch profile installed, override patch: port=$ProofBridgePort pin=$ProofPin"

    $nodeOut = ''
    $nodeExit = 1
    & $nodeCmd (Join-Path $here 'boot-profile-proof.mjs') --home $scratchHome --port $ProofDshPort --bridge-port $ProofBridgePort --pin $ProofPin --timeout 120000 *> $bootProofLogPath
    $nodeExit = $LASTEXITCODE
    if (Test-Path -LiteralPath $bootProofLogPath) { $nodeOut = Get-Content -LiteralPath $bootProofLogPath -Raw }
    $result.bootProofLog = $bootProofLogPath
    Write-Host ("boot-proof node exit: {0}" -f $nodeExit)
    $proofLine = (($nodeOut -split "`r?`n") | Where-Object { $_ -match '^PROFILE_PROOF_(OK|FAIL)' } | Select-Object -First 1)
    Write-Host $proofLine
    if ($nodeOut -match 'PROFILE_PROOF_OK') {
        $jsonText = $nodeOut.Substring($nodeOut.IndexOf('PROFILE_PROOF_OK') + 'PROFILE_PROOF_OK'.Length).Trim()
        try { $result.bootProof = $jsonText | ConvertFrom-Json } catch { $result.bootProof = @{ raw = $jsonText } }
        $bootProofOk = $true
    }
    $bootProofOk = (Check 'installed profile boots + plugin activates (log line, /healthz, /m/, /m/pair/info)' $bootProofOk 'see tests/artifacts/install-boot-proof.log') -and $bootProofOk
}
catch {
    $bootProofOk = $false
    Fail "boot proof failed: $($_.Exception.Message)"
    if (Test-Path $bootProofLogPath) { Get-Content $bootProofLogPath -Tail 20 | ForEach-Object { Write-Host "  $_" } }
}

# ------------------------------------------- 6. write proof + cleanup
Section 'step 6: write proof artifacts'
$result.ok = [bool]($okManifest -and $okDump -and $bootProofOk -and ($null -eq $result.error))
$result.artifacts = [ordered]@{
    profilePackageJsonBackup = $backupPath
    installAddLog            = $result.installLog
    dumpConfigLog            = $result.dumpConfigLog
    installBootProofLog      = $result.bootProofLog
    proofFile                = $ProofFile
}

$json = $result | ConvertTo-Json -Depth 12
Write-TextNoBom $ProofFile $json
$artifactProof = Join-Path $artifactsDir ($(if ($installMode -eq 'manual-fallback') { 'install-proof-manual.json' } else { 'install-proof.json' }))
Write-TextNoBom $artifactProof $json
Write-Host "proof written to $ProofFile"
Write-Host "proof copied to $artifactProof"

# scratch home is disposable: keep the boot log, drop the directory
$scratchWebLog = Join-Path $scratchHome 'web.log'
if (Test-Path -LiteralPath $scratchWebLog) {
    Copy-Item -LiteralPath $scratchWebLog -Destination (Join-Path $artifactsDir 'install-boot-web.log') -Force
}
Remove-DirSafe $scratchHome $dshHome
Write-Host 'scratch boot home removed (boot log kept under tests/artifacts)'

Write-Host ''
if ($result.ok) {
    Write-Host "INSTALL-PROOF: PASS (mode=$installMode, dump-config row + isolated profile boot activation)" -ForegroundColor Green
    exit 0
}
else {
    Write-Host "INSTALL-PROOF: FAIL (mode=$installMode) - see $ProofFile" -ForegroundColor Red
    exit 1
}
