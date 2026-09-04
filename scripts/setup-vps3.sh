#!/bin/bash
# =============================================================================
# VPS3 Setup   3.148.126.20 (United States)
# Roles: LLM / Code Generation API + Agent Runner
# Domains: gen.SMEsAgent.dev  agent.SMEsAgent.dev
# Run as root: bash setup-vps3.sh
# =============================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step()    { echo -e "\n${YELLOW}[VPS3]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
err()     { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && err "Run as root"

DEPLOY_PATH="/var/www/SMEsAgent"

step "Updating system..."
apt-get update -qq && apt-get upgrade -y -qq
success "System updated"

step "Installing Nginx + Certbot..."
apt-get install -y -qq nginx certbot python3-certbot-nginx
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
mkdir -p "$DEPLOY_PATH"/{server/dist,logs}
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
cat > /etc/nginx/sites-available/SMEsAgent-gen << 'NGINX_PLACEHOLDER'
# Temporary plain-HTTP server while certs are not yet issued
server {
    listen 80;
    server_name gen.SMEsAgent.dev agent.SMEsAgent.dev;
    location /health { return 200 "ok\n"; add_header Content-Type text/plain; }
    location / { proxy_pass http://127.0.0.1:5001; }
}
NGINX_PLACEHOLDER
ln -sf /etc/nginx/sites-available/SMEsAgent-gen /etc/nginx/sites-enabled/SMEsAgent-gen
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
success "Nginx placeholder active"

echo ""
echo "============================================================"
echo -e "${GREEN}VPS3 base setup complete!${NC}"
echo "============================================================"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Point DNS A records to this server (3.148.126.20):"
echo "     gen.SMEsAgent.dev   → 3.148.126.20"
echo "     agent.SMEsAgent.dev → 3.148.126.20"
echo ""
echo "2. Obtain SSL certificates:"
echo "     certbot --nginx -d gen.SMEsAgent.dev -d agent.SMEsAgent.dev"
echo ""
echo "3. Upload the production nginx config:"
echo "     scp infrastructure/nginx/vps3-gen.SMEsAgent.dev.conf \\"
echo "       root@3.148.126.20:/etc/nginx/sites-available/SMEsAgent-gen"
echo "     ssh root@3.148.126.20 'nginx -t && systemctl reload nginx'"
echo ""
echo "4. Create /var/www/SMEsAgent/.env.production with:"
echo "     ANTHROPIC_API_KEY=..."
echo "     OPENAI_API_KEY=..."
echo "     PREVIEW_SERVICE_URL=https://preview.SMEsAgent.app"
echo "     SUPABASE_URL=https://api.SMEsAgent.dev"
echo "     SUPABASE_SERVICE_ROLE_KEY=..."
echo ""
echo "5. CI/CD will deploy the server + agent on first push."
echo ""
