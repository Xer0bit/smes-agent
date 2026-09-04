#!/usr/bin/env bash
# ==============================================================================
# VPS4+ Setup   Enterprise Hosting Service
# Can run on any VPS. Set HOSTING_PUBLIC_IP in the env after setup.
#
# Installs: Node.js 20, Caddy, PM2
# Deploys: hosting-service with Caddy auto-HTTPS
#
# Usage:
#   ssh root@<hosting-vps-ip>
#   bash setup-vps4.sh
# ==============================================================================
set -euo pipefail

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  SMEsAgent VPS4   Enterprise Hosting Setup                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. System updates ─────────────────────────────────────────────────────────
echo "[1/7] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl gnupg2 software-properties-common ufw

# ── 2. Install Node.js 20 ─────────────────────────────────────────────────────
echo "[2/7] Installing Node.js 20..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# ── 3. Install PM2 ────────────────────────────────────────────────────────────
echo "[3/7] Installing PM2..."
npm install -g pm2 2>/dev/null || true
echo "  PM2: $(pm2 -v)"

# ── 4. Install Caddy ──────────────────────────────────────────────────────────
echo "[4/7] Installing Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi
echo "  Caddy: $(caddy version)"

# ── 5. Create directories ─────────────────────────────────────────────────────
echo "[5/7] Creating directories..."
mkdir -p /var/www/SMEsAgent/sites
mkdir -p /etc/caddy/sites
mkdir -p /opt/SMEsAgent/hosting-service

# ── 6. Firewall ───────────────────────────────────────────────────────────────
echo "[6/7] Configuring firewall..."
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP (Caddy redirect)
ufw allow 443/tcp  # HTTPS (Caddy)
ufw allow 4000/tcp # Hosting API
ufw --force enable

# ── 7. Systemd service for Caddy ──────────────────────────────────────────────
echo "[7/7] Configuring Caddy systemd..."
# Caddy installs its own systemd unit, ensure it's running
systemctl enable caddy
systemctl restart caddy

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  VPS4 base setup complete!                                 ║"
echo "║                                                            ║"
echo "║  Next steps:                                               ║"
echo "║  1. Deploy hosting-service to /opt/SMEsAgent/hosting-service║"
echo "║  2. Copy Caddyfile to /etc/caddy/Caddyfile                ║"
echo "║  3. Set HOSTING_DEPLOY_SECRET in env                       ║"
echo "║  4. pm2 start server.js --name SMEsAgent-hosting            ║"
echo "║  5. pm2 save && pm2 startup                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
