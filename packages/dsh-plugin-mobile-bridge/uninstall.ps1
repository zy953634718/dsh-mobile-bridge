#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstall the DSH mobile bridge bundle (dsh-plugin-mobile-bridge) from a DSH profile.

.DESCRIPTION
    Backs up the target profile's package.json and cordis.patch.yml, then runs:

        dsh plugin --profile <Profile> remove dsh-plugin-mobile-bridge

    The running DSH process must be restarted afterwards to unload the bundle.
    This script never runs automatically. Use -DryRun to print the plan without
    changing anything.

.PARAMETER Profile
    DSH profile name to uninstall from. Default: desktop.

.PARAMETER DshCli
    Path to the DSH command line executable (dsh.cmd). Default:
    D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd

.PARAMETER DshHome
    DSH home directory. Default: $env:DSH_HOME when set, otherwise %USERPROFILE%\.dsh

.PARAMETER DryRun
    Print the planned commands and backups without changing anything.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile web
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$DshCli = 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd',
    [string]$DshHome = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Chinese user-facing messages are stored as UTF-8 base64 so this .ps1 stays
# pure ASCII (Windows PowerShell 5.1 misreads BOM-less UTF-8 script files).
function Decode-Utf8([string]$Base64) {
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
}

$pluginName = 'dsh-plugin-mobile-bridge'
$quitInstruction = Decode-Utf8 '6YeN6KaB77ya6K+35YWI5a6M5YWo6YCA5Ye6IERlZXBTZWVrIEhhcm5lc3PvvIjljIXmi6zmiZjnm5jlm77moIfkuI7lkI7lj7Dov5vnqIvvvInvvIzlho3ov5DooYzmnKzljbjovb3ohJrmnKzjgII='
$removedInstruction = Decode-Utf8 '5bey5LuOIERTSCDphY3nva7kuK3np7vpmaQgZHNoLXBsdWdpbi1tb2JpbGUtYnJpZGdl44CC'
$failedInstruction = Decode-Utf8 '5Y246L295ZG95Luk5aSx6LSl77yM6K+35Y+C6ICD5LiL5pa55omL5Yqo5q2l6aqk5a6M5oiQ5Y246L2944CC'
$notFoundInstruction = Decode-Utf8 '5pyq5Zyo6YWN572u5Lit5om+5YiwIGRzaC1wbHVnaW4tbW9iaWxlLWJyaWRnZe+8iOWPr+iDveW3sue7j+WNuOi9ve+8ieOAgg=='
$backupsInstruction = Decode-Utf8 '6YWN572u5paH5Lu25aSH5Lu977ya'
$restartInstruction = Decode-Utf8 '5Y246L295a6M5oiQ5ZCO6K+36YeN5paw5ZCv5YqoIERlZXBTZWVrIEhhcm5lc3PjgII='

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
# 1. Resolve the DSH home and target profile paths.
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
    $DshHome = [System.IO.Path]::GetFullPath($dshHomeInput)
}
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profileManifestPath = Join-Path $profileDir 'package.json'
$profilePatchPath = Join-Path $profileDir 'cordis.patch.yml'

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host " DSH mobile bridge - uninstaller ($pluginName)" -ForegroundColor White
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host " profile   : $Profile"
Write-Host " DSH home  : $DshHome"
Write-Host " CLI       : $DshCli"
Write-Host ''
Write-Host $quitInstruction -ForegroundColor Yellow

if (-not (Test-Path -LiteralPath $profileManifestPath)) {
    Write-Host ''
    Write-Host ($notFoundInstruction) -ForegroundColor Yellow
    Write-Host "Profile manifest not found: $profileManifestPath"
    Write-Host 'Nothing to uninstall.'
    exit 0
}

# ---------------------------------------------------------------------------
# 2. Back up the profile files that DSH tooling may rewrite.
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

# ---------------------------------------------------------------------------
# 3. Run the official uninstaller (or print it under -DryRun).
# ---------------------------------------------------------------------------
$removeArguments = @('plugin', '--profile', $Profile, 'remove', $pluginName)
$removeCommandLine = "`"$DshCli`" " + ($removeArguments -join ' ')
Write-Step 'Removing the bundle from the profile'
Write-Host "command: $removeCommandLine"

if ($DryRun) {
    Write-Host '[dry-run] nothing was changed.'
    exit 0
}

$removeExitCode = 0
if (-not (Test-Path -LiteralPath $DshCli)) {
    Write-Host "ERROR: DSH CLI not found: $DshCli" -ForegroundColor Red
    $removeExitCode = 1
} else {
    $previousDshHome = $env:DSH_HOME
    try {
        # The DSH CLI resolves profiles from DSH_HOME; make -DshHome authoritative.
        $env:DSH_HOME = $DshHome
        & $DshCli @removeArguments
        $removeExitCode = $LASTEXITCODE
    } catch {
        Write-Host "ERROR: failed to run the DSH CLI: $($_.Exception.Message)" -ForegroundColor Red
        $removeExitCode = 1
    } finally {
        $env:DSH_HOME = $previousDshHome
    }
}

if ($removeExitCode -eq 0) {
    Write-Host ($removedInstruction) -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host ($failedInstruction) -ForegroundColor Yellow
    Write-Host 'Manual fallback:' -ForegroundColor Yellow
    Write-Host "  cd `"$profileDir`""
    Write-Host "  pnpm remove $pluginName"
    Write-Host "  # then remove `"$pluginName`" from the dsh.profile.bundles array in package.json"
    Write-Host '  # and fully restart DeepSeek Harness'
}

# ---------------------------------------------------------------------------
# 4. Verify the selection is gone.
# ---------------------------------------------------------------------------
Write-Step 'Verifying the profile selection'
try {
    $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stillDependency = $false
    if ($null -ne $profileManifest.dependencies) {
        $dependencyNames = @($profileManifest.dependencies.PSObject.Properties.Name)
        $stillDependency = $dependencyNames -contains $pluginName
    }
    $stillSelected = $false
    if ($null -ne $profileManifest.dsh -and $null -ne $profileManifest.dsh.profile) {
        $bundleNames = @($profileManifest.dsh.profile.bundles)
        $stillSelected = $bundleNames -contains $pluginName
    }
    if (-not $stillDependency -and -not $stillSelected) {
        Write-Host "OK: $pluginName is no longer referenced by the profile."
    } else {
        Write-Warn "Still present in the profile (dependency=$stillDependency, selected=$stillSelected)."
    }
} catch {
    Write-Warn "Could not read $profileManifestPath : $($_.Exception.Message)"
}
if ($backups.Count -gt 0) {
    Write-Host ($backupsInstruction) ($backups -join '; ')
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkGreen
Write-Host ' Uninstall finished.' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor DarkGreen
Write-Host ($restartInstruction) -ForegroundColor Yellow
Write-Host "The DSH mobile bridge LAN listener stops when the restarted DSH no longer loads the plugin."
Write-Host ''
exit 0
