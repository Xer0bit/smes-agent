#!/usr/bin/env bash
# ============================================================================
# Bootstrap a hosting VPS as a tenant-hosting node.
#
# Installs: Docker CE, Caddy, Node.js 20, PM2
# Pulls:    postgres:16-alpine, postgrest/postgrest, supabase/edge-runtime
# Creates:  tenant data dirs, Caddy config dirs
# Deploys:  hosting-service via PM2
#
# Usage:
#   ./scripts/bootstrap-hosting-server.sh <VPS_IP> <SSH_USER>
#
# Prerequisites:
#   - SSH access to the VPS
#   - Root or sudo privileges on the VPS
# ============================================================================
set -euo pipefail

VPS_IP="${1:?Usage: $0 <VPS_IP> [SSH_USER]}"
SSH_USER="${2:-root}"
HOSTING_PORT="${HOSTING_PORT:-4000}"
DEPLOY_SECRET="${HOSTING_DEPLOY_SECRET:-}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Bootstrapping hosting node: ${SSH_USER}@${VPS_IP}"
echo "═══════════════════════════════════════════════════════════════"

ssh "${SSH_USER}@${VPS_IP}" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

echo "[1/7] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "[2/7] Installing Docker CE..."
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "  Docker installed: $(docker --version)"
else
  echo "  Docker already installed: $(docker --version)"
fi

echo "[3/7] Installing Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  echo "  Caddy installed: $(caddy version)"
else
  echo "  Caddy already installed: $(caddy version)"
fi

echo "[4/7] Installing Node.js 20 + PM2..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
  echo "  Node.js installed: $(node -v)"
else
  echo "  Node.js already installed: $(node -v)"
fi
npm install -g pm2 2>/dev/null || true
echo "  PM2: $(pm2 -v 2>/dev/null || echo 'installed')"

echo "[5/7] Pulling Docker images..."
docker pull postgres:16-alpine
docker pull postgrest/postgrest:v12.2.3
docker pull supabase/edge-runtime:v1.62.2

echo "[6/7] Creating directories..."
mkdir -p /var/www/ecomgear/sites
mkdir -p /var/lib/ecomgear/tenants
mkdir -p /etc/caddy/sites
mkdir -p /opt/ecomgear/hosting-service

# Docker network for tenants
docker network create ecg-tenant-net 2>/dev/null || true

echo "[7/7] Configuring UFW firewall..."
if command -v ufw &>/dev/null; then
  ufw allow 80/tcp   2>/dev/null || true
  ufw allow 443/tcp  2>/dev/null || true
  ufw allow 22/tcp   2>/dev/null || true
  ufw --force enable 2>/dev/null || true
  echo "  UFW: HTTP/HTTPS/SSH allowed"
fi

echo ""
echo "✅ Bootstrap complete. Next steps:"
echo "   1. Deploy hosting-service code to /opt/ecomgear/hosting-service/"
echo "   2. Set env vars: HOSTING_PUBLIC_IP, HOSTING_DEPLOY_SECRET, HOSTING_PORT"
echo "   3. Start with: cd /opt/ecomgear/hosting-service && pm2 start server.js --name ecomgear-hosting"
echo "   4. Set up Caddy main config to import /etc/caddy/sites/*.caddy"
REMOTE_SCRIPT

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Bootstrap finished for ${VPS_IP}"
echo "═══════════════════════════════════════════════════════════════"

# Deploy hosting-service code
echo "Deploying hosting-service code..."
HOSTING_DIR="/opt/ecomgear/hosting-service"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

scp -r "${SCRIPT_DIR}/hosting-service/server.js" \
       "${SCRIPT_DIR}/hosting-service/package.json" \
       "${SCRIPT_DIR}/hosting-service/lib/" \
       "${SSH_USER}@${VPS_IP}:${HOSTING_DIR}/"

echo "Installing hosting-service dependencies on remote..."
ssh "${SSH_USER}@${VPS_IP}" "cd ${HOSTING_DIR} && npm install --production"

# Set up env and start with PM2
echo "Starting hosting-service via PM2..."
ssh "${SSH_USER}@${VPS_IP}" bash -s <<EOF
cd ${HOSTING_DIR}
export HOSTING_PUBLIC_IP="${VPS_IP}"
export HOSTING_DEPLOY_SECRET="${DEPLOY_SECRET}"
export HOSTING_PORT="${HOSTING_PORT}"
export HOSTING_NODE_NAME="hosting-$(hostname -s)"

pm2 delete ecomgear-hosting 2>/dev/null || true
HOSTING_PUBLIC_IP="${VPS_IP}" \
HOSTING_DEPLOY_SECRET="${DEPLOY_SECRET}" \
HOSTING_PORT="${HOSTING_PORT}" \
HOSTING_NODE_NAME="hosting-\$(hostname -s)" \
pm2 start server.js --name ecomgear-hosting
pm2 save
EOF

echo ""
echo "✅ Hosting node ${VPS_IP} is ready!"
echo "   Health check: curl http://${VPS_IP}:${HOSTING_PORT}/health"
