#requires -Version 5.1
<#
.SYNOPSIS
  Expose the DSH Mobile Bridge to the internet and print the external URL + access code.

.DESCRIPTION
  Two tunnel providers are supported:
    - lhr         (default) localhost.run over SSH: free, no account, https URL
                   like https://xxxx.lhr.life. Needs OpenSSH (built into Win10+).
    - cloudflared trycloudflare quick tunnel (no account) when its DNS is reachable.

  The script prints the public URL and the current 6-digit PIN (the access code).
  Keep the window open while using it; press Ctrl+C to close the tunnel.

.PARAMETER Port
  Local bridge port (default 7860).

.PARAMETER Provider
  Tunnel provider: lhr (default) or cloudflared.

.PARAMETER CloudflaredPath
  Use an existing cloudflared.exe instead of downloading one.

.PARAMETER NoDownload
  Fail instead of downloading cloudflared when it is missing.
#>
[CmdletBinding()]
param(
  [int]$Port = 7860,
  [ValidateSet('lhr', 'serveo', 'cloudflared')]
  [string]$Provider = 'lhr',
  [string]$CloudflaredPath = '',
  [switch]$NoDownload
)

$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
}

$packageRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $packageRoot 'tools'
$tempDir = [System.IO.Path]::GetTempPath()

function Get-BridgePin {
  $info = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/m/pair/info" -TimeoutSec 5
  if (-not $info -or -not $info.pin) { throw 'unexpected /m/pair/info response' }
  return [string]$info.pin
}

function Read-LogText([string[]]$paths) {
  $text = ''
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) {
      $text += (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue) + "`n"
    }
  }
  return $text
}

function Wait-ForUrl([string[]]$logPaths, [string]$pattern, [int]$timeoutSeconds, [System.Diagnostics.Process]$proc) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 600
    $text = Read-LogText $logPaths
    if ($text -match $pattern) { return $Matches[0] }
    if ($proc -and $proc.HasExited) { break }
  }
  return ''
}

function Show-TunnelInfo([string]$publicUrl, [string]$pin, [string]$mobileUrl = '', [string]$notice = '') {
  if ($mobileUrl -eq '') { $mobileUrl = "$publicUrl/m/" }
  Write-Host ''
  Write-Host '  ┌────────────────────────────────────────────────────────────┐' -ForegroundColor DarkCyan
  Write-Host '  │  外网访问已开启                                            │' -ForegroundColor DarkCyan
  Write-Host '  └────────────────────────────────────────────────────────────┘' -ForegroundColor DarkCyan
  Write-Host "  外网地址 : $mobileUrl" -ForegroundColor Green
  Write-Host "  访问码   : $pin" -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  手机（移动网络/外网 Wi-Fi）打开上面的外网地址，输入访问码即可。' -ForegroundColor Gray
  if ($notice -ne '') { Write-Host "  $notice" -ForegroundColor DarkYellow }
  Write-Host "  桌面配对页（仅本机）：http://127.0.0.1:$Port/m/pair" -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  安全提示：' -ForegroundColor DarkYellow
  Write-Host '   - 该地址是随机公网地址，仍请勿外传访问码；' -ForegroundColor DarkGray
  Write-Host '   - 用完请按 Ctrl+C 关闭隧道；' -ForegroundColor DarkGray
  Write-Host '   - 长期/更安全的外网访问建议用 Tailscale 组网或 Cloudflare Access。' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  隧道运行中，按 Ctrl+C 结束…' -ForegroundColor DarkGray
}

function Start-LhrTunnel([string]$pin) {
  $ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
  if (-not $ssh) { $ssh = 'C:\Windows\System32\OpenSSH\ssh.exe' }
  if (-not (Test-Path -LiteralPath $ssh)) {
    throw 'OpenSSH not found. Install "OpenSSH Client" (Settings > Apps > Optional features) or use -Provider cloudflared.'
  }
  $outLog = Join-Path $tempDir ("dsh-mobile-lhr-{0}.out.log" -f $PID)
  $errLog = Join-Path $tempDir ("dsh-mobile-lhr-{0}.err.log" -f $PID)
  if (Test-Path -LiteralPath $outLog) { Remove-Item -LiteralPath $outLog -Force }
  if (Test-Path -LiteralPath $errLog) { Remove-Item -LiteralPath $errLog -Force }
  Write-Host '  正在建立 localhost.run 隧道…' -ForegroundColor DarkGray
  $sshArgs = @(
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', "80:127.0.0.1:$Port",
    'nokey@localhost.run'
  )
  $proc = Start-Process -FilePath $ssh -ArgumentList $sshArgs -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru
  try {
    $url = Wait-ForUrl @($outLog, $errLog) 'https://[a-z0-9-]+\.lhr\.life' 60 $proc
    if ($url -eq '') {
      Write-Host ''
      Write-Host '无法获取隧道地址，localhost.run 日志：' -ForegroundColor Red
      Write-Host (Read-LogText @($outLog, $errLog)) -ForegroundColor DarkGray
      throw 'localhost.run did not report a tunnel URL'
    }
    Show-TunnelInfo $url $pin
    Wait-Process -Id $proc.Id
  } finally {
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
    Remove-Item -LiteralPath $outLog -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errLog -Force -ErrorAction SilentlyContinue
  }
}

function Resolve-Cloudflared {
  if ($CloudflaredPath -ne '') {
    if (-not (Test-Path -LiteralPath $CloudflaredPath)) { throw "cloudflared not found: $CloudflaredPath" }
    return (Resolve-Path -LiteralPath $CloudflaredPath).Path
  }
  $local = Join-Path $toolsDir 'cloudflared.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  if ($NoDownload) { throw "cloudflared.exe missing at $local (run without -NoDownload or use -Provider lhr)" }
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Write-Host '  正在下载 cloudflared（约 40 MB）…' -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $url -OutFile $local -UseBasicParsing
  if (-not (Test-Path -LiteralPath $local)) { throw 'cloudflared download failed' }
  return $local
}

function Start-CloudflaredTunnel([string]$pin) {
  $cloudflared = Resolve-Cloudflared
  $outLog = Join-Path $tempDir ("dsh-mobile-cf-{0}.out.log" -f $PID)
  $errLog = Join-Path $tempDir ("dsh-mobile-cf-{0}.err.log" -f $PID)
  if (Test-Path -LiteralPath $outLog) { Remove-Item -LiteralPath $outLog -Force }
  if (Test-Path -LiteralPath $errLog) { Remove-Item -LiteralPath $errLog -Force }
  Write-Host '  正在启动 Cloudflare 隧道…' -ForegroundColor DarkGray
  $proc = Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate') `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru
  try {
    $url = Wait-ForUrl @($outLog, $errLog) 'https://[a-z0-9-]+\.trycloudflare\.com' 60 $proc
    if ($url -eq '') {
      Write-Host ''
      Write-Host '无法获取隧道地址，cloudflared 日志：' -ForegroundColor Red
      Write-Host (Read-LogText @($outLog, $errLog)) -ForegroundColor DarkGray
      throw 'cloudflared did not report a trycloudflare.com URL'
    }
    Show-TunnelInfo $url $pin
    Wait-Process -Id $proc.Id
  } finally {
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
    Remove-Item -LiteralPath $outLog -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errLog -Force -ErrorAction SilentlyContinue
  }
}

function Start-ServeoTunnel {
  param([string]$pin)
  $ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
  if (-not $ssh) { $ssh = 'C:\Windows\System32\OpenSSH\ssh.exe' }
  if (-not (Test-Path -LiteralPath $ssh)) {
    throw 'OpenSSH not found. Install "OpenSSH Client" (Settings > Apps > Optional features) or use -Provider cloudflared.'
  }
  $outLog = Join-Path $tempDir ("dsh-mobile-serveo-{0}.out.log" -f $PID)
  $errLog = Join-Path $tempDir ("dsh-mobile-serveo-{0}.err.log" -f $PID)
  if (Test-Path -LiteralPath $outLog) { Remove-Item -LiteralPath $outLog -Force }
  if (Test-Path -LiteralPath $errLog) { Remove-Item -LiteralPath $errLog -Force }
  Write-Host '  正在建立 serveo.net 隧道…' -ForegroundColor DarkGray
  $sshArgs = @(
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', "80:127.0.0.1:$Port",
    'serveo.net'
  )
  $proc = Start-Process -FilePath $ssh -ArgumentList $sshArgs -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru
  try {
    $url = Wait-ForUrl @($outLog, $errLog) 'https://[a-z0-9-]+\.serveousercontent\.com' 60 $proc
    if ($url -eq '') {
      Write-Host ''
      Write-Host '无法获取隧道地址，serveo 日志：' -ForegroundColor Red
      Write-Host (Read-LogText @($outLog, $errLog)) -ForegroundColor DarkGray
      throw 'serveo did not report a serveousercontent.com URL'
    }
    $mobileUrl = "$url/m/?app=1&serveo-skip-browser-warning=true"
    Show-TunnelInfo $url $pin $mobileUrl '如果首次打开出现 Serveo 警告页，点「Continue to Site」即可（上面的地址已带跳过参数）。'
    Wait-Process -Id $proc.Id
  } finally {
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
    Remove-Item -LiteralPath $outLog -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errLog -Force -ErrorAction SilentlyContinue
  }
}

$pin = Get-BridgePin
Write-Host ''
Write-Host '  DSH Mobile - 外网访问' -ForegroundColor Cyan
Write-Host "  访问码（配对 PIN）: $pin" -ForegroundColor Yellow

if ($Provider -eq 'lhr') {
  Start-LhrTunnel $pin
} elseif ($Provider -eq 'serveo') {
  Start-ServeoTunnel $pin
} else {
  Start-CloudflaredTunnel $pin
}
