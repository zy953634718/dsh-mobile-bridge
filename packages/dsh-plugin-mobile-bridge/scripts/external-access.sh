#!/usr/bin/env bash
# Expose the DSH Mobile Bridge to the internet on macOS / Linux and print the
# external URL + access code (the bridge PIN).
#
# Usage:
#   bash scripts/external-access.sh [--port 7860] [--provider lhr|serveo|cloudflared]
#                                   [--cloudflared PATH] [--no-download]
#
# Notes:
#   - The random tunnel URL is public: keep the access code private.
#   - Press Ctrl+C to close the tunnel.
#   - For permanent access prefer Tailscale or Cloudflare Access.
set -euo pipefail

PORT="7860"
PROVIDER="lhr"
CLOUDFLARED_PATH="${CLOUDFLARED:-}"
NO_DOWNLOAD=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$PACKAGE_DIR/tools"
TUNNEL_PID=""
TMP_DIR=""
LOG_FILE=""

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Expose the DSH mobile bridge through a public tunnel (macOS / Linux).

Options:
  --port PORT             Local bridge port (default: 7860)
  --provider NAME         lhr (default), serveo or cloudflared
  --cloudflared PATH      Use an existing cloudflared binary
  --no-download           Do not download cloudflared automatically
  -h, --help              Show this help

Examples:
  bash scripts/external-access.sh
  bash scripts/external-access.sh --provider serveo
  bash scripts/external-access.sh --provider cloudflared
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)        PORT="${2:-}"; shift 2 ;;
    --provider)    PROVIDER="${2:-}"; shift 2 ;;
    --cloudflared) CLOUDFLARED_PATH="${2:-}"; shift 2 ;;
    --no-download) NO_DOWNLOAD=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (use --help)" ;;
  esac
done

case "$PROVIDER" in
  lhr|serveo|cloudflared) : ;;
  *) die "--provider must be one of: lhr, serveo, cloudflared" ;;
esac

cleanup() {
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

get_pin() {
  local json
  json="$(curl -fsS --max-time 6 "http://127.0.0.1:$PORT/m/pair/info")" || die "桥接未运行或端口不对：http://127.0.0.1:$PORT/m/pair/info"
  local pin
  pin="$(printf '%s' "$json" | sed -n 's/.*"pin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$pin" ] || die "无法从 /m/pair/info 读取 PIN：$json"
  printf '%s' "$pin"
}

wait_for_url() {
  local pattern="$1"
  local file="$2"
  local timeout="${3:-60}"
  local elapsed=0
  local url=""
  while [ "$elapsed" -lt "$timeout" ]; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ -f "$file" ]; then
      url="$(grep -Eo "$pattern" "$file" 2>/dev/null | head -n 1 || true)"
      if [ -n "$url" ]; then
        printf '%s' "$url"
        return 0
      fi
    fi
    if [ -n "$TUNNEL_PID" ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      break
    fi
  done
  return 1
}

show_info() {
  local public_url="$1"
  local pin="$2"
  local mobile_url="${3:-$public_url/m/}"
  local notice="${4:-}"
  cat <<EOF

  ┌────────────────────────────────────────────────────────────┐
  │  外网访问已开启                                            │
  └────────────────────────────────────────────────────────────┘
  外网地址 : $mobile_url
  访问码   : $pin

  手机（移动网络/外网 Wi-Fi）打开上面的外网地址，输入访问码即可。
EOF
  if [ -n "$notice" ]; then
    printf '  %s\n' "$notice"
  fi
  cat <<EOF
  桌面配对页（仅本机）：http://127.0.0.1:$PORT/m/pair

  安全提示：
   - 该地址是随机公网地址，仍请勿外传访问码；
   - 用完请按 Ctrl+C 关闭隧道；
   - 长期/更安全的外网访问建议用 Tailscale 组网或 Cloudflare Access。

  隧道运行中，按 Ctrl+C 结束…
EOF
}

start_lhr_tunnel() {
  local pin="$1"
  command -v ssh >/dev/null 2>&1 || die "未找到 ssh；macOS 自带 ssh，请检查 PATH。"
  LOG_FILE="$TMP_DIR/lhr.log"
  log "  正在建立 localhost.run 隧道…"
  ssh -T \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes \
    -R "80:127.0.0.1:$PORT" \
    nokey@localhost.run > /dev/null 2>"$LOG_FILE" &
  TUNNEL_PID=$!
  local url
  if ! url="$(wait_for_url 'https://[a-z0-9-]+\.lhr\.life' "$LOG_FILE" 60)"; then
    warn "无法获取隧道地址，localhost.run 日志："
    tail -n 20 "$LOG_FILE" >&2 || true
    exit 1
  fi
  show_info "$url" "$pin"
  wait "$TUNNEL_PID" 2>/dev/null || true
}

start_serveo_tunnel() {
  local pin="$1"
  command -v ssh >/dev/null 2>&1 || die "未找到 ssh；macOS 自带 ssh，请检查 PATH。"
  LOG_FILE="$TMP_DIR/serveo.log"
  log "  正在建立 serveo.net 隧道…"
  ssh -T \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes \
    -R "80:127.0.0.1:$PORT" \
    serveo.net > /dev/null 2>"$LOG_FILE" &
  TUNNEL_PID=$!
  local url
  if ! url="$(wait_for_url 'https://[a-z0-9-]+\.serveousercontent\.com' "$LOG_FILE" 60)"; then
    warn "无法获取隧道地址，serveo 日志："
    tail -n 20 "$LOG_FILE" >&2 || true
    exit 1
  fi
  show_info "$url" "$pin" "$url/m/?app=1&serveo-skip-browser-warning=true" "如果首次打开出现 Serveo 警告页，点「Continue to Site」即可（上面的地址已带跳过参数）。"
  wait "$TUNNEL_PID" 2>/dev/null || true
}

resolve_cloudflared() {
  if [ -n "$CLOUDFLARED_PATH" ]; then
    [ -x "$CLOUDFLARED_PATH" ] || die "cloudflared 不可执行：$CLOUDFLARED_PATH"
    printf '%s' "$CLOUDFLARED_PATH"
    return 0
  fi
  local local_bin="$TOOLS_DIR/cloudflared"
  if [ -x "$local_bin" ]; then
    printf '%s' "$local_bin"
    return 0
  fi
  [ "$NO_DOWNLOAD" -eq 1 ] && die "cloudflared 不存在（$local_bin），且指定了 --no-download"
  mkdir -p "$TOOLS_DIR"
  local os arch asset
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) die "cloudflared 自动下载仅支持 macOS/Linux（当前：$(uname -s)）" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="amd64" ;;
    *) die "未知 CPU 架构：$(uname -m)" ;;
  esac
  if [ "$os" = "darwin" ]; then
    asset="cloudflared-darwin-$arch.tgz"
    log "  正在下载 cloudflared（$asset，约 40 MB）…"
    local tmp_tgz="$TMP_DIR/$asset"
    curl -fL --max-time 300 -o "$tmp_tgz" "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
    tar -xzf "$tmp_tgz" -C "$TOOLS_DIR"
  else
    asset="cloudflared-linux-$arch"
    log "  正在下载 cloudflared（$asset，约 40 MB）…"
    curl -fL --max-time 300 -o "$local_bin" "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
  fi
  chmod +x "$local_bin" 2>/dev/null || true
  [ -x "$local_bin" ] || die "cloudflared 下载失败：$local_bin"
  printf '%s' "$local_bin"
}

start_cloudflared_tunnel() {
  local pin="$1"
  local bin
  bin="$(resolve_cloudflared)"
  LOG_FILE="$TMP_DIR/cloudflared.log"
  log "  正在启动 Cloudflare 隧道…"
  "$bin" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > /dev/null 2>"$LOG_FILE" &
  TUNNEL_PID=$!
  local url
  if ! url="$(wait_for_url 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 60)"; then
    warn "无法获取隧道地址，cloudflared 日志："
    tail -n 20 "$LOG_FILE" >&2 || true
    exit 1
  fi
  show_info "$url" "$pin"
  wait "$TUNNEL_PID" 2>/dev/null || true
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mobile-tunnel.XXXXXX")"
PIN="$(get_pin)"
log ""
log "  DSH Mobile - 外网访问"
log "  访问码（配对 PIN）: $PIN"

case "$PROVIDER" in
  lhr)         start_lhr_tunnel "$PIN" ;;
  serveo)      start_serveo_tunnel "$PIN" ;;
  cloudflared) start_cloudflared_tunnel "$PIN" ;;
esac
