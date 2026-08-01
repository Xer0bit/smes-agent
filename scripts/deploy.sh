#!/bin/bash
# =============================================================================
# EcomGear   Multi-VPS Manual Deploy Script
# Usage: ./scripts/deploy.sh [vps1|vps2|vps3|vps4|vps5|all]
#
# Infrastructure:
#   VPS1  156.67.218.75  (Singapore)    Frontend + Supabase Edge
#   VPS2  72.62.126.99   (Indonesia)    Preview Service
#   VPS3  3.148.126.20   (USA)          LLM / Agent Runner
#   VPS4  187.77.157.231 ( )            Enterprise Hosting Service (published apps)
#   VPS5  187.127.108.19 ( )            Tenant Postgres (paid-user hosted DBs).
#         No application code is deployed here from this repo   VPS5 is a
#         passive DB endpoint that VPS3's server connects to via TENANT_DB_*.
#         `vps5` target only health-checks reachability; it uploads nothing.
#
# Credentials are read from environment variables (never hardcoded):
#   VPS1_PASS/VPS1_KEY_PATH  VPS2_PASS/VPS2_KEY_PATH  VPS3_PASS/VPS3_KEY_PATH
#   VPS4_PASS/VPS4_KEY_PATH  VPS5_PASS/VPS5_KEY_PATH
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
VPS4_IP="${VPS4_HOST:-187.77.157.231}"; VPS4_USER="root"
VPS5_IP="${VPS5_HOST:-187.127.108.19}"; VPS5_USER="root"

DEPLOY_PATH="/var/www/ecomgear"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TARGET="${1:-all}"

VPS1_KEY_PATH="${VPS1_KEY_PATH:-}"
VPS2_KEY_PATH="${VPS2_KEY_PATH:-}"
VPS3_KEY_PATH="${VPS3_KEY_PATH:-}"
VPS4_KEY_PATH="${VPS4_KEY_PATH:-}"
VPS5_KEY_PATH="${VPS5_KEY_PATH:-}"

# ── Deployed-branch guard ────────────────────────────────────────────────────
# Deploying whatever branch happens to be checked out locally is how a stale
# branch silently overwrites newer code already running on a server (this bit
# us once: VPS3 was running origin/stage-change while main's agentLoopService.ts
# was ~1300 lines behind it   a plain deploy would have regressed it with no
# warning). DEPLOY_EXPECTED_BRANCH lets you pin what SHOULD be deployed; unset
# it (or pass ALLOW_ANY_BRANCH=1) to bypass for an intentional cross-branch deploy.
CURRENT_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
if [ -n "${DEPLOY_EXPECTED_BRANCH:-}" ] && [ "${ALLOW_ANY_BRANCH:-0}" != "1" ]; then
    if [ "$CURRENT_BRANCH" != "$DEPLOY_EXPECTED_BRANCH" ]; then
        echo "✗ Refusing to deploy: local branch is '$CURRENT_BRANCH', expected '$DEPLOY_EXPECTED_BRANCH'."
        echo "  git checkout $DEPLOY_EXPECTED_BRANCH   # to deploy the expected branch"
        echo "  ALLOW_ANY_BRANCH=1 $0 $TARGET          # to deploy '$CURRENT_BRANCH' anyway"
        exit 1
    fi
fi

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
    vps4)
        if [[ -z "${VPS4_PASS:-}" && -z "$VPS4_KEY_PATH" ]]; then echo "✗ Set VPS4_PASS or VPS4_KEY_PATH"; exit 1; fi
        ;;
    vps5)
        if [[ -z "${VPS5_PASS:-}" && -z "$VPS5_KEY_PATH" ]]; then echo "✗ Set VPS5_PASS or VPS5_KEY_PATH"; exit 1; fi
        ;;
    all)
        if [[ -z "${VPS1_PASS:-}" && -z "$VPS1_KEY_PATH" ]]; then echo "✗ Set VPS1_PASS or VPS1_KEY_PATH"; exit 1; fi
        if [[ -z "${VPS2_PASS:-}" && -z "$VPS2_KEY_PATH" ]]; then echo "✗ Set VPS2_PASS or VPS2_KEY_PATH"; exit 1; fi
        if [[ -z "${VPS3_PASS:-}" && -z "$VPS3_KEY_PATH" ]]; then echo "✗ Set VPS3_PASS or VPS3_KEY_PATH"; exit 1; fi
        if [[ -z "${VPS4_PASS:-}" && -z "$VPS4_KEY_PATH" ]]; then echo "✗ Set VPS4_PASS or VPS4_KEY_PATH"; exit 1; fi
        if [[ -z "${VPS5_PASS:-}" && -z "$VPS5_KEY_PATH" ]]; then echo "✗ Set VPS5_PASS or VPS5_KEY_PATH"; exit 1; fi
        ;;
    *)
        echo "Usage: $0 [vps1|vps2|vps3|vps4|vps5|all]"
        exit 1
        ;;
esac

# ── Pre-deploy checks ──────────────────────────────────────────────────────────
preflight_checks() {
    step "Pre-deploy checks..."

    # Warn on uncommitted changes (don't block   developer may intend this)
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
ssh_vps4() { ssh_exec "$VPS4_USER" "$VPS4_IP" "$VPS4_KEY_PATH" "${VPS4_PASS:-}" "$@"; }
ssh_vps5() { ssh_exec "$VPS5_USER" "$VPS5_IP" "$VPS5_KEY_PATH" "${VPS5_PASS:-}" "$@"; }

scp_vps1() { rsync_exec "$VPS1_USER" "$VPS1_IP" "$VPS1_KEY_PATH" "${VPS1_PASS:-}" "$@"; }
scp_vps2() { rsync_exec "$VPS2_USER" "$VPS2_IP" "$VPS2_KEY_PATH" "${VPS2_PASS:-}" "$@"; }
scp_vps3() { rsync_exec "$VPS3_USER" "$VPS3_IP" "$VPS3_KEY_PATH" "${VPS3_PASS:-}" "$@"; }
scp_vps4() { rsync_exec "$VPS4_USER" "$VPS4_IP" "$VPS4_KEY_PATH" "${VPS4_PASS:-}" "$@"; }

# =========================================================================
# VPS1   Deploy React SPA + nginx
# Strategy: rsync to dist.new → atomic directory swap → nginx reload
#   nginx keeps serving dist/ (old files) during the entire rsync transfer.
#   Only switches to new content after the fast local mv operations (~10ms).
# =========================================================================
deploy_vps1() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS1   Frontend + Supabase Edge → $VPS1_IP"
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
  if ! docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -f "/tmp/${VERSION}.sql" 2>&1; then
    echo "  ✗ $VERSION FAILED   not marking as applied, aborting migrations" >&2
    exit 1
  fi
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
# dist.new must exist   abort loudly if rsync didn't upload
if [ ! -d dist.new ]; then echo "ERROR: dist.new missing   rsync may have failed" >&2; exit 1; fi
mv dist.new dist
ln -sf /etc/nginx/sites-available/ecomgear /etc/nginx/sites-enabled/ecomgear
ln -sf /etc/nginx/sites-available/1000.ecomgear.dev /etc/nginx/sites-enabled/1000.ecomgear.dev
rm -f /etc/nginx/sites-enabled/ecomgear.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx && echo 'nginx reloaded'
echo "Backup preserved at dist.old for rollback"
REMOTE

    # ── ecomgear-api (server/, SERVICE_ROLE=api)   everything except LLM gen ──
    # Rebuilt independently of deploy_vps3's server build since either function
    # can run alone (single-target deploys)   a little duplicate CI time, but
    # keeps the two VPS deploys decoupled instead of depending on run order.
    if [ -f "$PROJECT_DIR/server/src/index.ts" ]; then
        step "Building server TypeScript (for VPS1 API)..."
        cd "$PROJECT_DIR/server"
        npm ci
        npm run build
        cd "$PROJECT_DIR"
        success "Server built (server/dist/)"
    fi
    step "Uploading server to VPS1 (staging dir)..."
    ssh_vps1 "mkdir -p $DEPLOY_PATH/server.staging $DEPLOY_PATH/logs"
    [ -d "$PROJECT_DIR/server/dist" ] && \
        scp_vps1 --exclude='.env' --exclude='.env.*' --exclude='node_modules' \
            "$PROJECT_DIR/server/" "$VPS1_USER@$VPS1_IP:$DEPLOY_PATH/server.staging/"
    scp_vps1 "$PROJECT_DIR/ecosystem.config.cjs" "$VPS1_USER@$VPS1_IP:$DEPLOY_PATH/"
    step "Writing ecomgear-api env to VPS1..."
    SK="${SUPABASE_SERVICE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
    ssh_vps1 "bash -s" << ENVREMOTE
set -e
cat > /var/www/ecomgear/.env.production << ENV
NODE_ENV=production
SUPABASE_URL=https://api.ecomgear.dev
SUPABASE_SERVICE_ROLE_KEY=${SK}
SUPABASE_SERVICE_KEY=${SK}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:-}
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET:-}
TENANT_DB_HOST=${TENANT_DB_HOST:-}
TENANT_DB_PORT=${TENANT_DB_PORT:-5432}
TENANT_DB_SUPERUSER=${TENANT_DB_SUPERUSER:-ecg_provisioner}
TENANT_DB_SUPERUSER_PASSWORD=${TENANT_DB_SUPERUSER_PASSWORD:-}
TENANT_DB_NAME=${TENANT_DB_NAME:-ecg_tenants}
TENANT_DB_JWT_SECRET=${TENANT_DB_JWT_SECRET:-}
TENANT_DB_API_URL=${TENANT_DB_API_URL:-https://cloud.ecomgear.app}
TENANT_DB_SSL=${TENANT_DB_SSL:-true}
TENANT_DB_RELOAD_URL=${TENANT_DB_RELOAD_URL:-}
TENANT_DB_RELOAD_SECRET=${TENANT_DB_RELOAD_SECRET:-}
ECG_PORTAL_URL=${ECG_PORTAL_URL:-}
ECG_SERVICE_KEY=${ECG_SERVICE_KEY:-}
ECOMGEAR_SERVER_URL=${ECOMGEAR_SERVER_URL:-}
DASHBOARD_ACCESS_SECRET=${DASHBOARD_ACCESS_SECRET:-}
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:-}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:-}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
PREVIEW_SERVICE_URL=${PREVIEW_SERVICE_URL:-https://preview.ecomgear.app}
PREVIEW_UPDATE_SECRET=${PREVIEW_UPDATE_SECRET:-}
HOSTING_SERVICE_URL=${HOSTING_SERVICE_URL:-}
HOSTING_SERVICE_SECRET=${HOSTING_SERVICE_SECRET:-}
ECG_AUTH_BASE_URL=${ECG_AUTH_BASE_URL:-https://auth.ecomgear.ai}
ECG_AUTH_API_KEY=${ECG_AUTH_API_KEY:-}
ECG_AUTH_2FA_ACTIVE=${ECG_AUTH_2FA_ACTIVE:-false}
FUNCTIONS_INTERNAL_SECRET=${FUNCTIONS_INTERNAL_SECRET:-}
ENV
ENVREMOTE
    step "Remote: atomic swap + PM2 restart (ecomgear-api)..."
    ssh_vps1 "bash -s" << 'REMOTE_API'
set -e
cd /var/www/ecomgear
rm -rf server.old
if [ -d server ]; then mv server server.old; fi
if [ ! -d server.staging ]; then echo "ERROR: server.staging missing   rsync may have failed" >&2; exit 1; fi
mv server.staging server
cd server
npm ci --omit=dev
[ -f /var/www/ecomgear/.env.production ] && set -a && . /var/www/ecomgear/.env.production && set +a
pm2 delete ecomgear-api 2>/dev/null || true
pm2 start /var/www/ecomgear/ecosystem.config.cjs --only ecomgear-api --update-env
pm2 save
echo "ecomgear-api restarted"
REMOTE_API
    success "VPS1 API server deployed"

    # ── Post-deploy health gate ──────────────────────────────────────────────
    # Block until Auth and REST are both responding 200. If either is still
    # loading (e.g. REST schema cache after an edge restart) we wait up to 90s
    # before failing the deploy   preventing a half-broken release from being
    # declared "done".
    step "Post-deploy health gate (auth + REST, up to 90s)..."
    API="https://api.ecomgear.dev"
    ANON_KEY="${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY not set}"
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
        echo "  Rolling back dist/ → previous version (dist.old)..."
        ssh_vps1 "bash -s" << 'REMOTE' || echo "  ⚠ Rollback command itself failed   manual intervention needed on VPS1"
set -e
cd /var/www/ecomgear
if [ -d dist.old ]; then
    rm -rf dist.failed
    mv dist dist.failed
    mv dist.old dist
    nginx -t && systemctl reload nginx
    echo "  ROLLED BACK   previous dist/ restored, broken build kept at dist.failed"
else
    echo "  No dist.old to roll back to   this may have been the first-ever deploy"
fi
REMOTE
        err "Health gate failed (Supabase Auth/REST, not the frontend itself   check VPS1 containers: ssh root@$VPS1_IP 'docker ps')"
    fi

    success "VPS1 deploy complete → https://ecomgear.dev"
}

# =========================================================================
# VPS2   Deploy Preview Service (zero-downtime)
# Strategy:
#   1. rsync to preview-service.staging/ (never touches running service)
#   2. Atomic mv swap: running dir → .old backup, staging → active
#   3. pm2 reload (graceful restart   not delete+start)
#      On shutdown the old process writes a warmup list of active project IDs;
#      the new process restores those Vite servers in the background so
#      users don't see their ecosystem reset.
#   Note: projects/ dir is ALWAYS excluded from rsync   user files never touched.
# =========================================================================
deploy_vps2() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS2   Preview Service → $VPS2_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    step "Checking for packages the agent installed at runtime since the last deploy..."
    # /packages/install (preview-service/server.js) lets the agent's run_command
    # tool add a dependency straight into the LIVE server's package.json via
    # `npm install <pkg>` in its own directory   but that change only exists on
    # VPS2, never in this repo. The next deploy used to run `npm ci` from this
    # repo's lockfile, silently discarding every package added that way since
    # the last deploy (reported bug: "libraries gone after any new deployment").
    # Fix: pull the live package.json's dependencies and merge any that are
    # missing locally BEFORE installing, so they survive this deploy and get
    # committed here for every deploy after.
    REMOTE_PKG_JSON=$(ssh_vps2 "cat /var/www/ecomgear/preview-service/package.json 2>/dev/null" || echo "")
    if [ -n "$REMOTE_PKG_JSON" ]; then
        MERGE_RESULT=$(node -e "
const fs = require('fs');
const path = '$PROJECT_DIR/preview-service/package.json';
const local = JSON.parse(fs.readFileSync(path, 'utf8'));
let remote;
try { remote = JSON.parse(process.argv[1]); } catch { console.log('0'); process.exit(0); }
const added = [];
for (const dep of ['dependencies', 'devDependencies']) {
    const remoteDeps = remote[dep] || {};
    local[dep] = local[dep] || {};
    for (const [name, version] of Object.entries(remoteDeps)) {
        if (!local[dep][name]) {
            local[dep][name] = version;
            added.push(name);
        }
    }
}
if (added.length > 0) {
    fs.writeFileSync(path, JSON.stringify(local, null, 4) + '\n');
}
console.log(added.length + (added.length ? ':' + added.join(',') : ''));
" "$REMOTE_PKG_JSON")
        ADDED_COUNT="${MERGE_RESULT%%:*}"
        if [ "$ADDED_COUNT" != "0" ]; then
            ADDED_NAMES="${MERGE_RESULT#*:}"
            success "Preserved $ADDED_COUNT runtime-installed package(s): $ADDED_NAMES"
        else
            success "No runtime-installed packages to preserve"
        fi
    else
        echo "  (no live preview-service found   first deploy, skipping check)"
    fi

    step "Installing preview-service production deps locally..."
    cd "$PROJECT_DIR/preview-service"
    if [ "${ADDED_COUNT:-0}" != "0" ]; then
        # A package was merged in above   it won't be in package-lock.json yet,
        # so `npm ci` would reject the lockfile as out of sync. Use `npm install`
        # to resolve and update the lockfile, same as a developer adding a dep.
        npm install --omit=dev
    else
        npm ci --omit=dev
    fi
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
    echo "ERROR: preview health check failed   rolling back"
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
# VPS3   Deploy Server / Agent
# Strategy:
#   1. Upload to server.staging/
#   2. Atomic mv swap: server → server.old backup, staging → server
#   3. Hard PM2 restart: `pm2 delete` then `pm2 start` (NOT a rolling reload  
#      see step 6 below in the code). This is a deliberate choice, not an
#      oversight: avoids PM2 cluster socket-inheritance issues that caused
#      problems with `pm2 reload` on this app in the past. There IS a real
#      downtime window between delete and the new workers passing their
#      health check (up to ~36s, per the retry loop in step 8)   this is
#      NOT zero-downtime. If that gap matters, this needs an actual `pm2
#      reload`-based rewrite, not just a comment fix.
# =========================================================================
deploy_vps3() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS3   Server / Agent Runner → $VPS3_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ -f "$PROJECT_DIR/server/src/index.ts" ]; then
        step "Building server TypeScript..."
        cd "$PROJECT_DIR/server"
        npm ci
        npm run build
        cd "$PROJECT_DIR"
        success "Server built (server/dist/)"
    else
        info "No server/src/index.ts   skipping server build"
    fi
    step "Uploading server to VPS3 (staging dir)..."
    ssh_vps3 "mkdir -p $DEPLOY_PATH/server.staging $DEPLOY_PATH/logs $DEPLOY_PATH/backups"
    # node_modules is excluded   it's reinstalled remotely (npm ci --omit=dev
    # below), same pattern as VPS4. Shipping node_modules over rsync was
    # dragging every deploy out to 10+ minutes for no benefit: the CI-built
    # copy still needs prod-only deps and the wrong platform's native builds
    # would follow it there anyway.
    [ -d "$PROJECT_DIR/server/dist" ] && \
        scp_vps3 --exclude='.env' --exclude='.env.*' --exclude='node_modules' \
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
    TDB_API_URL="${TENANT_DB_API_URL:-https://cloud.ecomgear.app}"
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
AI_FALLBACK_MODEL=gemini-flash-latest
AI_DISABLED_MODEL_IDS=${AI_DISABLED_MODEL_IDS:-}
ECG_PORTAL_URL=${ECG_PORTAL_URL}
ECG_SERVICE_KEY=${ECG_SERVICE_KEY}
ECOMGEAR_SERVER_URL=${ECOMGEAR_SERVER_URL}
DASHBOARD_ACCESS_SECRET=${DASHBOARD_ACCESS_SECRET:-}
FUNCTIONS_INTERNAL_SECRET=${FUNCTIONS_INTERNAL_SECRET:-}
# LLM API keys are managed via the Admin panel   stored in Supabase, not here.
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

# ── 2b. Install deps into staging (node_modules is excluded from the upload) ──
cd "\$DEPLOY_PATH/server.staging" && npm ci --omit=dev
cd "\$DEPLOY_PATH"

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
#       NOT in the current PM2 roster   leftover from manual starts or
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

# ── 6. Hard PM2 restart (delete + start   no socket inheritance) ──────────────
[ -f .env.production ] && set -a && . ./.env.production && set +a

# Send a real SIGTERM and wait BEFORE deleting. `pm2 delete` alone does not
# reliably run this app's graceful-shutdown path (confirmed live: agent_locks
# rows for in-flight agent runs kept leaking on every deploy, with zero
# "[agent-lock]" log lines near shutdown, even after wiring both a
# SIGTERM/SIGINT handler and an IPC 'shutdown_with_message' handler in
# index.ts -- pm2 delete just doesn't honor either path the way pm2
# stop/reload do). `pm2 sendSignal` sends the OS signal directly and
# unambiguously, so the app's own SIGTERM handler (which releases any
# agent_locks rows it holds before exiting) actually gets a chance to run.
pm2 sendSignal SIGTERM "\$APP_NAME" 2>/dev/null || true
sleep 13

pm2 delete "\$APP_NAME" 2>/dev/null || true
sleep 2

# NOTE: PM2 master daemon (not the workers) holds port \$PORT permanently.
# There is no "port release" to wait for   the master socket stays bound
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

# Ensure PM2 auto-starts on reboot (idempotent   safe to run every deploy)
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
    echo "  Health check \$i/12   waiting..."
    sleep 3
done

if [ \$HEALTHY -eq 0 ]; then
    echo "ERROR: gen API failed to respond after 36s   rolling back"
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
    echo "  ROLLED BACK   check server.failed for the broken build"
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
# VPS4   Deploy Enterprise Hosting Service
# Strategy: same shape as VPS2/VPS3   rsync to a staging path, bootstrap
# deps if missing, restart via PM2, verify health, roll back on failure.
# NOT zero-downtime: single PM2 instance, hard delete+start   there is a real
# gap between the old process stopping and the new one passing its health
# check. Fine for an internal hosting-control-plane service; would need a
# second instance + reload strategy if that gap becomes a problem.
# Caddy (not nginx) fronts this service   it auto-provisions HTTPS per
# published-app subdomain.
# =========================================================================
deploy_vps4() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS4   Enterprise Hosting Service → $VPS4_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if [ ! -d "$PROJECT_DIR/hosting-service" ]; then
        err "hosting-service/ directory not found in repo   nothing to deploy"
    fi

    step "Bootstrapping VPS4 (Node 20 + Caddy + PM2 if missing)..."
    ssh_vps4 "bash -s" << 'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
command -v rsync &>/dev/null || apt-get install -y -qq rsync
if ! node --version 2>/dev/null | grep -q 'v20'; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi
command -v pm2 &>/dev/null || npm install -g pm2
if ! command -v caddy &>/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y caddy
fi
mkdir -p /opt/ecomgear/hosting-service.staging /var/www/ecomgear/sites /etc/caddy/sites
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
REMOTE

    step "Uploading hosting-service/ to VPS4 (staging dir)..."
    scp_vps4 --delete --exclude='node_modules' --exclude='.git' --exclude='*.log' \
        "$PROJECT_DIR/hosting-service/" "$VPS4_USER@$VPS4_IP:/opt/ecomgear/hosting-service.staging/"

    step "Remote: install deps, atomic swap, Caddy + PM2 restart..."
    # Real incident: this read HOSTING_DEPLOY_SECRET, but .deploy.env (and
    # VPS1's own env, via hosting.routes.ts) only ever defined
    # HOSTING_SERVICE_SECRET   every vps4 deploy silently wrote an EMPTY
    # secret into VPS4's ecosystem.config.cjs, so every deploy/activate call
    # from the platform 401'd before writing a single file. Every custom
    # domain on this node was broken until this was found by hand. Read the
    # var that's actually defined.
    HOSTING_SECRET="${HOSTING_SERVICE_SECRET:-}"
    if [ -z "$HOSTING_SECRET" ]; then
        echo -e "${YELLOW}  ⚠ HOSTING_SERVICE_SECRET is not set   VPS4 will be deployed with an EMPTY deploy secret, breaking all custom-domain deploys/activations.${NC}"
    fi
    ssh_vps4 "bash -s" << REMOTE
set -e
cd /opt/ecomgear/hosting-service.staging
npm ci --omit=dev

cat > /opt/ecomgear/hosting-service.staging/ecosystem.config.cjs << 'PMEOF'
module.exports = {
  apps: [{
    name: 'ecomgear-hosting',
    script: 'server.js',
    cwd: '/opt/ecomgear/hosting-service',
    env: {
      HOSTING_PUBLIC_IP: '$VPS4_IP',
      HOSTING_NODE_NAME: 'vps4-hosting-1',
      DEFAULT_DOMAIN: 'apps.ecomgear.app',
      HOSTING_PORT: '4000',
      NODE_ENV: 'production',
      HOSTING_DEPLOY_SECRET: '${HOSTING_SECRET}'
    }
  }]
};
PMEOF

# Atomic swap   same pattern as VPS2/VPS3, keeps the old version until the
# new one is confirmed healthy below.
rm -rf /opt/ecomgear/hosting-service.old
[ -d /opt/ecomgear/hosting-service ] && mv /opt/ecomgear/hosting-service /opt/ecomgear/hosting-service.old
mv /opt/ecomgear/hosting-service.staging /opt/ecomgear/hosting-service

cp /opt/ecomgear/hosting-service/Caddyfile /etc/caddy/Caddyfile 2>/dev/null || true
systemctl stop nginx 2>/dev/null || true
systemctl disable nginx 2>/dev/null || true
systemctl enable caddy 2>/dev/null || true
systemctl start caddy 2>/dev/null || caddy start --config /etc/caddy/Caddyfile --adapter caddyfile
caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null || true

cd /opt/ecomgear/hosting-service
pm2 delete ecomgear-hosting 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save --force

sleep 4
if ! curl -sf http://127.0.0.1:4000/health >/dev/null 2>&1; then
    echo "ERROR: hosting service failed health check   rolling back"
    pm2 delete ecomgear-hosting 2>/dev/null || true
    rm -rf /opt/ecomgear/hosting-service.failed
    mv /opt/ecomgear/hosting-service /opt/ecomgear/hosting-service.failed
    [ -d /opt/ecomgear/hosting-service.old ] && mv /opt/ecomgear/hosting-service.old /opt/ecomgear/hosting-service
    cd /opt/ecomgear/hosting-service
    pm2 start ecosystem.config.cjs 2>/dev/null || true
    pm2 save --force
    echo "ROLLED BACK   check hosting-service.failed for the broken build"
    exit 1
fi
echo "  hosting service healthy"
echo "Backup preserved at hosting-service.old for manual rollback"
REMOTE
    success "VPS4 deploy complete → https://apps.ecomgear.app"
}

# =========================================================================
# VPS5   Tenant Postgres (paid-user hosted DBs)   health check only
# No application code from this repo is deployed here. VPS5 is a passive DB
# endpoint (TENANT_DB_HOST) that VPS3's server.env points at for the hosted-
# database feature. This target verifies the DB and its reload sidecar are
# reachable   useful to run before/after a VPS3 deploy so a DB-side outage
# isn't mistaken for a VPS3 regression.
# =========================================================================
deploy_vps5() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VPS5   Tenant Postgres (health check only) → $VPS5_IP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    info "No code is deployed to VPS5 from this repo   this only checks reachability."

    step "Checking Postgres port (${TENANT_DB_PORT:-5432})..."
    # Run the whole check as a heredoc script on the remote side rather than a
    # one-line inline command   avoids fragile nested-quoting across the
    # local shell → ssh → remote shell hops for $? and /dev/tcp redirection.
    TDB_PORT_CHECK="${TENANT_DB_PORT:-5432}"
    if ssh_vps5 "bash -s" << REMOTE
if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h 127.0.0.1 -p ${TDB_PORT_CHECK} -q && exit 0 || exit 1
fi
timeout 3 bash -c "</dev/tcp/127.0.0.1/${TDB_PORT_CHECK}" 2>/dev/null && exit 0
exit 1
REMOTE
    then
        success "Postgres (or its port) is reachable on VPS5"
    else
        err "Postgres port ${TDB_PORT_CHECK} is NOT reachable on VPS5"
    fi

    if [ -n "${TENANT_DB_RELOAD_URL:-}" ]; then
        step "Checking tenant-db reload sidecar ($TENANT_DB_RELOAD_URL)..."
        CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$TENANT_DB_RELOAD_URL" 2>/dev/null || echo "000")
        if [[ "$CODE" =~ ^(200|401|403|404)$ ]]; then
            # Any of these means the sidecar process is up and answering HTTP  
            # 401/403/404 are fine here since we're not authenticating, we just
            # want proof something is listening.
            success "Reload sidecar responding (HTTP $CODE)"
        else
            echo "  ⚠ Reload sidecar did not respond as expected (HTTP $CODE)   may be down or misconfigured"
        fi
    else
        info "TENANT_DB_RELOAD_URL not set   skipping sidecar check"
    fi

    success "VPS5 health check complete"
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
    vps4) deploy_vps4 ;;
    vps5) deploy_vps5 ;;
    all)  deploy_vps1; deploy_vps2; deploy_vps3; deploy_vps4; deploy_vps5 ;;
    *)    echo "Usage: $0 [vps1|vps2|vps3|vps4|vps5|all]"; exit 1 ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  All done!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$TARGET" == "all" || "$TARGET" == "vps1" ]] && echo "  Frontend  → https://ecomgear.dev"
[[ "$TARGET" == "all" || "$TARGET" == "vps2" ]] && echo "  Preview   → https://preview.ecomgear.app"
[[ "$TARGET" == "all" || "$TARGET" == "vps3" ]] && echo "  Gen API   → https://gen.ecomgear.dev"
[[ "$TARGET" == "all" || "$TARGET" == "vps4" ]] && echo "  Hosting   → https://apps.ecomgear.app"
[[ "$TARGET" == "all" || "$TARGET" == "vps5" ]] && echo "  Tenant DB → checked (no deploy)"
echo ""
