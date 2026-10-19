#!/usr/bin/env bash
# Install the DSH mobile bridge bundle into a DSH profile on macOS / Linux.
#
# Usage:
#   bash install.sh [--profile desktop] [--dsh-home ~/.dsh] [--dsh-cli PATH]
#                   [--package-dir DIR] [--port 7860] [--dry-run]
#
# The official DSH installer is used:
#   dsh plugin --profile <Profile> add "<absolute package path>"
set -euo pipefail

PROFILE="desktop"
PACKAGE_DIR=""
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DSH_CLI="${DSH_CLI:-}"
PORT="7860"
DRY_RUN=0
PLUGIN_NAME="dsh-plugin-mobile-bridge"

usage() {
  cat <<'EOF'
Install the DSH mobile bridge bundle into a DSH profile (macOS / Linux).

Options:
  --profile NAME      DSH profile to install into (default: desktop)
  --package-dir DIR   Plugin package directory (default: this script's directory)
  --dsh-home DIR      DSH home (default: $DSH_HOME or ~/.dsh)
  --dsh-cli PATH      DSH CLI executable (default: `dsh` from PATH or $DSH_CLI)
  --port PORT         Bridge TCP port for the printed pairing URL (default: 7860)
  --dry-run           Print the plan without changing anything
  -h, --help          Show this help
EOF
}

log()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)      PROFILE="${2:-}"; shift 2 ;;
    --package-dir)  PACKAGE_DIR="${2:-}"; shift 2 ;;
    --dsh-home)     DSH_HOME_DIR="${2:-}"; shift 2 ;;
    --dsh-cli)      DSH_CLI="${2:-}"; shift 2 ;;
    --port)         PORT="${2:-}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown option: $1 (use --help)" ;;
  esac
done

[ -n "$PROFILE" ] || die "--profile must not be empty"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$PACKAGE_DIR" ]; then
  PACKAGE_DIR="$SCRIPT_DIR"
fi
[ -d "$PACKAGE_DIR" ] || die "package directory not found: $PACKAGE_DIR"
PACKAGE_DIR="$(cd "$PACKAGE_DIR" && pwd)"

for required in package.json cordis.patch.yml lib/plugin.js; do
  [ -f "$PACKAGE_DIR/$required" ] || die "not a complete DSH plugin bundle; missing $PACKAGE_DIR/$required"
done
grep -q "$PLUGIN_NAME" "$PACKAGE_DIR/package.json" || die "package.json does not look like $PLUGIN_NAME"

case "$DSH_HOME_DIR" in
  "~") DSH_HOME_DIR="$HOME" ;;
  "~/"*) DSH_HOME_DIR="$HOME/${DSH_HOME_DIR#\~/}" ;;
esac
[ -n "$DSH_HOME_DIR" ] || DSH_HOME_DIR="$HOME/.dsh"
case "$DSH_HOME_DIR" in
  /*) : ;;
  *) DSH_HOME_DIR="$(pwd)/$DSH_HOME_DIR" ;;
esac

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PROFILE_MANIFEST="$PROFILE_DIR/package.json"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"

if [ -z "$DSH_CLI" ]; then
  if command -v dsh >/dev/null 2>&1; then
    DSH_CLI="$(command -v dsh)"
  elif [ "$DRY_RUN" -eq 1 ]; then
    DSH_CLI="dsh"
    warn "dsh CLI not found in PATH; dry-run uses 'dsh' as a placeholder"
  else
    cat >&2 <<'EOF'
ERROR: cannot find the DSH CLI.

Find it with one of:
  command -v dsh                         # if dsh is on PATH
  ls "/Applications/DeepSeek Harness.app/Contents/MacOS"   # macOS app bundle
  find /Applications -name dsh -type f -maxdepth 6 2>/dev/null

Then run:
  DSH_CLI=/path/to/dsh bash install.sh
or pass --dsh-cli /path/to/dsh.
EOF
    exit 1
  fi
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
log "============================================================"
log " DSH mobile bridge - installer ($PLUGIN_NAME)"
log "============================================================"
log " package   : $PACKAGE_DIR"
log " profile   : $PROFILE"
log " DSH home  : $DSH_HOME_DIR"
log " CLI       : $DSH_CLI"
log " bridge TCP: $PORT"
log ""
log "重要：请先完全退出 DeepSeek Harness（包括菜单栏图标与后台进程），再运行本脚本。"

if [ "$PROFILE" = "desktop" ] && [ ! -f "$PROFILE_MANIFEST" ]; then
  warn "desktop profile 尚未初始化：先启动一次 DeepSeek Harness 桌面端，完全退出后再运行本脚本。"
fi

step "Backing up profile files"
for file in "$PROFILE_MANIFEST" "$PROFILE_PATCH"; do
  if [ ! -f "$file" ]; then
    log "skip (missing): $file"
    continue
  fi
  backup="$file.bak-$STAMP"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would back up: $file -> $backup"
  else
    cp -p "$file" "$backup"
    log "backed up: $backup"
  fi
done

step "Installing the bundle into the profile"
log "command: DSH_HOME=\"$DSH_HOME_DIR\" \"$DSH_CLI\" plugin --profile $PROFILE add \"$PACKAGE_DIR\""

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] nothing was changed."
  log "[dry-run] restart DeepSeek Harness afterwards, then open http://127.0.0.1:$PORT/m/pair"
  exit 0
fi

set +e
DSH_HOME="$DSH_HOME_DIR" "$DSH_CLI" plugin --profile "$PROFILE" add "$PACKAGE_DIR"
install_status=$?
set -e

if [ "$install_status" -ne 0 ]; then
  cat >&2 <<EOF

ERROR: 'dsh plugin add' failed with exit code $install_status

Manual fallback:
  cd "$PROFILE_DIR"
  pnpm add "link:$PACKAGE_DIR"
  # then add "$PLUGIN_NAME" to the dsh.profile.bundles array in package.json
  # and fully restart DeepSeek Harness
EOF
  exit "$install_status"
fi

step "Verifying the profile selection"
if [ -f "$PROFILE_MANIFEST" ] && grep -q "$PLUGIN_NAME" "$PROFILE_MANIFEST"; then
  log "OK: $PLUGIN_NAME is referenced by the profile manifest."
else
  warn "The install command reported success, but the selection could not be verified."
  warn "Check $PROFILE_MANIFEST for the dependency and dsh.profile.bundles entry."
fi

cat <<EOF

安装完成。请重新启动 DeepSeek Harness，然后打开：
  http://127.0.0.1:$PORT/m/pair

macOS 提示：
  - 首次运行时系统可能弹出「是否允许 dsh 接受传入网络连接」，请点「允许」；
    若未弹出，可在「系统设置 → 网络 → 防火墙 → 选项」中允许 dsh。
  - 手机与 Mac 需连接同一 Wi-Fi；手机访问地址可在配对页查看（通常是 http://<Mac 局域网 IP>:7860/m/）。
    查看 Mac 局域网 IP：ipconfig getifaddr en0
EOF
