#!/usr/bin/env bash
set -euo pipefail

# Sync local repo to VPS2 development workspace.
# Optional: also sync production workspace with --sync-prod.
# Default host uses tailnet node name. Override with VPS2_HOST if needed.
# Auth: prefer SSH key via VPS2_KEY_PATH; fallback to VPS2_PASS.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VPS2_HOST="${VPS2_HOST:-vps2-preview}"
VPS2_USER="${VPS2_USER:-root}"
VPS2_KEY_PATH="${VPS2_KEY_PATH:-}"
VPS2_PASS="${VPS2_PASS:-}"
SYNC_PROD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-prod)
      SYNC_PROD=true
      shift
      ;;
    *)
      echo "[error] Unknown argument: $1"
      echo "Usage: $0 [--sync-prod]"
      exit 1
      ;;
  esac
done

DEV_PATH="/srv/ecomgear/development/ecomgear-main/"
PROD_PATH="/srv/ecomgear/production/ecomgear-main/"

if [[ -z "$VPS2_KEY_PATH" && -z "$VPS2_PASS" ]]; then
  echo "[error] Set VPS2_KEY_PATH or VPS2_PASS"
  exit 1
fi

RSYNC_EXCLUDES=(
  --exclude 'node_modules'
  --exclude 'dist'
  --exclude 'build'
  --exclude '.next'
  --exclude 'coverage'
  --exclude '.DS_Store'
)

if [[ -n "$VPS2_KEY_PATH" ]]; then
  SSH_CMD=(ssh -i "$VPS2_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
  RSYNC_SHELL="ssh -i $VPS2_KEY_PATH -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
else
  command -v sshpass >/dev/null 2>&1 || { echo "[error] sshpass not found"; exit 1; }
  export SSHPASS="$VPS2_PASS"
  SSH_CMD=(sshpass -e ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
  RSYNC_SHELL="sshpass -e ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
fi

"${SSH_CMD[@]}" "$VPS2_USER@$VPS2_HOST" "mkdir -p $DEV_PATH $PROD_PATH"

rsync -az --delete --info=stats1 "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_SHELL" "$ROOT_DIR/" "$VPS2_USER@$VPS2_HOST:$DEV_PATH"

if [[ "$SYNC_PROD" == true ]]; then
  rsync -az --delete --info=stats1 "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_SHELL" "$ROOT_DIR/" "$VPS2_USER@$VPS2_HOST:$PROD_PATH"
fi

echo "[ok] Synced to VPS2"
echo "[ok] Dev:  $DEV_PATH"
if [[ "$SYNC_PROD" == true ]]; then
  echo "[ok] Prod: $PROD_PATH"
else
  echo "[ok] Prod sync skipped (use --sync-prod to force mirror sync)"
fi
