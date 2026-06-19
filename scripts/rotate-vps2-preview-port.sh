#!/usr/bin/env bash
set -euo pipefail

# Manually rotate VPS2 preview-service upstream port.
#
# Usage:
#   ./scripts/rotate-vps2-preview-port.sh --new-port 3901
#
# Auth sources (from .deploy.env):
#   VPS2_HOST, VPS2_USER, and either:
#   - VPS2_KEY_PATH (preferred), or
#   - VPS2_PASS (fallback)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV="$ROOT_DIR/.deploy.env"

NEW_PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-port)
      NEW_PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      echo "Usage: $0 --new-port <1025-65535>"
      exit 1
      ;;
  esac
done

if [[ -z "$NEW_PORT" || ! "$NEW_PORT" =~ ^[0-9]+$ || "$NEW_PORT" -lt 1025 || "$NEW_PORT" -gt 65535 ]]; then
  echo "[error] Provide a valid --new-port between 1025 and 65535"
  exit 1
fi

if [[ ! -f "$DEPLOY_ENV" ]]; then
  echo "[error] Missing $DEPLOY_ENV"
  exit 1
fi

# shellcheck disable=SC1090
source "$DEPLOY_ENV"

: "${VPS2_HOST:?Set VPS2_HOST in .deploy.env}"
: "${VPS2_USER:?Set VPS2_USER in .deploy.env}"

# VPS2_PORT defaults to 22 (standard SSH). Override in .deploy.env when using a custom port.
VPS2_SSH_PORT="${VPS2_PORT:-22}"

SSH_COMMON_OPTS=(
  -p "$VPS2_SSH_PORT"
  -o ConnectTimeout=20
  -o ConnectionAttempts=3
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
)

run_ssh() {
  local cmd="$1"
  if [[ -n "${VPS2_KEY_PATH:-}" ]]; then
    ssh "${SSH_COMMON_OPTS[@]}" -i "$VPS2_KEY_PATH" "$VPS2_USER@$VPS2_HOST" "$cmd"
  elif [[ -n "${VPS2_PASS:-}" ]]; then
    command -v sshpass >/dev/null 2>&1 || {
      echo "[error] sshpass required for password fallback"
      exit 1
    }
    SSHPASS="$VPS2_PASS" sshpass -e ssh "${SSH_COMMON_OPTS[@]}" \
      -o PreferredAuthentications=password -o PubkeyAuthentication=no \
      "$VPS2_USER@$VPS2_HOST" "$cmd"
  else
    echo "[error] Set VPS2_KEY_PATH (preferred) or VPS2_PASS in .deploy.env"
    exit 1
  fi
}

CURRENT_PORT="$(run_ssh "grep -Eo '127\\.0\\.0\\.1:[0-9]+' /etc/nginx/sites-available/ecomgear-preview | head -n1 | cut -d: -f2")"
if [[ -z "$CURRENT_PORT" ]]; then
  echo "[error] Could not detect current preview upstream port in nginx config"
  exit 1
fi

if [[ "$CURRENT_PORT" == "$NEW_PORT" ]]; then
  echo "[ok] Preview port already set to $NEW_PORT"
  exit 0
fi

echo "[info] Rotating VPS2 preview port: ${CURRENT_PORT} -> ${NEW_PORT}"

run_ssh "cp /etc/nginx/sites-available/ecomgear-preview /etc/nginx/sites-available/ecomgear-preview.bak"

set +e
run_ssh "sed -i 's/127.0.0.1:${CURRENT_PORT}/127.0.0.1:${NEW_PORT}/g' /etc/nginx/sites-available/ecomgear-preview && nginx -t && systemctl reload nginx"
NGINX_EXIT=$?

if [[ $NGINX_EXIT -ne 0 ]]; then
  echo "[error] nginx update failed. Restoring backup"
  run_ssh "cp /etc/nginx/sites-available/ecomgear-preview.bak /etc/nginx/sites-available/ecomgear-preview && nginx -t && systemctl reload nginx"
  exit 1
fi

run_ssh "cd /var/www/ecomgear && PREVIEW_PORT=${NEW_PORT} PORT=${NEW_PORT} pm2 restart ecomgear-preview --update-env"
PM2_EXIT=$?

if [[ $PM2_EXIT -ne 0 ]]; then
  echo "[error] PM2 restart failed. Rolling back nginx + PM2"
  run_ssh "cp /etc/nginx/sites-available/ecomgear-preview.bak /etc/nginx/sites-available/ecomgear-preview && nginx -t && systemctl reload nginx"
  run_ssh "cd /var/www/ecomgear && PREVIEW_PORT=${CURRENT_PORT} PORT=${CURRENT_PORT} pm2 restart ecomgear-preview --update-env"
  exit 1
fi

run_ssh "curl -sf http://127.0.0.1:${NEW_PORT}/health >/dev/null"
HEALTH_EXIT=$?
set -e

if [[ $HEALTH_EXIT -ne 0 ]]; then
  echo "[error] Health check failed on new port. Rolling back"
  run_ssh "cp /etc/nginx/sites-available/ecomgear-preview.bak /etc/nginx/sites-available/ecomgear-preview && nginx -t && systemctl reload nginx"
  run_ssh "cd /var/www/ecomgear && PREVIEW_PORT=${CURRENT_PORT} PORT=${CURRENT_PORT} pm2 restart ecomgear-preview --update-env"
  exit 1
fi

run_ssh "rm -f /etc/nginx/sites-available/ecomgear-preview.bak"
echo "[ok] VPS2 preview port rotated successfully to ${NEW_PORT}"
