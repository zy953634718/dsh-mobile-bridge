#!/usr/bin/env bash
# Uninstall the DSH mobile bridge bundle from a DSH profile on macOS / Linux.
#
# Usage:
#   bash uninstall.sh [--profile desktop] [--dsh-home ~/.dsh] [--dsh-cli PATH] [--dry-run]
set -euo pipefail

PROFILE="desktop"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DSH_CLI="${DSH_CLI:-}"
DRY_RUN=0
PLUGIN_NAME="dsh-plugin-mobile-bridge"

usage() {
  cat <<'EOF'
Uninstall the DSH mobile bridge bundle from a DSH profile (macOS / Linux).

Options:
  --profile NAME      DSH profile to uninstall from (default: desktop)
  --dsh-home DIR      DSH home (default: $DSH_HOME or ~/.dsh)
  --dsh-cli PATH      DSH CLI executable (default: `dsh` from PATH or $DSH_CLI)
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
    --profile)  PROFILE="${2:-}"; shift 2 ;;
    --dsh-home) DSH_HOME_DIR="${2:-}"; shift 2 ;;
    --dsh-cli)  DSH_CLI="${2:-}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "unknown option: $1 (use --help)" ;;
  esac
done

[ -n "$PROFILE" ] || die "--profile must not be empty"

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
    die "cannot find the DSH CLI. Set DSH_CLI=/path/to/dsh or pass --dsh-cli."
  fi
fi

log "============================================================"
log " DSH mobile bridge - uninstaller ($PLUGIN_NAME)"
log "============================================================"
log " profile   : $PROFILE"
log " DSH home  : $DSH_HOME_DIR"
log " CLI       : $DSH_CLI"
log ""
log "重要：请先完全退出 DeepSeek Harness（包括菜单栏图标与后台进程），再运行本脚本。"

if [ ! -f "$PROFILE_MANIFEST" ]; then
  log ""
  log "未在配置中找到 $PLUGIN_NAME（可能已经卸载）。"
  log "Profile manifest not found: $PROFILE_MANIFEST"
  log "Nothing to uninstall."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
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

step "Removing the bundle from the profile"
log "command: DSH_HOME=\"$DSH_HOME_DIR\" \"$DSH_CLI\" plugin --profile $PROFILE remove $PLUGIN_NAME"

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] nothing was changed."
  exit 0
fi

set +e
DSH_HOME="$DSH_HOME_DIR" "$DSH_CLI" plugin --profile "$PROFILE" remove "$PLUGIN_NAME"
remove_status=$?
set -e

if [ "$remove_status" -ne 0 ]; then
  warn "卸载命令失败，请参考手动步骤。"
  cat >&2 <<EOF
Manual fallback:
  cd "$PROFILE_DIR"
  pnpm remove "$PLUGIN_NAME"
  # and remove "$PLUGIN_NAME" from the dsh.profile.bundles array in package.json
  # then fully restart DeepSeek Harness
EOF
  exit "$remove_status"
fi

log ""
log "已从 DSH 配置中移除 $PLUGIN_NAME。"
log "完成后请重新启动 DeepSeek Harness。"
