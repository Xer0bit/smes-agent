#!/bin/bash
# =============================================================================
# EcomGear   Instant Rollback Script
# Usage: ./scripts/rollback.sh [vps1|vps2|vps3|all]
#
# Each deploy keeps a *.old backup on the server.
# This script swaps the backup back into place and reloads the service.
# Zero-downtime: uses the same atomic mv + pm2 reload strategy as deploy.sh.
# =============================================================================
set -euo pipefail

VPS1_IP="156.67.218.75";   VPS1_USER="root"
VPS2_IP="72.62.126.99";    VPS2_USER="root"
VPS3_IP="3.148.126.20";    VPS3_USER="root"

DEPLOY_PATH="/var/www/ecomgear"
TARGET="${1:-}"

VPS1_KEY_PATH="${VPS1_KEY_PATH:-}"
VPS2_KEY_PATH="${VPS2_KEY_PATH:-}"
VPS3_KEY_PATH="${VPS3_KEY_PATH:-}"

if [[ -z "$TARGET" ]]; then
    echo "Usage: $0 [vps1|vps2|vps3|all]"
    exit 1
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()    { echo -e "\n${YELLOW}▶ $1${NC}"; }
success() { echo -e "${GREEN}✓ $1${NC}"; }
err()     { echo -e "${RED}✗ $1${NC}"; exit 1; }

SSH_OPTS=( -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ConnectionAttempts=3 )

ssh_exec() {
    local user="$1" host="$2" key_path="$3" pass="${4:-}"
    shift 4
    if [[ -n "$key_path" ]]; then
        ssh "${SSH_OPTS[@]}" -i "$key_path" "$user@$host" "$@"
    else
        sshpass -p "$pass" ssh "${SSH_OPTS[@]}" -o PreferredAuthentications=password \
            -o PubkeyAuthentication=no "$user@$host" "$@"
    fi
}

ssh_vps1() { ssh_exec "$VPS1_USER" "$VPS1_IP" "$VPS1_KEY_PATH" "${VPS1_PASS:-}" "$@"; }
ssh_vps2() { ssh_exec "$VPS2_USER" "$VPS2_IP" "$VPS2_KEY_PATH" "${VPS2_PASS:-}" "$@"; }
ssh_vps3() { ssh_exec "$VPS3_USER" "$VPS3_IP" "$VPS3_KEY_PATH" "${VPS3_PASS:-}" "$@"; }

# ── VPS1: swap dist.old back into place ──────────────────────────────────────
rollback_vps1() {
    step "VPS1   rolling back frontend..."
    ssh_vps1 "bash -s" << 'REMOTE'
set -e
cd /var/www/ecomgear
if [ ! -d dist.old ]; then
    echo "ERROR: no dist.old backup found   cannot rollback"
    exit 1
fi
rm -rf dist.failed
[ -d dist ] && mv dist dist.failed
mv dist.old dist
nginx -t && systemctl reload nginx
echo "VPS1 rollback complete   now serving dist/ (was dist.old)"
echo "Failed build preserved at dist.failed"
REMOTE
    success "VPS1 rollback complete → https://ecomgear.dev"
}

# ── VPS2: swap preview-service.old back into place ───────────────────────────
rollback_vps2() {
    step "VPS2   rolling back preview service..."
    ssh_vps2 "bash -s" << 'REMOTE'
set -e
cd /var/www/ecomgear
if [ ! -d preview-service.old ]; then
    echo "ERROR: no preview-service.old backup found   cannot rollback"
    exit 1
fi

# Carry the current projects/ dir into the old version so user files survive
if [ -d preview-service/projects ]; then
    rm -rf preview-service.old/projects
    cp -al preview-service/projects preview-service.old/projects
fi

rm -rf preview-service.failed
[ -d preview-service ] && mv preview-service preview-service.failed
mv preview-service.old preview-service

# Graceful reload: warmup list from previous session will restore Vite servers
pm2 reload ecomgear-preview --update-env 2>/dev/null || \
    pm2 start /var/www/ecomgear/ecosystem.config.cjs --only ecomgear-preview
pm2 save --force

sleep 4
if ! curl -sf http://localhost:3001/health; then
    echo "ERROR: rollback health check failed"
    pm2 logs ecomgear-preview --nostream --lines 50 || true
    exit 1
fi
echo "VPS2 rollback complete"
echo "Failed version preserved at preview-service.failed"
REMOTE
    success "VPS2 rollback complete → https://preview.ecomgear.app"
}

# ── VPS3: swap server.old back into place ────────────────────────────────────
rollback_vps3() {
    step "VPS3   rolling back API server..."
    ssh_vps3 "bash -s" << 'REMOTE'
set -e
cd /var/www/ecomgear
if [ ! -d server.old ]; then
    echo "ERROR: no server.old backup found   cannot rollback"
    exit 1
fi
rm -rf server.failed
[ -d server ] && mv server server.failed
mv server.old server

# Rolling reload: cluster workers are replaced one at a time
pm2 reload ecomgear-gen --update-env 2>/dev/null || \
    pm2 start server/dist/index.js --name ecomgear-gen \
        --cwd /var/www/ecomgear/server --update-env
pm2 save --force

sleep 6
if ! curl -sf http://127.0.0.1:5001/health; then
    echo "ERROR: rollback health check failed on port 5001"
    pm2 logs ecomgear-gen --nostream --lines 50 || true
    exit 1
fi
echo "VPS3 rollback complete"
echo "Failed version preserved at server.failed"
REMOTE
    success "VPS3 rollback complete → https://gen.ecomgear.dev"
}

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   EcomGear Rollback                  ║"
echo "  ╚══════════════════════════════════════╝"
echo "  Target: ${TARGET}"
echo ""

case "$TARGET" in
    vps1) rollback_vps1 ;;
    vps2) rollback_vps2 ;;
    vps3) rollback_vps3 ;;
    all)  rollback_vps1; rollback_vps2; rollback_vps3 ;;
    *)    echo "Usage: $0 [vps1|vps2|vps3|all]"; exit 1 ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  Rollback complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$TARGET" == "all" || "$TARGET" == "vps1" ]] && echo "  Frontend  → https://ecomgear.dev"
[[ "$TARGET" == "all" || "$TARGET" == "vps2" ]] && echo "  Preview   → https://preview.ecomgear.app"
[[ "$TARGET" == "all" || "$TARGET" == "vps3" ]] && echo "  Gen API   → https://gen.ecomgear.dev"
echo ""
