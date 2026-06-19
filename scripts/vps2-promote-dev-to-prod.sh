#!/usr/bin/env bash
set -euo pipefail

# Promote a Git commit from VPS2 development workspace to production workspace.
# Creates a rollback snapshot before changing production.
#
# Usage:
#   ./scripts/vps2-promote-dev-to-prod.sh
#   ./scripts/vps2-promote-dev-to-prod.sh --allow-dirty-dev
#   ./scripts/vps2-promote-dev-to-prod.sh --branch main
#
# Auth:
#   - preferred: VPS2_KEY_PATH
#   - fallback: VPS2_PASS

VPS2_HOST="${VPS2_HOST:-vps2-preview}"
VPS2_USER="${VPS2_USER:-root}"
VPS2_KEY_PATH="${VPS2_KEY_PATH:-}"
VPS2_PASS="${VPS2_PASS:-}"
ALLOW_DIRTY_DEV=false
BRANCH_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty-dev)
      ALLOW_DIRTY_DEV=true
      shift
      ;;
    --branch)
      BRANCH_OVERRIDE="${2:-}"
      if [[ -z "$BRANCH_OVERRIDE" ]]; then
        echo "[error] --branch requires a value"
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "[error] Unknown argument: $1"
      echo "Usage: $0 [--allow-dirty-dev] [--branch <branch>]"
      exit 1
      ;;
  esac
done

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
  "ALLOW_DIRTY_DEV=$ALLOW_DIRTY_DEV BRANCH_OVERRIDE=$BRANCH_OVERRIDE bash -s" <<'REMOTE'
set -euo pipefail

DEV_DIR="/srv/ecomgear/development/ecomgear-main"
PROD_DIR="/srv/ecomgear/production/ecomgear-main"
SNAPSHOT_DIR="/srv/ecomgear/backups/production"
mkdir -p "$SNAPSHOT_DIR"

if [[ ! -d "$DEV_DIR/.git" ]]; then
  echo "[error] Development workspace is not a Git repo: $DEV_DIR"
  exit 1
fi

if [[ "$ALLOW_DIRTY_DEV" != "true" ]] && [[ -n "$(git -C "$DEV_DIR" status --porcelain)" ]]; then
  echo "[error] Development workspace has uncommitted changes"
  echo "[hint] Commit/stash changes or run with --allow-dirty-dev"
  exit 1
fi

CURRENT_BRANCH="$(git -C "$DEV_DIR" rev-parse --abbrev-ref HEAD)"
if [[ -n "${BRANCH_OVERRIDE:-}" ]]; then
  CURRENT_BRANCH="$BRANCH_OVERRIDE"
fi

COMMIT_SHA="$(git -C "$DEV_DIR" rev-parse HEAD)"
SHORT_SHA="$(git -C "$DEV_DIR" rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SNAPSHOT_FILE="$SNAPSHOT_DIR/prod-${STAMP}-${SHORT_SHA}.tar.gz"

# Snapshot current production for rollback.
tar -C "/srv/ecomgear/production" -czf "$SNAPSHOT_FILE" "ecomgear-main"

if [[ ! -d "$PROD_DIR/.git" ]]; then
  git -C "$PROD_DIR" init
fi

if git -C "$PROD_DIR" remote get-url dev >/dev/null 2>&1; then
  git -C "$PROD_DIR" remote set-url dev "$DEV_DIR"
else
  git -C "$PROD_DIR" remote add dev "$DEV_DIR"
fi

git -C "$PROD_DIR" fetch --prune dev

if git -C "$PROD_DIR" rev-parse --verify "dev/$CURRENT_BRANCH" >/dev/null 2>&1; then
  git -C "$PROD_DIR" checkout -B "$CURRENT_BRANCH" "dev/$CURRENT_BRANCH"
else
  git -C "$PROD_DIR" checkout -B "$CURRENT_BRANCH" "$COMMIT_SHA"
fi

git -C "$PROD_DIR" reset --hard "$COMMIT_SHA"
git -C "$PROD_DIR" clean -fdx

cat > "$SNAPSHOT_DIR/LAST_PROMOTION.txt" <<EOF
timestamp_utc=$STAMP
branch=$CURRENT_BRANCH
commit=$COMMIT_SHA
snapshot_file=$SNAPSHOT_FILE
EOF

echo "[ok] Promotion complete"
echo "[ok] Branch:   $CURRENT_BRANCH"
echo "[ok] Commit:   $COMMIT_SHA"
echo "[ok] Snapshot: $SNAPSHOT_FILE"
REMOTE
