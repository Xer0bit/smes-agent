#!/bin/bash
# =============================================================================
# EcomGear — Multi-VPS Manual Deploy Script
# Usage: ./scripts/deploy.sh [vps1|vps2|vps3|all]
#
# Infrastructure:
#   VPS1  156.67.218.75  (Singapore)  — Frontend + Supabase Edge
#   VPS2  72.62.126.99   (Indonesia)  — Preview Service
#   VPS3  3.148.126.20   (USA)        — LLM / Agent Runner
#
# Credentials are read from environment variables (never hardcoded):
#   VPS1_PASS/VPS1_KEY_PATH  VPS2_PASS/VPS2_KEY_PATH  VPS3_PASS/VPS3_KEY_PATH
# =============================================================================
set -euo pipefail

# Auto-load credentials from .deploy.env if not already in env
DEPLOY_ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.deploy.env"
if [ -f "$DEPLOY_ENV_FILE" ] && [ -z "${VPS3_PASS:-}" ] && [ -z "${VPS3_KEY_PATH:-}" ]; then
    set -a && . "$DEPLOY_ENV_FILE" && set +a
fi

# ── Server config ──────────────────────────────────────────────────────────
VPS1_IP="156.67.218.75";   VPS1_USER="root"
VPS2_IP="72.62.126.99";    VPS2_USER="root"
VPS3_IP="3.148.126.20";    VPS3_USER="root"

DEPLOY_PATH="/var/www/ecomgear"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TARGET="${1:-all}"

VPS1_KEY_PATH="${VPS1_KEY_PATH:-}"
VPS2_KEY_PATH="${VPS2_KEY_PATH:-}"
VPS3_KEY_PATH="${VPS3_KEY_PATH:-}"

case "$TARGET" in
    vps1)
        if [[ -z "${VPS1_PASS:-}" && -z "$VPS1_KEY_PATH" ]]; then echo "✗ Set VPS1_PASS or VPS1_KEY_PATH"; exit 1; fi
        ;;
    vps2)
        if [[ -z "${VPS2_PASS:-}" && -z "$VPS2_KEY_PATH" ]]; then echo "✗ Set VPS2_PASS or VPS2_KEY_PATH"; exit 1; fi
        ;;
    vps3)
        if [[ -z "${VPS3_PASS:-}" && -z "$VPS3_KEY_PATH" ]]; then echo "✗ Set VPS3_PASS or VPS3_KEY_PATH"; exit 1; fi
        ;;
    all)
        if [[ -z "${VPS1_PASS:-}" && -z "$VPS1_KEY_PATH" ]]; then echo "✗ Set VPS1_PASS or VPS1_KEY_PATH"; exit 1; fi
        if [[ -z "${VPS2_PASS:-}" && -z "$VPS2_KEY_PATH" ]]; then echo "✗ Set VPS2_PASS or VPS2_KEY_PATH"; exit 1; fi
        if [[ -z "${VPS3_PASS:-}" && -z "$VPS3_KEY_PATH" ]]; then echo "✗ Set VPS3_PASS or VPS3_KEY_PATH"; exit 1; fi
        ;;
    *)
        echo "Usage: $0 [vps1|vps2|vps3|all]"
        exit 1
        ;;
esac

# ── Pre-deploy checks ──────────────────────────────────────────────────────────
preflight_checks() {
    step "Pre-deploy checks..."

    # Warn on uncommitted changes (don't block — developer may intend this)
    if ! git -C "$PROJECT_DIR" diff --quiet 2>/dev/null || \
       ! git -C "$PROJECT_DIR" diff --staged --quiet 2>/dev/null; then
        echo -e "${YELLOW}  ⚠ Uncommitted changes detected. Deploy will use local files as-is.${NC}"
        git -C "$PROJECT_DIR" status --short 2>/dev/null | head -10
    fi

    # Server TypeScript must compile cleanly (VPS3 only needs this, but catch early)
    if [[ "$TARGET" == "vps3" || "$TARGET" == "all" ]]; then
        if [ -f "$PROJECT_DIR/server/src/index.ts" ]; then
            echo "  Checking server TypeScript..."
            cd "$PROJECT_DIR/server" && npm run build --silent 2>&1 | tail -5
            cd "$PROJECT_DIR"
            success "Server TypeScript OK"
        fi
    fi

    success "Pre-deploy checks passed"
}

# ── Helpers ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()    { echo -e "\n${YELLOW}▶ $1${NC}"; }
success() { echo -e "${GREEN}✓ $1${NC}"; }
info()    { echo -e "${CYAN}  $1${NC}"; }
err()     { echo -e "${RED}✗ $1${NC}"; exit 1; }

SSH_OPTS=( -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ConnectionAttempts=3 )

if { [[ -n "${VPS1_PASS:-}" ]] || [[ -n "${VPS2_PASS:-}" ]] || [[ -n "${VPS3_PASS:-}" ]]; } && ! command -v sshpass &>/dev/null; then
    err "sshpass not found: install it or use *_KEY_PATH auth only"
fi

ssh_exec() {
    local user="$1" host="$2" key_path="$3" pass="${4:-}"
    shift 4
    if [[ -n "$key_path" ]]; then
        ssh "${SSH_OPTS[@]}" -i "$key_path" "$user@$host" "$@"
    else
        sshpass -p "$pass" ssh "${SSH_OPTS[@]}" -o PreferredAuthentications=password -o PubkeyAuthentication=no "$user@$host" "$@"
    fi
}

rsync_exec() {
    local user="$1" host="$2" key_path="$3" pass="${4:-}"
    shift 4
    if [[ -n "$key_path" ]]; then
        rsync -avz --progress -e "ssh ${SSH_OPTS[*]} -i $key_path" "$@"
    else
        sshpass -p "$pass" rsync -avz --progress -e "ssh ${SSH_OPTS[*]} -o PreferredAuthentications=password -o PubkeyAuthentication=no" "$@"
    fi
}

ssh_vps1() { ssh_exec "$VPS1_USER" "$VPS1_IP" "$VPS1_KEY_PATH" "${VPS1_PASS:-}" "$@"; }
ssh_vps2() { ssh_exec "$VPS2_USER" "$VPS2_IP" "$VPS2_KEY_PATH" "${VPS2_PASS:-}" "$@"; }
ssh_vps3() { ssh_exec "$VPS3_USER" "$VPS3_IP" "$VPS3_KEY_PATH" "${VPS3_PASS:-}" "$@"; }

scp_vps1() { rsync_exec "$VPS1_USER" "$VPS1_IP" "$VPS1_KEY_PATH" "${VPS1_PASS:-}" "$@"; }
scp_vps2() { rsync_exec "$VPS2_USER" "$VPS2_IP" "$VPS2_KEY_PATH" "${VPS2_PASS:-}" "$@"; }
scp_vps3() { rsync_exec "$VPS3_USER" "$VPS3_IP" "$VPS3_KEY_PATH" "${VPS3_PASS:-}" "$@"; }

# =========================================================================
# VPS1 — Deploy React SPA + nginx
# Strategy: rsync to dist.new → atomic directory swap → nginx reload
#   nginx keeps serving dist/ (old files) during the entire rsync transfer.
#   Only switches to new content after the fast local mv operations (~10ms).
# =========================================================================
deploy_vps1() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS1 — Frontend + Supabase Edge → $VPS1_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    step "Building React SPA..."
    cd "$PROJECT_DIR"
    npm run build
    success "Build complete (dist/)"

    # ── Apply DB migrations ──────────────────────────────────────────────────
    # Uploads and applies any .sql migration files to the Supabase DB on VPS1.
    # Each file is tracked in supabase_migrations.schema_migrations so it only
    # runs once even if deploy is re-run.
    step "Applying DB migrations on VPS1..."
    ssh_vps1 "mkdir -p /tmp/supabase-migrations"
    scp_vps1 "$PROJECT_DIR/supabase/migrations/" "$VPS1_USER@$VPS1_IP:/tmp/supabase-migrations/"
    ssh_vps1 'bash -s' << 'MIGRATIONS'
set -e
DB_CONTAINER="supabase_db_zurneeqpussrefamhtoq"

# Ensure tracking table exists
docker exec "$DB_CONTAINER" psql -U postgres -c "
  CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz DEFAULT now()
  );
" 2>/dev/null

for f in $(ls /tmp/supabase-migrations/*.sql 2>/dev/null | sort); do
  VERSION=$(basename "$f" .sql)
  ALREADY=$(docker exec "$DB_CONTAINER" psql -U postgres -tAc \
    "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='$VERSION';" 2>/dev/null)
  if [[ "$ALREADY" == "1" ]]; then
    echo "  skip $VERSION (already applied)"
    continue
  fi
  echo "  apply $VERSION..."
  docker cp "$f" "$DB_CONTAINER:/tmp/${VERSION}.sql"
  docker exec "$DB_CONTAINER" psql -U postgres -f "/tmp/${VERSION}.sql" 2>&1
  docker exec "$DB_CONTAINER" psql -U postgres -c \
    "INSERT INTO supabase_migrations.schema_migrations(version) VALUES('$VERSION') ON CONFLICT DO NOTHING;" 2>/dev/null
  echo "  ✓ $VERSION"
done
rm -rf /tmp/supabase-migrations
MIGRATIONS
    success "Migrations applied"

    step "Uploading dist/ to VPS1 (staging → dist.new)..."
    ssh_vps1 "mkdir -p $DEPLOY_PATH/dist.new"
    scp_vps1 "$PROJECT_DIR/dist/" "$VPS1_USER@$VPS1_IP:$DEPLOY_PATH/dist.new/"
    step "Uploading nginx configs..."
    scp_vps1 "$PROJECT_DIR/infrastructure/nginx/vps1-ecomgear.dev.conf" \
             "$VPS1_USER@$VPS1_IP:/etc/nginx/sites-available/ecomgear"
    scp_vps1 "$PROJECT_DIR/infrastructure/nginx/vps1-1000.ecomgear.dev.conf" \
             "$VPS1_USER@$VPS1_IP:/etc/nginx/sites-available/1000.ecomgear.dev"
    step "Remote: atomic swap dist.new → dist + nginx reload..."
    ssh_vps1 "bash -s" << 'REMOTE'
set -e
cd /var/www/ecomgear
rm -rf dist.old
# Use if/then so set -e doesn't exit when dist doesn't exist yet
if [ -d dist ]; then mv dist dist.old; fi
# dist.new must exist — abort loudly if rsync didn't upload
if [ ! -d dist.new ]; then echo "ERROR: dist.new missing — rsync may have failed" >&2; exit 1; fi
mv dist.new dist
ln -sf /etc/nginx/sites-available/ecomgear /etc/nginx/sites-enabled/ecomgear
ln -sf /etc/nginx/sites-available/1000.ecomgear.dev /etc/nginx/sites-enabled/1000.ecomgear.dev
rm -f /etc/nginx/sites-enabled/ecomgear.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx && echo 'nginx reloaded'
echo "Backup preserved at dist.old for rollback"
REMOTE

    # ── Post-deploy health gate ──────────────────────────────────────────────
    # Block until Auth and REST are both responding 200. If either is still
    # loading (e.g. REST schema cache after an edge restart) we wait up to 90s
    # before failing the deploy — preventing a half-broken release from being
    # declared "done".
    step "Post-deploy health gate (auth + REST, up to 90s)..."
    API="https://api.ecomgear.dev"
    ANON_KEY="sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"
    DEADLINE=$(( $(date +%s) + 90 ))
    AUTH_OK=0; REST_OK=0
    while [[ $(date +%s) -lt $DEADLINE ]]; do
        if [[ $AUTH_OK -eq 0 ]]; then
            CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/auth/v1/health" 2>/dev/null)
            [[ "$CODE" == "200" ]] && AUTH_OK=1 && echo "  ✓ Auth 200"
        fi
        if [[ $REST_OK -eq 0 ]]; then
            CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "apikey: $ANON_KEY" \
                "$API/rest/v1/organizations?select=id&limit=1" 2>/dev/null)
            [[ "$CODE" == "200" ]] && REST_OK=1 && echo "  ✓ REST 200"
        fi
        [[ $AUTH_OK -eq 1 && $REST_OK -eq 1 ]] && break
        sleep 5
    done
    if [[ $AUTH_OK -eq 0 || $REST_OK -eq 0 ]]; then
        echo ""
        [[ $AUTH_OK -eq 0 ]] && echo "  ✗ Auth did not become healthy"
        [[ $REST_OK -eq 0 ]] && echo "  ✗ REST did not become healthy (schema cache timeout?)"
        err "Health gate failed — check VPS1 containers: ssh root@$VPS1_IP 'docker ps'"
    fi

    success "VPS1 deploy complete → https://ecomgear.dev"
}

# =========================================================================
# VPS2 — Deploy Preview Service (zero-downtime)
# Strategy:
#   1. rsync to preview-service.staging/ (never touches running service)
#   2. Atomic mv swap: running dir → .old backup, staging → active
#   3. pm2 reload (graceful restart — not delete+start)
#      On shutdown the old process writes a warmup list of active project IDs;
#      the new process restores those Vite servers in the background so
#      users don't see their ecosystem reset.
#   Note: projects/ dir is ALWAYS excluded from rsync — user files never touched.
# =========================================================================
deploy_vps2() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS2 — Preview Service → $VPS2_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    step "Installing preview-service production deps locally..."
    cd "$PROJECT_DIR/preview-service"
    npm ci --omit=dev
    cd "$PROJECT_DIR"
    step "Uploading preview-service to VPS2 (staging dir)..."
    ssh_vps2 "mkdir -p $DEPLOY_PATH/preview-service.staging/projects $DEPLOY_PATH/logs"
    scp_vps2 --exclude='.git' --exclude='projects/' \
             "$PROJECT_DIR/preview-service/" \
             "$VPS2_USER@$VPS2_IP:$DEPLOY_PATH/preview-service.staging/"
    scp_vps2 "$PROJECT_DIR/ecosystem.config.cjs" "$VPS2_USER@$VPS2_IP:$DEPLOY_PATH/"
    step "Uploading nginx config..."
    scp_vps2 "$PROJECT_DIR/infrastructure/nginx/vps2-preview.ecomgear.app.conf" \
             "$VPS2_USER@$VPS2_IP:/etc/nginx/sites-available/ecomgear-preview"
    step "Writing preview-service env to VPS2..."
    SK="${SUPABASE_SERVICE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
    ssh_vps2 "bash -s" << ENVREMOTE
set -e
cat > /var/www/ecomgear/preview-service.staging/.env.production << ENV
NODE_ENV=production
SUPABASE_URL=https://api.ecomgear.dev
SUPABASE_SERVICE_ROLE_KEY=${SK}
ENV
ENVREMOTE
    step "Remote: atomic swap + pm2 graceful reload..."
    ssh_vps2 "bash -s" << 'REMOTE'
set -e
cd /var/www/ecomgear

# Preserve user project files: carry the existing projects/ dir into staging
# so nothing is lost during the directory swap
if [ -d preview-service/projects ] && [ ! -d preview-service.staging/projects ]; then
    cp -al preview-service/projects preview-service.staging/projects
elif [ -d preview-service/projects ]; then
    # Merge: staging might have a fresh empty projects dir, replace it
    rm -rf preview-service.staging/projects
    cp -al preview-service/projects preview-service.staging/projects
fi

# Atomic directory swap
rm -rf preview-service.old
[ -d preview-service ] && mv preview-service preview-service.old
mv preview-service.staging preview-service

ln -sf /etc/nginx/sites-available/ecomgear-preview /etc/nginx/sites-enabled/ecomgear-preview
rm -f /etc/nginx/sites-enabled/preview.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Graceful reload: PM2 sends SIGINT to old process (which saves warmup list),
# starts new process, waits for 'ready' signal, then the new process
# restores all previously active Vite servers in the background.
pm2 reload ecomgear-preview --update-env 2>/dev/null || \
    pm2 start /var/www/ecomgear/ecosystem.config.cjs --only ecomgear-preview
pm2 save --force

sleep 4
if ! curl -sf http://localhost:3001/health; then
    echo "ERROR: preview health check failed — rolling back"
    # Rollback: restore old version
    pm2 stop ecomgear-preview 2>/dev/null || true
    rm -rf preview-service.failed
    mv preview-service preview-service.failed
    [ -d preview-service.old ] && mv preview-service.old preview-service
    pm2 reload ecomgear-preview --update-env 2>/dev/null || \
        pm2 start /var/www/ecomgear/ecosystem.config.cjs --only ecomgear-preview
    echo "ROLLED BACK to previous version"
    exit 1
fi
echo " preview healthy"
echo "Backup preserved at preview-service.old for manual rollback"
REMOTE
    success "VPS2 deploy complete → https://preview.ecomgear.app"
}

# =========================================================================
# VPS3 — Deploy Server / Agent (zero-downtime)
# Strategy:
#   1. Upload to server.staging/
#   2. Atomic mv swap: server → server.old backup, staging → server
#   3. pm2 reload (cluster mode: rolling restart — 1 worker always serving)
#      PM2 starts new workers, waits for process.send('ready'), then kills old
#      ones — zero downtime throughout.
# =========================================================================
deploy_vps3() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS3 — Server / Agent Runner → $VPS3_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -f "$PROJECT_DIR/server/src/index.ts" ]; then
        step "Building server TypeScript..."
        cd "$PROJECT_DIR/server"
        npm ci
        npm run build
        cd "$PROJECT_DIR"
        success "Server built (server/dist/)"
    else
        info "No server/src/index.ts — skipping server build"
    fi
    step "Uploading server to VPS3 (staging dir)..."
    ssh_vps3 "mkdir -p $DEPLOY_PATH/server.staging $DEPLOY_PATH/logs $DEPLOY_PATH/backups"
    [ -d "$PROJECT_DIR/server/dist" ] && \
        scp_vps3 --exclude='.env' --exclude='.env.*' \
            "$PROJECT_DIR/server/" "$VPS3_USER@$VPS3_IP:$DEPLOY_PATH/server.staging/"
    step "Uploading supabase functions + migrations..."
    scp_vps3 "$PROJECT_DIR/supabase/functions/" "$VPS3_USER@$VPS3_IP:$DEPLOY_PATH/supabase/functions/"
    scp_vps3 "$PROJECT_DIR/supabase/migrations/" "$VPS3_USER@$VPS3_IP:$DEPLOY_PATH/supabase/migrations/"
    scp_vps3 "$PROJECT_DIR/ecosystem.config.cjs" "$VPS3_USER@$VPS3_IP:$DEPLOY_PATH/"
    step "Uploading nginx config..."
    scp_vps3 "$PROJECT_DIR/infrastructure/nginx/vps3-gen.ecomgear.dev.conf" \
             "$VPS3_USER@$VPS3_IP:/etc/nginx/sites-available/ecomgear-gen"
    step "Remote: atomic swap + clean PM2 restart..."
    SK="${SUPABASE_SERVICE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"; SAK="${SUPABASE_ANON_KEY:-}"
    ssh_vps3 "bash -s" << 'REMOTE_EOF'
set -euo pipefail
DEPLOY_PATH="/var/www/ecomgear"
APP_NAME="ecomgear-gen"
PORT=5001
BACKUP_DIR="$DEPLOY_PATH/backups"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_KEEP=5   # keep last N timestamped backups

cd "$DEPLOY_PATH"

# ── 1. Write env ──────────────────────────────────────────────────────────────
REMOTE_EOF

    # Write env (substitutions happen locally, not inside the heredoc)
    TDB_HOST="${TENANT_DB_HOST:-}"
    TDB_PORT="${TENANT_DB_PORT:-5432}"
    TDB_USER="${TENANT_DB_SUPERUSER:-ecg_provisioner}"
    TDB_PASS="${TENANT_DB_SUPERUSER_PASSWORD:-}"
    TDB_NAME="${TENANT_DB_NAME:-ecg_tenants}"
    TDB_JWT="${TENANT_DB_JWT_SECRET:-}"
    TDB_API_URL="${TENANT_DB_API_URL:-https://db.ecomgear.app}"
    TDB_SSL="${TENANT_DB_SSL:-true}"
    TDB_RELOAD_URL="${TENANT_DB_RELOAD_URL:-}"
    TDB_RELOAD_SECRET="${TENANT_DB_RELOAD_SECRET:-}"
    ssh_vps3 "bash -s" << REMOTE
set -euo pipefail
DEPLOY_PATH="/var/www/ecomgear"
APP_NAME="ecomgear-gen"
PORT=5001
BACKUP_DIR="\$DEPLOY_PATH/backups"
TS=\$(date +%Y%m%d-%H%M%S)
BACKUP_KEEP=5

cd "\$DEPLOY_PATH"

# ── 1. Write env ──────────────────────────────────────────────────────────────
cat > "\$DEPLOY_PATH/.env.production" << ENV
NODE_ENV=production
PORT=5001
PREVIEW_SERVICE_URL=https://preview.ecomgear.app
SUPABASE_URL=https://api.ecomgear.dev
SUPABASE_SERVICE_ROLE_KEY=${SK}
SUPABASE_SERVICE_KEY=${SK}
SUPABASE_ANON_KEY=${SAK}
TENANT_DB_HOST=${TDB_HOST}
TENANT_DB_PORT=${TDB_PORT}
TENANT_DB_SUPERUSER=${TDB_USER}
TENANT_DB_SUPERUSER_PASSWORD=${TDB_PASS}
TENANT_DB_NAME=${TDB_NAME}
TENANT_DB_JWT_SECRET=${TDB_JWT}
TENANT_DB_API_URL=${TDB_API_URL}
TENANT_DB_SSL=${TDB_SSL}
TENANT_DB_RELOAD_URL=${TDB_RELOAD_URL}
TENANT_DB_RELOAD_SECRET=${TDB_RELOAD_SECRET}
ZAI_API_KEY=${ZAI_API_KEY}
GEMINI_API_KEY=${GEMINI_API_KEY}
AI_MODEL=gemini-3.1-pro-preview
AI_FALLBACK_MODEL=gemini-2.5-flash
ECG_PORTAL_URL=${ECG_PORTAL_URL}
ECG_SERVICE_KEY=${ECG_SERVICE_KEY}
ECOMGEAR_SERVER_URL=${ECOMGEAR_SERVER_URL}
DASHBOARD_ACCESS_SECRET=${DASHBOARD_ACCESS_SECRET:-}
# LLM API keys are managed via the Admin panel — stored in Supabase, not here.
ENV

# ── 2. Timestamped backup of current server dir ───────────────────────────────
if [ -d "\$DEPLOY_PATH/server" ]; then
    mkdir -p "\$BACKUP_DIR"
    cp -a "\$DEPLOY_PATH/server" "\$BACKUP_DIR/server-\$TS"
    echo "  Backup created: backups/server-\$TS"
    # Prune: keep only the last \$BACKUP_KEEP backups
    ls -1dt "\$BACKUP_DIR"/server-* 2>/dev/null | tail -n +\$((\$BACKUP_KEEP + 1)) | xargs rm -rf 2>/dev/null || true
    KEPT=\$(ls -1d "\$BACKUP_DIR"/server-* 2>/dev/null | wc -l)
    echo "  Backups retained: \$KEPT (max \$BACKUP_KEEP)"
fi

# ── 3. Atomic directory swap ──────────────────────────────────────────────────
[ -d server ] && mv server server.old
mv server.staging server
rm -rf server.old   # only the swap-temp dir; real history is in backups/

# ── 4. Nginx ─────────────────────────────────────────────────────────────────
ln -sf /etc/nginx/sites-available/ecomgear-gen /etc/nginx/sites-enabled/ecomgear-gen
rm -f /etc/nginx/sites-enabled/gen-agent.conf /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl start nginx 2>/dev/null || true
systemctl reload nginx
systemctl is-active nginx >/dev/null

# ── 5. Kill zombie node workers (processes that share port \$PORT but are
#       NOT in the current PM2 roster — leftover from manual starts or
#       previous PM2 cluster lifecycles) ────────────────────────────────────
PM2_PIDS=\$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.load(sys.stdin)
print(' '.join(str(p['pid']) for p in procs if p.get('name') == '\$APP_NAME' and p.get('pid', 0) > 0))
" 2>/dev/null || echo "")

# Find all node processes running the server binary
ALL_PIDS=\$(pgrep -f "\$DEPLOY_PATH/server/dist/index.js" 2>/dev/null || true)
ZOMBIE_PIDS=""
for pid in \$ALL_PIDS; do
    is_managed=0
    for mp in \$PM2_PIDS; do
        [ "\$pid" = "\$mp" ] && is_managed=1 && break
    done
    [ \$is_managed -eq 0 ] && ZOMBIE_PIDS="\$ZOMBIE_PIDS \$pid"
done
if [ -n "\$ZOMBIE_PIDS" ]; then
    echo "  Killing zombie node processes:\$ZOMBIE_PIDS"
    kill -TERM \$ZOMBIE_PIDS 2>/dev/null || true
    sleep 2
    kill -KILL \$ZOMBIE_PIDS 2>/dev/null || true
else
    echo "  No zombie node processes found"
fi

# ── 6. Hard PM2 restart (delete + start — no socket inheritance) ──────────────
[ -f .env.production ] && set -a && . ./.env.production && set +a

pm2 delete "\$APP_NAME" 2>/dev/null || true
sleep 2

# NOTE: PM2 master daemon (not the workers) holds port \$PORT permanently.
# There is no "port release" to wait for — the master socket stays bound
# across all worker restarts. New workers receive connections via IPC from
# the master. Do NOT wait for port release here.

# Start only ecomgear-gen from the ecosystem file (ecomgear-preview lives on VPS2)
if [ -f "\$DEPLOY_PATH/ecosystem.config.cjs" ]; then
    pm2 start "\$DEPLOY_PATH/ecosystem.config.cjs" --only "\$APP_NAME" --update-env 2>/dev/null || \
    pm2 start "\$DEPLOY_PATH/server/dist/index.js" \
        --name "\$APP_NAME" \
        --cwd "\$DEPLOY_PATH/server" \
        --instances 2 \
        --exec-mode cluster \
        --max-memory-restart 2G \
        --update-env
else
    pm2 start "\$DEPLOY_PATH/server/dist/index.js" \
        --name "\$APP_NAME" \
        --cwd "\$DEPLOY_PATH/server" \
        --instances 2 \
        --exec-mode cluster \
        --max-memory-restart 2G \
        --update-env
fi
pm2 save --force

# Ensure PM2 auto-starts on reboot (idempotent — safe to run every deploy)
STARTUP_CMD=\$(pm2 startup systemd -u root --hp /root 2>&1 | grep -E "^sudo " | head -1 || true)
if [ -n "\$STARTUP_CMD" ]; then eval "\$STARTUP_CMD" 2>/dev/null || true; fi
pm2 save --force

# ── 7. Final cleanup: wait for graceful drain then force-kill survivors ────────
# Old workers received SIGTERM and have server.close() + 15s force-exit timer.
# Wait 18s (3s buffer over the 15s timeout) then SIGKILL any survivors that are
# NOT in PM2's final roster. This handles processes stuck on keep-alive connections.
# We check against the FINAL PM2 roster to avoid killing active workers.
echo "  Waiting 18s for graceful shutdown of old workers..."
sleep 18
FINAL_PIDS=\$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.load(sys.stdin)
print(' '.join(str(p['pid']) for p in procs if p.get('name') == '\$APP_NAME' and p.get('pid', 0) > 0))
" 2>/dev/null || echo "")
ALL_PIDS3=\$(pgrep -f "\$DEPLOY_PATH/server/dist/index.js" 2>/dev/null || true)
STUCK_PIDS=""
for pid in \$ALL_PIDS3; do
    is_managed=0
    for fp in \$FINAL_PIDS; do
        [ "\$pid" = "\$fp" ] && is_managed=1 && break
    done
    [ \$is_managed -eq 0 ] && STUCK_PIDS="\$STUCK_PIDS \$pid"
done
if [ -n "\$STUCK_PIDS" ]; then
    echo "  Force-killing stuck old workers (survived 18s drain):\$STUCK_PIDS"
    kill -KILL \$STUCK_PIDS 2>/dev/null || true
else
    echo "  All old workers exited cleanly"
fi

# ── 8. Health check with retry ───────────────────────────────────────────────
HEALTHY=0
for i in \$(seq 1 12); do
    if curl -sf "http://127.0.0.1:\$PORT/health" >/dev/null 2>&1; then
        RESP=\$(curl -s "http://127.0.0.1:\$PORT/health")
        echo "\$RESP gen API healthy"
        HEALTHY=1
        break
    fi
    echo "  Health check \$i/12 — waiting..."
    sleep 3
done

if [ \$HEALTHY -eq 0 ]; then
    echo "ERROR: gen API failed to respond after 36s — rolling back"
    pm2 delete "\$APP_NAME" 2>/dev/null || true
    sleep 1
    # Restore latest backup
    LATEST_BACKUP=\$(ls -1dt "\$BACKUP_DIR"/server-* 2>/dev/null | head -1)
    if [ -n "\$LATEST_BACKUP" ]; then
        rm -rf "\$DEPLOY_PATH/server.failed" && mv "\$DEPLOY_PATH/server" "\$DEPLOY_PATH/server.failed"
        cp -a "\$LATEST_BACKUP" "\$DEPLOY_PATH/server"
        echo "  Restored backup: \$LATEST_BACKUP"
    fi
    pm2 start "\$DEPLOY_PATH/ecosystem.config.cjs" --only "\$APP_NAME" --update-env 2>/dev/null || \
        pm2 start "\$DEPLOY_PATH/server/dist/index.js" --name "\$APP_NAME" --cwd "\$DEPLOY_PATH/server" --update-env
    pm2 save --force
    echo "  ROLLED BACK — check server.failed for the broken build"
    exit 1
fi

FINAL_PM2_PIDS=\$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.load(sys.stdin)
print(' '.join(str(p['pid']) for p in procs if p.get('name') == '\$APP_NAME' and p.get('pid', 0) > 0))
" 2>/dev/null || echo "unknown")
echo "  Active PM2 workers: \$FINAL_PM2_PIDS"
BACKUP_COUNT=\$(ls -1d "\$BACKUP_DIR"/server-* 2>/dev/null | wc -l)
echo "  Backups stored: \$BACKUP_COUNT (in \$BACKUP_DIR)"
REMOTE
    success "VPS3 deploy complete → https://gen.ecomgear.dev"
}

# =========================================================================
# Entrypoint
# =========================================================================
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   EcomGear Multi-VPS Deploy          ║"
echo "  ╚══════════════════════════════════════╝"
echo "  Target: ${TARGET}"
echo ""

preflight_checks

case "$TARGET" in
    vps1) deploy_vps1 ;;
    vps2) deploy_vps2 ;;
    vps3) deploy_vps3 ;;
    all)  deploy_vps1; deploy_vps2; deploy_vps3 ;;
    *)    echo "Usage: $0 [vps1|vps2|vps3|all]"; exit 1 ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  All done!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$TARGET" == "all" || "$TARGET" == "vps1" ]] && echo "  Frontend  → https://ecomgear.dev"
[[ "$TARGET" == "all" || "$TARGET" == "vps2" ]] && echo "  Preview   → https://preview.ecomgear.app"
[[ "$TARGET" == "all" || "$TARGET" == "vps3" ]] && echo "  Gen API   → https://gen.ecomgear.dev"
echo ""
