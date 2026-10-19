# One-command E2E runner for the DSH mobile bridge (Windows PowerShell 5.1+ compatible).
<#
.SYNOPSIS
    One-command E2E verification for the DSH mobile bridge.

.DESCRIPTION
    Boots the isolated DSH web instance (DSH_HOME=<workspace>\.test-home,
    127.0.0.1:8899) + the real plugin bridge (127.0.0.1:7861), runs
    `node --test --test-isolation=none tests/e2e.test.mjs`, prints a compact
    PASS/FAIL table, and always tears the child processes down in `finally`.

    All orchestration lives in tests/harness/run-suite.mjs so that ONE node
    process owns the lifecycle: the DSH Windows sandbox only allows a process to
    terminate its own direct children, and `node --test` process isolation is
    blocked by piped-stdio EPERM. This wrapper keeps the UX of a single
    PowerShell command and forwards the exit code (nonzero on any failure).

.PARAMETER WithInstall
    Also run tests/harness/install-check.ps1 first (plugin install proof into the
    isolated `web` profile + --dump-config evidence). Off by default because it
    wants a working offline pnpm and mutates only .test-home.

.EXAMPLE
    pwsh -File tests/run-all.ps1
    pwsh -File tests/run-all.ps1 -WithInstall
#>
[CmdletBinding()]
param(
    [switch]$WithInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$suite = Join-Path $PSScriptRoot 'harness\run-suite.mjs'
$exitCode = 1

Push-Location $root
try {
    Write-Host '=== DSH mobile bridge :: E2E run-all ===' -ForegroundColor Cyan
    Write-Host ("workspace : {0}" -f $root)
    Write-Host ("ports     : DSH 8899 (isolated DSH_HOME=.test-home), bridge 7861")
    Write-Host ''

    if ($WithInstall) {
        Write-Host '--- install proof (isolated profile web) ---' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'harness\install-check.ps1')
        if ($LASTEXITCODE -ne 0) {
            Write-Warning ("install-check exited {0}; E2E still runs so the failure is visible in one pass" -f $LASTEXITCODE)
        }
        Write-Host ''
    }

    node $suite
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Host ("run-all: ERROR {0}" -f $_) -ForegroundColor Red
    $exitCode = 1
}
finally {
    Pop-Location
    Write-Host ''
    if ($exitCode -eq 0) {
        Write-Host 'run-all: PASS - all E2E acceptance items green' -ForegroundColor Green
    }
    else {
        Write-Host ("run-all: FAIL (exit {0}) - see tests/artifacts/e2e-run.log" -f $exitCode) -ForegroundColor Red
    }
}

exit $exitCode
