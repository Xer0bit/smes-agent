#!/usr/bin/env bash
set -euo pipefail

# Restore VPS2 production workspace from backup snapshot.
#
# Usage:
#   ./scripts/vps2-rollback-prod.sh --latest
#   ./scripts/vps2-rollback-prod.sh --snapshot /srv/ecomgear/backups/production/prod-YYYYmmdd-HHMMSS-<sha>.tar.gz

VPS2_HOST="${VPS2_HOST:-vps2-preview}"
VPS2_USER="${VPS2_USER:-root}"
VPS2_KEY_PATH="${VPS2_KEY_PATH:-}"
VPS2_PASS="${VPS2_PASS:-}"
SNAPSHOT_PATH=""
USE_LATEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)
      USE_LATEST=true
      shift
      ;;
    --snapshot)
      SNAPSHOT_PATH="${2:-}"
      if [[ -z "$SNAPSHOT_PATH" ]]; then
        echo "[error] --snapshot requires a path"
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "[error] Unknown argument: $1"
      echo "Usage: $0 --latest | --snapshot <path>"
      exit 1
      ;;
  esac
done

if [[ "$USE_LATEST" == false && -z "$SNAPSHOT_PATH" ]]; then
  echo "[error] Provide --latest or --snapshot <path>"
  exit 1
fi

if [[ -z "$VPS2_KEY_PATH" && -z "$VPS2_PASS" ]]; then
  echo "[error] Set VPS2_KEY_PATH or VPS2_PASS"
  exit 1
fi

if [[ -n "$VPS2_KEY_PATH" ]]; then
  SSH_CMD=(ssh -i "$VPS2_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
else
  command -v sshpass >/dev/null 2>&1 || { echo "[error] sshpass not found"; exit 1; }
  SSH_CMD=(sshpass -p "$VPS2_PASS" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
fi

"${SSH_CMD[@]}" "$VPS2_USER@$VPS2_HOST" \
  "USE_LATEST=$USE_LATEST SNAPSHOT_PATH=$SNAPSHOT_PATH bash -s" <<'REMOTE'
set -euo pipefail

PROD_BASE="/srv/ecomgear/production"
PROD_DIR="$PROD_BASE/ecomgear-main"
SNAPSHOT_DIR="/srv/ecomgear/backups/production"

if [[ "$USE_LATEST" == "true" ]]; then
  SNAPSHOT_PATH="$(ls -1t "$SNAPSHOT_DIR"/prod-*.tar.gz 2>/dev/null | head -n1 || true)"
fi

if [[ -z "${SNAPSHOT_PATH:-}" || ! -f "$SNAPSHOT_PATH" ]]; then
  echo "[error] Snapshot not found: ${SNAPSHOT_PATH:-<none>}"
  exit 1
fi

PRE_ROLLBACK="${SNAPSHOT_DIR}/pre-rollback-$(date -u +%Y%m%d-%H%M%S).tar.gz"
tar -C "$PROD_BASE" -czf "$PRE_ROLLBACK" "ecomgear-main"

rm -rf "$PROD_DIR"
mkdir -p "$PROD_BASE"
tar -C "$PROD_BASE" -xzf "$SNAPSHOT_PATH"

echo "[ok] Rollback complete"
echo "[ok] Restored from: $SNAPSHOT_PATH"
echo "[ok] Safety snapshot: $PRE_ROLLBACK"
REMOTE
