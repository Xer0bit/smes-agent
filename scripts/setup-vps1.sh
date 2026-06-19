#!/bin/bash
# =============================================================================
# VPS1 Setup — 156.67.218.75 (Singapore)
# Roles: Main Frontend + Supabase self-hosted (Docker stack)
# Domains: ecomgear.dev  www.ecomgear.dev  api.ecomgear.dev
# Run as root: bash setup-vps1.sh
# =============================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step()    { echo -e "\n${YELLOW}[VPS1]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
err()     { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && err "Run as root"

DEPLOY_PATH="/var/www/ecomgear"

step "Updating system..."
apt-get update -qq && apt-get upgrade -y -qq
success "System updated"

step "Installing Nginx..."
apt-get install -y -qq nginx certbot python3-certbot-nginx
systemctl enable --now nginx
success "Nginx ready"

step "Installing Docker + Compose..."
apt-get install -y -qq ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
success "Docker ready"

step "Installing Supabase CLI..."
curl -o /usr/local/bin/supabase -fsSL \
  "https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64"
chmod +x /usr/local/bin/supabase
success "Supabase CLI: $(supabase --version)"

step "Installing Node.js 20.x + PM2..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g pm2
pm2 startup systemd -u root --hp /root
success "Node $(node -v) / PM2 $(pm2 -v)"

step "Creating application directories..."
mkdir -p "$DEPLOY_PATH"/{dist,logs,supabase}
success "Dirs: $DEPLOY_PATH"

step "Configuring firewall..."
apt-get install -y -qq ufw
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw --force enable
success "UFW enabled (22/80/443)"

step "Installing utilities..."
apt-get install -y -qq git curl wget htop rsync unzip jq
success "Tools ready"

step "Nginx site config placeholder..."
cat > /etc/nginx/sites-available/ecomgear << 'NGINX_PLACEHOLDER'
# Temporary plain-HTTP server while certbot is not yet run
server {
    listen 80;
    server_name ecomgear.dev www.ecomgear.dev api.ecomgear.dev;
    root /var/www/ecomgear/dist;
    location / { try_files $uri $uri/ /index.html; }
}
NGINX_PLACEHOLDER
ln -sf /etc/nginx/sites-available/ecomgear /etc/nginx/sites-enabled/ecomgear
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
success "Nginx placeholder active"

echo ""
echo "============================================================"
echo -e "${GREEN}VPS1 base setup complete!${NC}"
echo "============================================================"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Point DNS A records to this server (156.67.218.75):"
echo "     ecomgear.dev        → 156.67.218.75"
echo "     www.ecomgear.dev    → 156.67.218.75"
echo "     api.ecomgear.dev    → 156.67.218.75"
echo ""
echo "2. Obtain SSL certificates:"
echo "     certbot --nginx -d ecomgear.dev -d www.ecomgear.dev"
echo "     certbot --nginx -d api.ecomgear.dev"
echo ""
echo "3. Upload the production nginx config and reload:"
echo "     scp infrastructure/nginx/vps1-ecomgear.dev.conf root@156.67.218.75:/etc/nginx/sites-available/ecomgear"
echo "     ssh root@156.67.218.75 'nginx -t && systemctl reload nginx'"
echo ""
echo "4. Start Supabase stack:"
echo "     cd $DEPLOY_PATH/supabase && supabase start"
echo ""
echo "5. CI/CD will handle all subsequent deployments."
echo ""
