#!/bin/bash
# =============================================================================
# VPS2 Setup   72.62.126.99 (Indonesia)
# Roles: Preview Hosting + Generated App serving
# Domains: preview.ecomgear.app  *.preview.ecomgear.app  (wildcard SSL)
# Run as root: bash setup-vps2.sh
# =============================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step()    { echo -e "\n${YELLOW}[VPS2]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
err()     { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && err "Run as root"

DEPLOY_PATH="/var/www/ecomgear"

step "Updating system..."
apt-get update -qq && apt-get upgrade -y -qq
success "System updated"

step "Installing Nginx + Certbot..."
apt-get install -y -qq nginx certbot python3-certbot-nginx python3-certbot-dns-cloudflare
systemctl enable --now nginx
success "Nginx ready"

step "Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
success "Node $(node -v)"

step "Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root
success "PM2 $(pm2 -v)"

step "Creating application directories..."
mkdir -p "$DEPLOY_PATH"/{preview-service/projects,logs}
success "Dirs: $DEPLOY_PATH"

step "Configuring firewall..."
apt-get install -y -qq ufw
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
success "UFW enabled (22/80/443)"

step "Installing utilities..."
apt-get install -y -qq git curl wget htop rsync unzip jq
success "Tools ready"

step "Nginx site config placeholder..."
cat > /etc/nginx/sites-available/ecomgear-preview << 'NGINX_PLACEHOLDER'
# Temporary plain-HTTP server while wildcard cert is not yet issued
server {
    listen 80;
    server_name preview.ecomgear.app;
    location /health { return 200 "ok\n"; add_header Content-Type text/plain; }
    location / { proxy_pass http://127.0.0.1:3001; }
}
NGINX_PLACEHOLDER
ln -sf /etc/nginx/sites-available/ecomgear-preview /etc/nginx/sites-enabled/ecomgear-preview
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
success "Nginx placeholder active"

echo ""
echo "============================================================"
echo -e "${GREEN}VPS2 base setup complete!${NC}"
echo "============================================================"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Point DNS records to this server (72.62.126.99):"
echo "     preview.ecomgear.app   → 72.62.126.99"
echo "     *.preview.ecomgear.app → 72.62.126.99"
echo ""
echo "2. Obtain WILDCARD SSL certificate (requires DNS challenge):"
echo "   a) Create /etc/letsencrypt/cloudflare.ini with:"
echo "        dns_cloudflare_api_token = <YOUR_CF_TOKEN>"
echo "   b) Run:"
echo "        certbot certonly --dns-cloudflare \\"
echo "          --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \\"
echo "          -d preview.ecomgear.app -d '*.preview.ecomgear.app'"
echo ""
echo "3. Upload the production nginx config:"
echo "     scp infrastructure/nginx/vps2-preview.ecomgear.app.conf \\"
echo "       root@72.62.126.99:/etc/nginx/sites-available/ecomgear-preview"
echo "     ssh root@72.62.126.99 'nginx -t && systemctl reload nginx'"
echo ""
echo "4. CI/CD will deploy the preview-service on first push."
echo ""
