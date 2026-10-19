#Requires -Version 5.1
<#
.SYNOPSIS
    Install the DSH mobile bridge bundle (dsh-plugin-mobile-bridge) into a DSH profile.

.DESCRIPTION
    Backs up the target profile's package.json and cordis.patch.yml, then runs the
    official DSH plugin installer:

        dsh plugin --profile <Profile> add "<absolute package path>"

    The DSH plugin CLI runs pnpm inside the profile, adds the package as a link:
    dependency, and appends the bundle to dsh.profile.bundles. The running DSH
    process must be restarted afterwards to load the bundle.

    This script never runs automatically. It is safe to re-run; backups get a
    fresh timestamp each time. Use -DryRun to print the plan without changing
    anything.

.PARAMETER Profile
    DSH profile name to install into. Default: desktop.

.PARAMETER PackagePath
    Absolute path of this package directory. Default: the directory of this script.

.PARAMETER DshCli
    Path to the DSH command line executable (dsh.cmd). Default:
    D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd

.PARAMETER DshHome
    DSH home directory. Default: $env:DSH_HOME when set, otherwise %USERPROFILE%\.dsh

.PARAMETER Port
    Bridge listening port used for the optional firewall rule and the printed
    pairing-page URL. It must match the `port` in cordis.patch.yml. Default: 7860.

.PARAMETER Firewall
    Also add an inbound Windows Firewall rule (TCP, private networks) for the
    bridge port. Requires an elevated PowerShell; a failure is reported and does
    not abort the installation.

.PARAMETER DryRun
    Print the planned commands and backups without changing anything.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web -Port 7861 -Firewall
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$PackagePath = '',
    [string]$DshCli = 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd',
    [string]$DshHome = '',
    [int]$Port = 7860,
    [switch]$Firewall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Chinese user-facing messages are stored as UTF-8 base64 so this .ps1 stays
# pure ASCII (Windows PowerShell 5.1 misreads BOM-less UTF-8 script files).
function Decode-Utf8([string]$Base64) {
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
}

$pluginName = 'dsh-plugin-mobile-bridge'
$quitInstruction = Decode-Utf8 '6YeN6KaB77ya6K+35YWI5a6M5YWo6YCA5Ye6IERlZXBTZWVrIEhhcm5lc3PvvIjljIXmi6zmiZjnm5jlm77moIfkuI7lkI7lj7Dov5vnqIvvvInvvIzlho3ov5DooYzmnKzohJrmnKzjgII='
$restartInstruction = Decode-Utf8 '5a6J6KOF5a6M5oiQ5ZCO6K+36YeN5paw5ZCv5YqoIERlZXBTZWVrIEhhcm5lc3PvvIznhLblkI7miZPlvIAgaHR0cDovLzEyNy4wLjAuMTo3ODYwL20vcGFpciDmn6XnnIvphY3lr7kgUElO44CC'
$firewallOkInstruction = Decode-Utf8 '5bey5re75YqgIFdpbmRvd3Mg6Ziy54Gr5aKZ5YWl56uZ6KeE5YiZIGRzaC1tb2JpbGUtYnJpZGdl77yIVENQIHswfe+8jOS7heS4k+eUqOe9kee7nO+8ieOAgg=='
$firewallFailedInstruction = Decode-Utf8 '5pyq6IO95re75Yqg6Ziy54Gr5aKZ6KeE5YiZ77yI5Y+v6IO96ZyA6KaB566h55CG5ZGY5p2D6ZmQ77yJ77yM6K+35Lul566h55CG5ZGY6Lqr5Lu96L+Q6KGM5pys6ISa5pys5oiW5omL5Yqo5pS+6KGMIFRDUCDnq6/lj6MgezB944CC'
$firewallHintInstruction = Decode-Utf8 '5o+Q56S677ya6K+35YWz6Zet5pys5py66Ziy54Gr5aKZ55qE5YWl56uZ6ZmQ5Yi25oiW5omL5Yqo5pS+6KGMIFRDUCB7MH3vvIzlkKbliJnmiYvmnLrml6Dms5Xorr/pl67jgII='

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Warn([string]$Text) {
    Write-Host "WARN: $Text" -ForegroundColor Yellow
}

function Get-TimeStamp {
    return (Get-Date).ToString('yyyyMMdd-HHmmss')
}

# ---------------------------------------------------------------------------
# 1. Locate and validate the plugin package.
# ---------------------------------------------------------------------------
$packageDir = $PackagePath
if ([string]::IsNullOrWhiteSpace($packageDir)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        Write-Host 'ERROR: cannot infer the package directory; pass -PackagePath <absolute path>.' -ForegroundColor Red
        exit 2
    }
    $packageDir = $PSScriptRoot
}
try {
    $packageDir = (Resolve-Path -LiteralPath $packageDir).Path.TrimEnd('\', '/')
} catch {
    Write-Host "ERROR: package directory not found: $packageDir" -ForegroundColor Red
    exit 2
}
$packageJsonPath = Join-Path $packageDir 'package.json'
$bundlePatchPath = Join-Path $packageDir 'cordis.patch.yml'
$pluginEntryPath = Join-Path $packageDir 'lib\plugin.js'
foreach ($required in @($packageJsonPath, $bundlePatchPath, $pluginEntryPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Host "ERROR: not a complete DSH plugin bundle; missing $required" -ForegroundColor Red
        exit 2
    }
}
try {
    $manifest = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "ERROR: package.json is not valid JSON: $packageJsonPath" -ForegroundColor Red
    exit 2
}
if ($manifest.name -ne $pluginName) {
    Write-Host "ERROR: package.json name is '$($manifest.name)', expected '$pluginName'." -ForegroundColor Red
    exit 2
}

# ---------------------------------------------------------------------------
# 2. Resolve the DSH home and target profile paths.
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $DshHome = $env:DSH_HOME
    } else {
        $DshHome = Join-Path $env:USERPROFILE '.dsh'
    }
}
$dshHomeInput = $DshHome
try {
    $DshHome = (Resolve-Path -LiteralPath $dshHomeInput -ErrorAction Stop).Path
} catch {
    # A fresh DSH home may not exist yet; keep it as an absolute path so the
    # plugin CLI can initialize the profile directories.
    $DshHome = [System.IO.Path]::GetFullPath($dshHomeInput)
}
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profileManifestPath = Join-Path $profileDir 'package.json'
$profilePatchPath = Join-Path $profileDir 'cordis.patch.yml'

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host " DSH mobile bridge - installer ($pluginName)" -ForegroundColor White
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host " package   : $packageDir"
Write-Host " profile   : $Profile"
Write-Host " DSH home  : $DshHome"
Write-Host " CLI       : $DshCli"
Write-Host " bridge TCP: $Port"
Write-Host ''
Write-Host $quitInstruction -ForegroundColor Yellow

if ($Profile -eq 'desktop' -and -not (Test-Path -LiteralPath $profileManifestPath)) {
    Write-Warn "The desktop profile is not initialized yet. Open DeepSeek Harness Desktop once, fully quit it, then re-run this script."
}

# ---------------------------------------------------------------------------
# 3. Back up the profile files that DSH tooling may rewrite.
# ---------------------------------------------------------------------------
Write-Step 'Backing up profile files'
$stamp = Get-TimeStamp
$backups = @()
foreach ($file in @($profileManifestPath, $profilePatchPath)) {
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host "skip (missing): $file"
        continue
    }
    $backup = "$file.bak-$stamp"
    if ($DryRun) {
        Write-Host "[dry-run] would back up: $file -> $backup"
    } else {
        Copy-Item -LiteralPath $file -Destination $backup -Force
        $backups += $backup
        Write-Host "backed up: $backup"
    }
}
if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Host "profile directory does not exist yet; the DSH plugin CLI will initialize it: $profileDir"
}

# ---------------------------------------------------------------------------
# 4. Run the official installer (or print it under -DryRun).
# ---------------------------------------------------------------------------
$addArguments = @('plugin', '--profile', $Profile, 'add', $packageDir)
$addCommandLine = "`"$DshCli`" " + ($addArguments -join ' ')
Write-Step 'Installing the bundle into the profile'
Write-Host "command: $addCommandLine"

if ($DryRun) {
    Write-Host '[dry-run] nothing was changed.'
    Write-Host "[dry-run] restart DeepSeek Harness afterwards, then open http://127.0.0.1:$Port/m/pair"
    exit 0
}

if (-not (Test-Path -LiteralPath $DshCli)) {
    Write-Host "ERROR: DSH CLI not found: $DshCli" -ForegroundColor Red
    Write-Host 'Pass -DshCli <path to dsh.cmd> or install the package manually:' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  cd `"$profileDir`""
    Write-Host "  pnpm add `"link:$packageDir`""
    Write-Host "  # then add `"$pluginName`" to the dsh.profile.bundles array in package.json"
    Write-Host '  # and fully restart DeepSeek Harness'
    exit 1
}

$installExitCode = 0
$previousDshHome = $env:DSH_HOME
try {
    # The DSH CLI resolves profiles from DSH_HOME; make -DshHome authoritative.
    $env:DSH_HOME = $DshHome
    & $DshCli @addArguments
    $installExitCode = $LASTEXITCODE
} catch {
    Write-Host "ERROR: failed to run the DSH CLI: $($_.Exception.Message)" -ForegroundColor Red
    $installExitCode = 1
} finally {
    $env:DSH_HOME = $previousDshHome
}

if ($installExitCode -ne 0) {
    Write-Host ''
    Write-Host "ERROR: 'dsh plugin add' failed with exit code $installExitCode" -ForegroundColor Red
    Write-Host 'Manual fallback:' -ForegroundColor Yellow
    Write-Host "  cd `"$profileDir`""
    Write-Host "  pnpm add `"link:$packageDir`""
    Write-Host "  # then add `"$pluginName`" to the dsh.profile.bundles array in package.json"
    Write-Host '  # and fully restart DeepSeek Harness'
    exit $installExitCode
}

# ---------------------------------------------------------------------------
# 5. Verify the profile now selects the bundle.
# ---------------------------------------------------------------------------
Write-Step 'Verifying the profile selection'
$verified = $false
$dependencyInstalled = $false
$bundleSelected = $false
try {
    $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $profileManifest.dependencies) {
        $dependencyNames = @($profileManifest.dependencies.PSObject.Properties.Name)
        $dependencyInstalled = $dependencyNames -contains $pluginName
    }
    if ($null -ne $profileManifest.dsh -and $null -ne $profileManifest.dsh.profile) {
        $bundleNames = @($profileManifest.dsh.profile.bundles)
        $bundleSelected = $bundleNames -contains $pluginName
    }
    $verified = $dependencyInstalled -and $bundleSelected
} catch {
    Write-Warn "Could not read $profileManifestPath : $($_.Exception.Message)"
}
if ($verified) {
    Write-Host "OK: $pluginName is a profile dependency and is selected in dsh.profile.bundles."
    if ($backups.Count -gt 0) { Write-Host "Backups: $($backups -join '; ')" }
} else {
    Write-Warn "The install command reported success, but the selection could not be verified."
    Write-Warn "Check $profileManifestPath for the dependency and dsh.profile.bundles entry."
}

# ---------------------------------------------------------------------------
# 6. Optional firewall rule.
# ---------------------------------------------------------------------------
if ($Firewall) {
    Write-Step "Adding a Windows Firewall inbound rule for TCP $Port"
    $ruleName = "dsh-mobile-bridge ($Port)"
    $firewallCommand = "New-NetFirewallRule -DisplayName `"$ruleName`" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private"
    Write-Host "command: $firewallCommand"
    try {
        $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            Write-Host "firewall rule already exists: $ruleName"
        } else {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
            Write-Host ($firewallOkInstruction -replace '\{0\}', "$Port") -ForegroundColor Green
        }
    } catch {
        Write-Warn ($firewallFailedInstruction -replace '\{0\}', "$Port")
        Write-Warn "detail: $($_.Exception.Message)"
    }
} else {
    Write-Host ''
    Write-Host ($firewallHintInstruction -replace '\{0\}', "$Port") -ForegroundColor Yellow
    Write-Host "Re-run with -Firewall to add the rule automatically (needs an elevated PowerShell)."
}

# ---------------------------------------------------------------------------
# 7. Done.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkGreen
Write-Host ' Installation finished.' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor DarkGreen
Write-Host ($restartInstruction -replace '7860', "$Port") -ForegroundColor Yellow
Write-Host ''
Write-Host "Pairing page (desktop only): http://127.0.0.1:$Port/m/pair"
Write-Host "Phone page                : http://<this PC LAN IP>:$Port/m/"
Write-Host "Uninstall                 : .\uninstall.ps1 -Profile $Profile"
Write-Host ''
exit 0
