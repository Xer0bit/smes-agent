#!/usr/bin/env bash
set -euo pipefail

# One-command VPS3 Dev Hub bootstrap.
# This script wires together:
# - Tailscale VPN setup
# - code-server setup (localhost-only)
# - Nginx VPN-only /editor routing
# - SSH hardening (disable password auth)
#
# Run as root on VPS3 after repository is cloned.
#
# Required env:
#   TS_AUTHKEY
#   CODESERVER_PASSWORD
#
# Optional env:
#   TS_HOSTNAME (default: vps3-devhub)
#   TS_ADVERTISE_TAGS (example: tag:prod,tag:devhub)
#   TS_ACCEPT_ROUTES (default: false)
#   CODESERVER_USER (default: root)
#   CODESERVER_BIND_ADDR (default: 127.0.0.1:8443)
#   CODESERVER_WORKDIR (default: /var/www/SMEsAgent)
#   SSH_DISABLE_ROOT_LOGIN (default: false)
#   NGINX_SITE_PATH (default: /etc/nginx/sites-available/SMEsAgent-gen)
#   NGINX_SOURCE_CONF (default: infrastructure/nginx/vps3-gen.SMEsAgent.dev.conf in this repo)

if [[ "$EUID" -ne 0 ]]; then
  echo "[error] Run as root"
  exit 1
fi

: "${TS_AUTHKEY:?Set TS_AUTHKEY}"
: "${CODESERVER_PASSWORD:?Set CODESERVER_PASSWORD}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TS_HOSTNAME="${TS_HOSTNAME:-vps3-devhub}"
TS_ACCEPT_ROUTES="${TS_ACCEPT_ROUTES:-false}"
CODESERVER_USER="${CODESERVER_USER:-root}"
CODESERVER_BIND_ADDR="${CODESERVER_BIND_ADDR:-127.0.0.1:8443}"
CODESERVER_WORKDIR="${CODESERVER_WORKDIR:-/var/www/SMEsAgent}"
SSH_DISABLE_ROOT_LOGIN="${SSH_DISABLE_ROOT_LOGIN:-false}"
NGINX_SITE_PATH="${NGINX_SITE_PATH:-/etc/nginx/sites-available/SMEsAgent-gen}"
NGINX_SOURCE_CONF="${NGINX_SOURCE_CONF:-$ROOT_DIR/infrastructure/nginx/vps3-gen.SMEsAgent.dev.conf}"

if [[ ! -f "$NGINX_SOURCE_CONF" ]]; then
  echo "[error] Nginx source config not found: $NGINX_SOURCE_CONF"
  exit 1
fi

if [[ ! -s /root/.ssh/authorized_keys ]]; then
  echo "[error] /root/.ssh/authorized_keys is missing or empty"
  echo "[hint] Add your SSH public key before enabling SSH hardening"
  exit 1
fi

echo "[step] Installing/updating base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx curl ca-certificates

echo "[step] Configuring Tailscale"
TS_AUTHKEY="$TS_AUTHKEY" \
TS_HOSTNAME="$TS_HOSTNAME" \
TS_ADVERTISE_TAGS="${TS_ADVERTISE_TAGS:-}" \
TS_ACCEPT_ROUTES="$TS_ACCEPT_ROUTES" \
  bash "$SCRIPT_DIR/setup-tailscale.sh"

echo "[step] Configuring code-server"
CODESERVER_PASSWORD="$CODESERVER_PASSWORD" \
CODESERVER_USER="$CODESERVER_USER" \
CODESERVER_BIND_ADDR="$CODESERVER_BIND_ADDR" \
CODESERVER_WORKDIR="$CODESERVER_WORKDIR" \
  bash "$SCRIPT_DIR/setup-code-server.sh"

echo "[step] Applying nginx config with VPN-only editor route"
cp "$NGINX_SOURCE_CONF" "$NGINX_SITE_PATH"
ln -sf "$NGINX_SITE_PATH" /etc/nginx/sites-enabled/SMEsAgent-gen
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "[step] Applying SSH hardening"
if [[ "$SSH_DISABLE_ROOT_LOGIN" == "true" ]]; then
  bash "$SCRIPT_DIR/harden-ssh-auth.sh" --disable-root-login
else
  bash "$SCRIPT_DIR/harden-ssh-auth.sh"
fi

echo "[step] Verifying local services"
curl -sf http://127.0.0.1:5001/health >/dev/null 2>&1 && echo "[ok] gen API local health passed" || echo "[warn] gen API local health failed (service may not be started yet)"
curl -sf http://127.0.0.1:8443/healthz >/dev/null 2>&1 && echo "[ok] code-server local health passed" || echo "[warn] code-server local health failed"

echo "[done] VPS3 Dev Hub bootstrap complete"
echo "[next] From your laptop: connect to tailnet, then open https://gen.SMEsAgent.dev/editor/"
