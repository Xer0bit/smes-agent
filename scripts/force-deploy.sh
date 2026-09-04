#!/usr/bin/env bash
# ============================================================
# force-deploy.sh   One-shot local deploy to all VPS
# Usage:
#   ./scripts/force-deploy.sh              # deploy all (vps1-3)
#   ./scripts/force-deploy.sh vps1         # frontend only
#   ./scripts/force-deploy.sh vps2         # preview only
#   ./scripts/force-deploy.sh vps3         # agent/gen only
#   ./scripts/force-deploy.sh vps4         # hosting service only
#   ./scripts/force-deploy.sh all          # all 4 VPS
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ENV="$ROOT_DIR/.deploy.env"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[DEPLOY]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()  { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

# ── Load credentials ─────────────────────────────────────────
[[ -f "$DEPLOY_ENV" ]] || die ".deploy.env not found."
# shellcheck disable=SC1090
source "$DEPLOY_ENV"
: "${VPS1_HOST:?}" "${VPS1_USER:?}" "${VPS1_PASS:?}"
: "${VPS2_HOST:?}" "${VPS2_USER:?}" "${VPS2_PASS:?}"
: "${VPS3_HOST:?}" "${VPS3_USER:?}" "${VPS3_PASS:?}"
VPS4_HOST="${VPS4_HOST:-}"
VPS4_USER="${VPS4_USER:-root}"
VPS4_PASS="${VPS4_PASS:-}"

# ── Dependency check ──────────────────────────────────────────
for cmd in sshpass rsync ssh npm node; do
  command -v "$cmd" &>/dev/null || die "'$cmd' is required but not installed."
done

# ── SSH helpers ───────────────────────────────────────────────
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=30 -o PubkeyAuthentication=no -o PreferredAuthentications=password"

# Per-host port overrides. VPS2_PORT defaults to 22 (standard SSH).
VPS2_SSH_PORT="${VPS2_PORT:-22}"

ssh_run() {
  local host="$1" user="$2" pass="$3" script="$4" port="${5:-22}"
  # shellcheck disable=SC2086
  echo "$script" | sshpass -p "$pass" ssh $SSH_OPTS -p "$port" "${user}@${host}" bash
}

rsync_to() {
  local src="$1" dest_path="$2" host="$3" user="$4" pass="$5" port="${6:-22}"
  # shellcheck disable=SC2086
  sshpass -p "$pass" rsync -avz --delete \
    --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='*.log' \
    -e "ssh $SSH_OPTS -p $port" \
    "$src" "${user}@${host}:${dest_path}"
}

rsync_file() {
  local src="$1" dest_path="$2" host="$3" user="$4" pass="$5" port="${6:-22}"
  # shellcheck disable=SC2086
  sshpass -p "$pass" rsync -avz \
    -e "ssh $SSH_OPTS -p $port" \
    "$src" "${user}@${host}:${dest_path}"
}

rsync_preview_service() {
  local src="$1" dest_path="$2" host="$3" user="$4" pass="$5" port="${6:-22}"
  # Keep generated preview projects on the server; don't try deleting runtime project dirs.
  # shellcheck disable=SC2086
  sshpass -p "$pass" rsync -avz --delete \
    --filter='P projects/***' \
    --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='*.log' \
    -e "ssh $SSH_OPTS -p $port" \
    "$src" "${user}@${host}:${dest_path}"
}

# ============================================================
# VPS1   Frontend (SMEsAgent.dev)
# ============================================================
deploy_vps1() {
  log "═══ VPS1 ($VPS1_HOST)   Building & deploying frontend ═══"
  cd "$ROOT_DIR"
  local active_supabase_dir="/root/ecom-ondy/SMEsAgent/supabase"
  local legacy_supabase_dir="/var/www/SMEsAgent/SMEsAgent-agent/supabase"

  # ── 1. Build ──────────────────────────────────────────────
  log "Building React SPA..."
  [[ -f .env.production ]] || die ".env.production missing"
  if grep -q "YOUR_SUPABASE_ANON_KEY" .env.production; then
    warn "VITE_SUPABASE_ANON_KEY is still a placeholder in .env.production"
    warn "Get it via: ssh root@$VPS1_HOST 'cd /var/www/SMEsAgent && npx supabase status'"
  fi
  npm run build
  ok "Build complete (dist/)"

  # ── 2. Bootstrap remote ──────────────────────────────────
  ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" "
    export DEBIAN_FRONTEND=noninteractive
    command -v certbot &>/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
    mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/SMEsAgent/dist
  "

  # ── 3. Upload dist/ ───────────────────────────────────────
  log "Uploading dist/ → VPS1..."
  # shellcheck disable=SC2086
  sshpass -p "$VPS1_PASS" rsync -avz --delete \
    -e "ssh $SSH_OPTS" \
    "$ROOT_DIR/dist/" "${VPS1_USER}@${VPS1_HOST}:/var/www/SMEsAgent/dist/"

  # ── 3.5. Deploy edge functions ───────────────────────────
  log "Uploading edge functions → VPS1..."
  for supabase_dir in "$active_supabase_dir" "$legacy_supabase_dir"; do
    ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" "mkdir -p $supabase_dir/functions $supabase_dir/functions/_shared"
    # shellcheck disable=SC2086
    sshpass -p "$VPS1_PASS" rsync -avz --delete \
      --exclude='.env' \
      -e "ssh $SSH_OPTS" \
      "$ROOT_DIR/supabase/functions/" \
      "${VPS1_USER}@${VPS1_HOST}:${supabase_dir}/functions/"
    rsync_file "$ROOT_DIR/supabase/config.toml" \
      "${supabase_dir}/config.toml" \
      "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS"
    if [[ -f "$ROOT_DIR/supabase/functions/.env" ]]; then
      rsync_file "$ROOT_DIR/supabase/functions/.env" \
        "${supabase_dir}/functions/.env" \
        "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS"
    fi
  done
  # ── 3.6. Push edge function secrets ─────────────────────
  log "Setting edge function secrets on VPS1..."
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    # Build secrets env string from .deploy.env values
    SECRETS_CMD="cd /root/ecom-ondy/SMEsAgent && export SUPABASE_ACCESS_TOKEN='${SUPABASE_ACCESS_TOKEN}'"
    [[ -n "${STRIPE_SECRET_KEY:-}" ]] && \
      SECRETS_CMD+=" && npx supabase secrets set STRIPE_SECRET_KEY='${STRIPE_SECRET_KEY}'"
    [[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]] && \
      SECRETS_CMD+=" && npx supabase secrets set STRIPE_WEBHOOK_SECRET='${STRIPE_WEBHOOK_SECRET}'"
    [[ -n "${STRIPE_SANDBOX:-}" ]] && \
      SECRETS_CMD+=" && npx supabase secrets set STRIPE_SANDBOX='${STRIPE_SANDBOX}'"
    [[ -n "${RESEND_API_KEY:-}" ]] && \
      SECRETS_CMD+=" && npx supabase secrets set RESEND_API_KEY='${RESEND_API_KEY}'"
    [[ -n "${GOOGLE_CLIENT_ID:-}" ]] && \
      SECRETS_CMD+=" && npx supabase secrets set GOOGLE_CLIENT_ID='${GOOGLE_CLIENT_ID}'"
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] && \
      SECRETS_CMD+=" && npx supabase secrets set ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}'"
    ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" "$SECRETS_CMD && echo 'Secrets updated'" || \
      warn "Could not set secrets via supabase CLI   runtime restart applied"
  else
    log "SUPABASE_ACCESS_TOKEN not set; skipping 'supabase secrets set' and using synced function env files"
  fi

  ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" \
    "docker restart supabase_edge_runtime_zurneeqpussrefamhtoq && echo 'Edge runtime restarted'"
  ok "Edge functions deployed ✓"

  # ── 4. Write local HTTP-only nginx config ─────────────────
  cat > "$TMP_DIR/vps1-http.conf" << 'NGINX'
map $http_origin $cors_origin {
    default                                       "";
    "https://www.SMEsAgent.dev"                    "https://www.SMEsAgent.dev";
    "https://SMEsAgent.dev"                        "https://SMEsAgent.dev";
    "https://1000.SMEsAgent.dev"                   "https://1000.SMEsAgent.dev";
    ~^https://.*\.preview\.SMEsAgent\.app$         $http_origin;
    "http://localhost:8080"                       "http://localhost:8080";
    "http://localhost:5173"                       "http://localhost:5173";
}
# Required for WebSocket (Supabase Realtime)
map $http_upgrade $connection_upgrade {
    default   upgrade;
    ''        close;
}
server {
    listen 80;
    server_name www.SMEsAgent.dev SMEsAgent.dev;
    root  /var/www/SMEsAgent/dist;
    index index.html;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
  location /assets/ {
    try_files $uri @missing_asset;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
  location ~* \.(css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
  location = /index.html {
    add_header Cache-Control "no-store, must-revalidate";
    expires -1;
    }
    location / { try_files $uri $uri/ /index.html; }

  location @missing_asset {
    default_type application/javascript;
    add_header Cache-Control "no-store, must-revalidate" always;
    if ($uri ~* \.js$) {
      return 200 "window.location.reload();";
    }
    return 404;
  }
}
server {
    listen 80;
    server_name api.SMEsAgent.dev;
    client_max_body_size 20m;  # allow large file uploads to storage
    # ── Realtime WebSocket   must be before the catch-all location ──
    location /realtime/ {
        proxy_pass http://127.0.0.1:54321;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    "websocket";
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location / {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  $cors_origin;
            add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS";
            add_header Access-Control-Allow-Headers "Authorization,Content-Type,cache-control,x-requested-with,apikey,x-client-info,x-supabase-api-version,accept-profile,content-profile,prefer,range,x-upsert,x-external-authorization" always;
            add_header Access-Control-Max-Age       86400;
            return 204;
        }
        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Methods;
        proxy_hide_header Access-Control-Allow-Headers;
        proxy_hide_header Access-Control-Allow-Credentials;
        proxy_hide_header Access-Control-Expose-Headers;
        proxy_pass http://127.0.0.1:54321;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Access-Control-Allow-Origin  $cors_origin always;
        add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization,Content-Type,cache-control,x-requested-with,apikey,x-client-info,x-supabase-api-version,accept-profile,content-profile,prefer,range,x-upsert,x-external-authorization" always;
    }
}
server {
    listen 80;
    server_name 1000.SMEsAgent.dev;
    root  /var/www/SMEsAgent/dist;
    index index.html;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    location = / { return 301 /admin/; }
    location /assets/ {
        try_files $uri @missing_asset;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location ~* \.(css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate";
        expires -1;
    }
    location / { try_files $uri $uri/ /index.html; }
    location @missing_asset {
        default_type application/javascript;
        add_header Cache-Control "no-store, must-revalidate" always;
        if ($uri ~* \.js$) { return 200 "window.location.reload();"; }
        return 404;
    }
}
NGINX

  # ── 5. Upload nginx config + reload ──────────────────────
  rsync_file "$TMP_DIR/vps1-http.conf" "/etc/nginx/sites-available/SMEsAgent" \
    "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS"
  ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" "
    rm -f /etc/nginx/sites-enabled/test2.SMEsAgent.dev /etc/nginx/sites-available/test2.SMEsAgent.dev
    rm -f /etc/nginx/sites-enabled/SMEsAgent.conf /etc/nginx/sites-available/SMEsAgent.conf
    ln -sf /etc/nginx/sites-available/SMEsAgent /etc/nginx/sites-enabled/SMEsAgent
    nginx -t && systemctl reload nginx && echo 'Nginx reloaded on VPS1'
  "

  # ── 6. Run DB migrations ─────────────────────────────────
  log "Applying DB migrations → VPS1..."
  sshpass -p "$VPS1_PASS" rsync -avz \
    -e "ssh $SSH_OPTS" \
    "$ROOT_DIR/supabase/migrations/" \
    "${VPS1_USER}@${VPS1_HOST}:/tmp/ecg-migrations/"

  # Write the migration runner as a standalone script to avoid shell-quoting
  # issues when embedding SQL strings inside an SSH heredoc.
  cat > "$TMP_DIR/run-migrations.sh" << 'MIGRATE_EOF'
#!/usr/bin/env bash
BENIGN="already exists|already member of publication|permission denied for function pg_read_file|must be owner of table objects|cannot change name of view column|cannot change data type of view column"
DB_CTR=$(docker ps --format "{{.Names}}" | grep supabase_db_ | head -1)

# Ensure migration tracking table exists (idempotent   safe on every deploy)
docker exec "$DB_CTR" psql -U postgres -d postgres -c "
  CREATE TABLE IF NOT EXISTS public._ecg_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );" 2>/dev/null || true

for f in $(ls /tmp/ecg-migrations/*.sql | sort); do
  fname=$(basename "$f")
  # Skip if this migration was already applied
  already=$(docker exec "$DB_CTR" psql -U postgres -d postgres -tAq \
    -c "SELECT 1 FROM public._ecg_migrations WHERE filename='$fname'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$already" = "1" ]; then
    echo "  skip (already applied): $fname"
    continue
  fi

  echo "Applying $fname..."
  docker exec -i "$DB_CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=off < "$f" 2>&1 \
    | grep -E "^(CREATE|ALTER|INSERT|DROP|ERROR|GRANT)" \
    | grep -Ev "$BENIGN" \
    | head -5

  # Record so it is never re-run on future deploys
  docker exec "$DB_CTR" psql -U postgres -d postgres \
    -c "INSERT INTO public._ecg_migrations (filename) VALUES ('$fname') ON CONFLICT DO NOTHING;" \
    2>/dev/null || true
done
echo "Migrations done."
MIGRATE_EOF

  rsync_file "$TMP_DIR/run-migrations.sh" "/tmp/run-ecg-migrations.sh" \
    "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS"
  ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" \
    "chmod +x /tmp/run-ecg-migrations.sh && bash /tmp/run-ecg-migrations.sh"
  ok "Migrations applied ✓"

  # ── 7. SSL cert   reinstall if exists, issue if not ───────
  log "Configuring SSL for VPS1..."
  ssh_run "$VPS1_HOST" "$VPS1_USER" "$VPS1_PASS" "
    if [ -f /etc/letsencrypt/live/www.SMEsAgent.dev/fullchain.pem ]; then
      certbot --nginx --non-interactive --agree-tos --no-eff-email --redirect --expand \
        --cert-name www.SMEsAgent.dev \
        -d SMEsAgent.dev -d www.SMEsAgent.dev -d api.SMEsAgent.dev -d 1000.SMEsAgent.dev 2>&1 \
        && systemctl reload nginx \
        && echo '[SSL] apex/www/api cert updated'
    else
      certbot --nginx --non-interactive --agree-tos --no-eff-email \
        -m admin@SMEsAgent.dev \
        -d SMEsAgent.dev -d www.SMEsAgent.dev -d api.SMEsAgent.dev -d 1000.SMEsAgent.dev \
        2>&1 && echo '[SSL] apex/www/api cert issued' || echo '[SSL] certbot failed - HTTP for now'
    fi
  " || true
  ok "VPS1 frontend deployed ✓"
}

# ============================================================
# VPS2   Preview Service (preview.SMEsAgent.app)
# ============================================================
deploy_vps2() {
  log "═══ VPS2 ($VPS2_HOST)   Deploying preview service ═══"
  cd "$ROOT_DIR"

  # ── 1. Bootstrap: Node 20 + nginx + PM2 + certbot ────────
  log "Bootstrapping VPS2..."
  ssh_run "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "
    export DEBIAN_FRONTEND=noninteractive
    if ! node --version 2>/dev/null | grep -q 'v20'; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs
    fi
    command -v nginx &>/dev/null || (apt-get update -qq && apt-get install -y -qq nginx)
    command -v pm2 &>/dev/null || npm install -g pm2
    command -v certbot &>/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
    mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/SMEsAgent/preview-service /var/www/html
  " "$VPS2_SSH_PORT"

  # ── 2. Upload apps/preview-service/ ───────────────────────────
  log "Uploading apps/preview-service/ → VPS2..."
  rsync_preview_service "$ROOT_DIR/apps/preview-service/" "/var/www/SMEsAgent/preview-service/" \
    "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "$VPS2_SSH_PORT"
  rsync_file "$ROOT_DIR/infrastructure/ecosystem.config.cjs" "/var/www/SMEsAgent/ecosystem.config.cjs" \
    "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "$VPS2_SSH_PORT"

  # ── 3. Write local HTTP-only nginx config ─────────────────
  cat > "$TMP_DIR/vps2-http.conf" << 'NGINX'
server {
    listen 80;
    server_name preview.SMEsAgent.app;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    # Health check   proxy through Express so CORS headers are included
    location = /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Methods;
        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
    }

    # Preview file-update endpoint   large body + CORS + no buffering
    location ~ ^/preview/[^/]+/update$ {
        if ($request_method = 'OPTIONS') {
            add_header Access-Control-Allow-Origin  "*";
            add_header Access-Control-Allow-Methods "POST, OPTIONS";
            add_header Access-Control-Allow-Headers "Content-Type, Authorization";
            add_header Access-Control-Max-Age        86400;
            add_header Content-Length 0;
            add_header Content-Type "text/plain";
            return 204;
        }
        client_max_body_size 50m;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_hide_header  Access-Control-Allow-Origin;
        proxy_hide_header  Access-Control-Allow-Methods;
        proxy_hide_header  Access-Control-Allow-Headers;
        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
    }

    # Publish endpoint   needs large body for full project file uploads
    location ~ ^/(check-subdomain|publish)(/.*)?$ {
        if ($request_method = 'OPTIONS') {
            add_header Access-Control-Allow-Origin  "*";
            add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS";
            add_header Access-Control-Allow-Headers "Content-Type, Authorization";
            add_header Access-Control-Max-Age        86400;
            add_header Content-Length 0;
            add_header Content-Type "text/plain";
            return 204;
        }
        client_max_body_size 200m;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection "";
        proxy_buffering    off;
        proxy_read_timeout 120s;
        proxy_hide_header  Access-Control-Allow-Origin;
        proxy_hide_header  Access-Control-Allow-Methods;
        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_hide_header  Access-Control-Allow-Origin;
        proxy_hide_header  Access-Control-Allow-Methods;
        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
    }
}

# Wildcard published subdomains   redirect {slug}.SMEsAgent.app → path-based HTTPS
# .app TLD is HSTS-preloaded: HTTP is blocked by all browsers.
# All published sites use https://preview.SMEsAgent.app/p/{slug} instead.
server {
    listen 80;
    server_name ~^(?<slug>[a-z0-9][a-z0-9-]*[a-z0-9])\.SMEsAgent\.app$;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    # Permanent redirect to path-based HTTPS URL (works even without wildcard cert)
    location / {
        return 301 https://preview.SMEsAgent.app/p/$slug$request_uri;
    }
}
NGINX

  # ── 4. Upload nginx config + reload ──────────────────────
  rsync_file "$TMP_DIR/vps2-http.conf" "/etc/nginx/sites-available/preview.conf" \
    "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "$VPS2_SSH_PORT"
  ssh_run "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "
    rm -f /etc/nginx/sites-enabled/SMEsAgent-preview /etc/nginx/sites-available/SMEsAgent-preview
    ln -sf /etc/nginx/sites-available/preview.conf /etc/nginx/sites-enabled/preview.conf
    nginx -t && systemctl reload nginx && echo 'nginx OK on VPS2'
  " "$VPS2_SSH_PORT"

  # ── 5. SSL cert   reinstall if exists, issue if not ───────
  log "Configuring SSL for VPS2..."
  ssh_run "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "
    if [ -f /etc/letsencrypt/live/preview.SMEsAgent.app/fullchain.pem ]; then
      certbot install --nginx --cert-name preview.SMEsAgent.app --non-interactive 2>&1 \
        && systemctl reload nginx \
        && echo '[SSL] Cert reinstalled into new config'
    else
      pkill -f certbot 2>/dev/null || true
      certbot --nginx --non-interactive --agree-tos --no-eff-email \
        -m admin@SMEsAgent.dev -d preview.SMEsAgent.app \
        2>&1 && echo '[SSL] preview.SMEsAgent.app cert issued' || echo '[SSL] certbot failed - HTTP for now'
    fi
  " "$VPS2_SSH_PORT" || true
  log "Wildcard preview subdomains are redirected to path-based HTTPS; wildcard cert is optional for current routing"

  # ── 6. npm ci + PM2 ──────────────────────────────────────
  ssh_run "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "
    cd /var/www/SMEsAgent/preview-service
    npm ci --omit=dev
    cd /var/www/SMEsAgent
    if pm2 list | grep -q 'SMEsAgent-preview'; then
      pm2 reload SMEsAgent-preview
    else
      pm2 start ecosystem.config.cjs --only SMEsAgent-preview
    fi
    pm2 save --force
    echo 'Preview service running on VPS2'
  " "$VPS2_SSH_PORT"

  # ── 7. Write + deploy hosting.SMEsAgent.app reverse-proxy ─
  log "Configuring hosting.SMEsAgent.app proxy on VPS2..."
  local vps4_target="${VPS4_HOST:-187.77.157.231}"
  cat > "$TMP_DIR/hosting-proxy.conf" << NGINX
# Allowed origins map   only SMEsAgent.dev frontends get CORS header
map \$http_origin \$cors_hosting {
    default                      "";
    "https://SMEsAgent.dev"       "https://SMEsAgent.dev";
    "https://www.SMEsAgent.dev"   "https://www.SMEsAgent.dev";
    "http://localhost:5173"      "http://localhost:5173";
    "http://localhost:8080"      "http://localhost:8080";
}

server {
    listen 80;
    server_name hosting.SMEsAgent.app;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    server_name hosting.SMEsAgent.app;

    ssl_certificate     /etc/letsencrypt/live/hosting.SMEsAgent.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hosting.SMEsAgent.app/privkey.pem;

    client_max_body_size 200M;

    location / {
        if (\$request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin      \$cors_hosting;
            add_header Access-Control-Allow-Credentials "true";
            add_header Access-Control-Allow-Methods     "GET, POST, PUT, PATCH, DELETE, OPTIONS";
            add_header Access-Control-Allow-Headers     "Authorization, Content-Type, x-deploy-secret";
            add_header Access-Control-Max-Age           86400;
            add_header Content-Length 0;
            return 204;
        }

        proxy_pass         http://${vps4_target}:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        proxy_connect_timeout 10s;

        # Strip upstream CORS headers before nginx adds the validated one
        proxy_hide_header  Access-Control-Allow-Origin;
        proxy_hide_header  Access-Control-Allow-Methods;
        proxy_hide_header  Access-Control-Allow-Headers;
        proxy_hide_header  Access-Control-Allow-Credentials;

        add_header Access-Control-Allow-Origin      \$cors_hosting always;
        add_header Access-Control-Allow-Credentials "true" always;
        add_header Access-Control-Allow-Methods     "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers     "Authorization, Content-Type, x-deploy-secret" always;
    }
}
NGINX

  rsync_file "$TMP_DIR/hosting-proxy.conf" \
    "/etc/nginx/sites-available/hosting.SMEsAgent.app.conf" \
    "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "$VPS2_SSH_PORT"
  ssh_run "$VPS2_HOST" "$VPS2_USER" "$VPS2_PASS" "
    ln -sf /etc/nginx/sites-available/hosting.SMEsAgent.app.conf \
           /etc/nginx/sites-enabled/hosting.SMEsAgent.app.conf
    nginx -t && systemctl reload nginx && echo 'hosting proxy config reloaded'
  " "$VPS2_SSH_PORT"
  ok "hosting.SMEsAgent.app proxy configured on VPS2 ✓"

  ok "VPS2 preview service deployed ✓"
}

# ============================================================
# VPS3   Agent / Gen Server (gen.SMEsAgent.dev + agent.SMEsAgent.dev)
# ============================================================
deploy_vps3() {
  log "═══ VPS3 ($VPS3_HOST)   Building & deploying agent/gen server ═══"
  cd "$ROOT_DIR"

  local supabase_service_key_effective="${SUPABASE_SERVICE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
  [[ -n "$supabase_service_key_effective" ]] || die "VPS3 deploy requires SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY in .deploy.env"

  # ── 1. Bootstrap ─────────────────────────────────────────
  ssh_run "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS" "
    export DEBIAN_FRONTEND=noninteractive
    command -v nginx &>/dev/null || (apt-get update -qq && apt-get install -y -qq nginx)
    command -v certbot &>/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
    command -v pm2 &>/dev/null || npm install -g pm2
    mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/SMEsAgent/server /var/www/SMEsAgent/supabase/functions
  "

  # ── 2. Build TypeScript ───────────────────────────────────
  log "Building TypeScript server..."
  cd "$ROOT_DIR/apps/api-gateway"
  npm ci
  npx tsc --project tsconfig.json
  cd "$ROOT_DIR"
  ok "Server compiled"

  # ── 3. Upload files (source only, no node_modules) ───────
  log "Uploading apps/api-gateway/ → VPS3..."
  # Upload server source (except node_modules   npm ci runs on remote)
  # shellcheck disable=SC2086
  sshpass -p "$VPS3_PASS" rsync -avz --delete \
    --filter='P logs/***' \
    --exclude='node_modules' --exclude='.git' --exclude='*.log' \
    -e "ssh $SSH_OPTS" \
    "$ROOT_DIR/apps/api-gateway/" "${VPS3_USER}@${VPS3_HOST}:/var/www/SMEsAgent/server/"
  rsync_to "$ROOT_DIR/supabase/functions/" "/var/www/SMEsAgent/supabase/functions/" \
    "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS"
  rsync_file "$ROOT_DIR/infrastructure/ecosystem.config.cjs" "/var/www/SMEsAgent/ecosystem.config.cjs" \
    "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS"

  # ── 4. Write local nginx config ───────────────────────────
  cat > "$TMP_DIR/vps3-http.conf" << 'NGINX'
  map $http_origin $frontend_cors_origin {
    default                     "";
    "https://SMEsAgent.dev"     "https://SMEsAgent.dev";
    "https://www.SMEsAgent.dev" "https://www.SMEsAgent.dev";
    "https://preview.SMEsAgent.app" "https://preview.SMEsAgent.app";
    "http://localhost:8080"    "http://localhost:8080";
    "http://localhost:5173"    "http://localhost:5173";
    "http://localhost:3000"    "http://localhost:3000";
    "http://127.0.0.1:8080"    "http://127.0.0.1:8080";
    "http://127.0.0.1:5173"    "http://127.0.0.1:5173";
    "http://127.0.0.1:3000"    "http://127.0.0.1:3000";
  }

  server {
    listen 80;
    server_name gen.SMEsAgent.dev;
    client_max_body_size 25m;

    location / {
      if ($request_method = 'OPTIONS') {
        add_header Access-Control-Allow-Origin      $frontend_cors_origin;
        add_header Access-Control-Allow-Methods     "GET, POST, PUT, PATCH, DELETE, OPTIONS";
        add_header Access-Control-Allow-Headers     "Authorization, Content-Type, Accept, Cache-Control, apikey, x-api-version, x-operation-id, idempotency-key, x-idempotency-key, x-client-info, x-upsert, prefer, range, Last-Event-ID";
        add_header Access-Control-Allow-Credentials "true";
        add_header Access-Control-Max-Age           86400;
        add_header Content-Length                   0;
        add_header Content-Type                     "text/plain";
        return 204;
      }

      proxy_pass http://127.0.0.1:5001;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_cache_bypass $http_upgrade;
      proxy_read_timeout 600s;
      proxy_send_timeout 600s;
      proxy_buffering off;
      add_header X-Accel-Buffering "no" always;

      proxy_hide_header Access-Control-Allow-Origin;
      proxy_hide_header Access-Control-Allow-Methods;
      proxy_hide_header Access-Control-Allow-Headers;
      proxy_hide_header Access-Control-Allow-Credentials;
      add_header Access-Control-Allow-Origin      $frontend_cors_origin always;
      add_header Access-Control-Allow-Credentials "true"             always;
    }
  }

  server {
    listen 80;
    server_name agent.SMEsAgent.dev;
    client_max_body_size 25m;

    location / {
      if ($request_method = 'OPTIONS') {
        add_header Access-Control-Allow-Origin      $frontend_cors_origin;
        add_header Access-Control-Allow-Methods     "GET, POST, PUT, PATCH, DELETE, OPTIONS";
        add_header Access-Control-Allow-Headers     "Authorization, Content-Type, Accept, Cache-Control, apikey, x-api-version, x-operation-id, idempotency-key, x-idempotency-key, x-client-info, x-upsert, prefer, range, Last-Event-ID";
        add_header Access-Control-Allow-Credentials "true";
        add_header Access-Control-Max-Age           86400;
        add_header Content-Length                   0;
        add_header Content-Type                     "text/plain";
        return 204;
      }

      proxy_pass http://127.0.0.1:5001;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_cache_bypass $http_upgrade;
      proxy_read_timeout 600s;
      proxy_send_timeout 600s;
      proxy_buffering off;
      add_header X-Accel-Buffering "no" always;

      proxy_hide_header Access-Control-Allow-Origin;
      proxy_hide_header Access-Control-Allow-Methods;
      proxy_hide_header Access-Control-Allow-Headers;
      proxy_hide_header Access-Control-Allow-Credentials;
      add_header Access-Control-Allow-Origin      $frontend_cors_origin always;
      add_header Access-Control-Allow-Credentials "true"             always;
    }
  }
NGINX

  # ── 5. Upload nginx config + reload ──────────────────────
  rsync_file "$TMP_DIR/vps3-http.conf" "/etc/nginx/sites-available/gen-agent.conf" \
    "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS"
  ssh_run "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS" "
    rm -f /etc/nginx/sites-enabled/SMEsAgent-gen /etc/nginx/sites-available/SMEsAgent-gen
    ln -sf /etc/nginx/sites-available/gen-agent.conf /etc/nginx/sites-enabled/gen-agent.conf
    nginx -t
    if ! systemctl is-active --quiet nginx; then
      systemctl start nginx && echo 'nginx started on VPS3';
    else
      systemctl reload nginx && echo 'nginx reloaded on VPS3';
    fi
  "

  # ── 6. Try SSL cert ───────────────────────────────────────
  log "Attempting certbot for gen/agent.SMEsAgent.dev..."
  ssh_run "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS" "
    if [ -f /etc/letsencrypt/live/gen.SMEsAgent.dev/fullchain.pem ]; then
      certbot install --nginx --cert-name gen.SMEsAgent.dev --non-interactive 2>&1 \
        && systemctl reload nginx \
        && echo '[SSL] Cert reinstalled into new config'
    else
      certbot --nginx --non-interactive --agree-tos --no-eff-email \
        -m admin@SMEsAgent.dev -d gen.SMEsAgent.dev -d agent.SMEsAgent.dev \
        2>&1 && echo '[SSL] gen/agent certs issued' || echo '[SSL] certbot failed - HTTP for now'
    fi
  " || true

  # ── 7. Write .env + start PM2 ────────────────────────────
  log "Writing server .env + starting PM2..."
  # Write env file locally then upload   avoids heredoc quoting issues with SSH
  cat > "$TMP_DIR/server.env" << ENVEOF
NODE_ENV=production
PORT=5001
AGENT_PORT=5002
SUPABASE_URL=https://api.SMEsAgent.dev
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:-}
SUPABASE_SERVICE_ROLE_KEY=${supabase_service_key_effective}
SUPABASE_SERVICE_KEY=${supabase_service_key_effective}
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
GEMINI_API_KEY=${GEMINI_API_KEY:-}
AI_MODEL=${AI_MODEL:-claude-sonnet-4-6}
AI_FALLBACK_MODEL=${AI_FALLBACK_MODEL:-deepseek-chat}
CORS_ORIGIN=https://SMEsAgent.dev,https://www.SMEsAgent.dev,http://localhost:5173,http://localhost:3000,http://localhost:8080
PREVIEW_DOMAIN=preview.SMEsAgent.app
PREVIEW_SERVICE_URL=https://preview.SMEsAgent.app
PREVIEW_CONTROL_URL=https://preview.SMEsAgent.app
SERVER_PROJECTS_DIR=/var/SMEsAgent/projects
LOG_LEVEL=info
TENANT_DB_HOST=${TENANT_DB_HOST:-}
TENANT_DB_PORT=${TENANT_DB_PORT:-5432}
TENANT_DB_SUPERUSER=${TENANT_DB_SUPERUSER:-}
TENANT_DB_SUPERUSER_PASSWORD=${TENANT_DB_SUPERUSER_PASSWORD:-}
TENANT_DB_NAME=${TENANT_DB_NAME:-}
TENANT_DB_JWT_SECRET=${TENANT_DB_JWT_SECRET:-}
TENANT_DB_API_URL=${TENANT_DB_API_URL:-}
TENANT_DB_SSL=${TENANT_DB_SSL:-}
TENANT_DB_RELOAD_URL=${TENANT_DB_RELOAD_URL:-}
TENANT_DB_RELOAD_SECRET=${TENANT_DB_RELOAD_SECRET:-}
ENVEOF
  rsync_file "$TMP_DIR/server.env" "/var/www/SMEsAgent/server/.env" \
    "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS"
  ssh_run "$VPS3_HOST" "$VPS3_USER" "$VPS3_PASS" "
    true  # env already written via rsync
    mkdir -p /var/SMEsAgent/projects
    cd /var/www/SMEsAgent/server
    npm ci
    npm run build 2>&1 || (echo 'TypeScript build failed'; exit 1)
    cd /var/www/SMEsAgent
    # Ensure PM2 process receives fresh env values from server/.env
    set -a
    . /var/www/SMEsAgent/server/.env
    set +a
    if pm2 list | grep -q 'SMEsAgent-gen'; then
      pm2 restart SMEsAgent-gen --update-env
    else
      pm2 start /var/www/SMEsAgent/server/dist/index.js --name SMEsAgent-gen --cwd /var/www/SMEsAgent/server 2>/dev/null || true
    fi
    pm2 save --force
    echo 'Gen server on VPS3'
  "
  ok "VPS3 agent/gen server deployed ✓"
}

# ============================================================
# VPS4   Enterprise Hosting Service
# ============================================================
deploy_vps4() {
  [[ -n "$VPS4_HOST" ]] || die "VPS4_HOST not set in .deploy.env"
  [[ -n "$VPS4_PASS" ]] || die "VPS4_PASS not set in .deploy.env"
  log "═══ VPS4 ($VPS4_HOST)   Deploying hosting service ═══"
  cd "$ROOT_DIR"

  # ── 1. Bootstrap: Node 20 + Caddy + PM2 ─────────────────
  log "Bootstrapping VPS4..."
  ssh_run "$VPS4_HOST" "$VPS4_USER" "$VPS4_PASS" "
    export DEBIAN_FRONTEND=noninteractive
    command -v rsync &>/dev/null || apt-get install -y -qq rsync
    if ! node --version 2>/dev/null | grep -q 'v20'; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs
    fi
    command -v pm2 &>/dev/null || npm install -g pm2
    if ! command -v caddy &>/dev/null; then
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      apt-get install -y caddy
    fi
    mkdir -p /opt/SMEsAgent/hosting-service /var/www/SMEsAgent/sites /etc/caddy/sites
    ufw allow 80/tcp 2>/dev/null || true
    ufw allow 443/tcp 2>/dev/null || true
  "

  # ── 2. Upload apps/hosting-service/ ───────────────────────────
  log "Uploading apps/hosting-service/ → VPS4..."
  sshpass -p "$VPS4_PASS" rsync -avz --delete \
    --exclude='node_modules' --exclude='.git' --exclude='*.log' \
    -e "ssh $SSH_OPTS" \
    "$ROOT_DIR/apps/hosting-service/" "${VPS4_USER}@${VPS4_HOST}:/opt/SMEsAgent/hosting-service/"

  # ── 3. Upload Caddyfile ──────────────────────────────────
  rsync_file "$ROOT_DIR/apps/hosting-service/Caddyfile" "/etc/caddy/Caddyfile" \
    "$VPS4_HOST" "$VPS4_USER" "$VPS4_PASS"

  # ── 4. npm ci + start services ───────────────────────────
  ssh_run "$VPS4_HOST" "$VPS4_USER" "$VPS4_PASS" "
    cd /opt/SMEsAgent/hosting-service
    npm ci --omit=dev

    # Stop nginx (Caddy takes over ports 80/443)
    systemctl stop nginx 2>/dev/null || true
    systemctl disable nginx 2>/dev/null || true

    # Start Caddy
    caddy stop 2>/dev/null || true
    pkill -9 caddy 2>/dev/null || true
    sleep 1
    systemctl enable caddy 2>/dev/null || true
    systemctl start caddy || caddy start --config /etc/caddy/Caddyfile --adapter caddyfile
    sleep 2
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null || true

    # Write PM2 ecosystem config with env vars for the hosting service
    cat > /opt/SMEsAgent/hosting-service/ecosystem.config.cjs <<PMEOF
module.exports = {
  apps: [{
    name: 'SMEsAgent-hosting',
    script: 'server.js',
    cwd: '/opt/SMEsAgent/hosting-service',
    env: {
      HOSTING_PUBLIC_IP: '$VPS4_HOST',
      HOSTING_NODE_NAME: 'vps4-hosting-1',
      DEFAULT_DOMAIN: 'apps.SMEsAgent.app',
      HOSTING_PORT: '4000',
      NODE_ENV: 'production',
      HOSTING_DEPLOY_SECRET: '${HOSTING_DEPLOY_SECRET:-}'
    }
  }]
};
PMEOF

    # Start hosting service via PM2
    cd /opt/SMEsAgent/hosting-service
    if pm2 list | grep -q 'SMEsAgent-hosting'; then
      pm2 delete SMEsAgent-hosting 2>/dev/null || true
    fi
    pm2 start ecosystem.config.cjs
    pm2 save --force
    echo 'Hosting service running on VPS4'
  "
  ok "VPS4 hosting service deployed ✓"
}

# ============================================================
# Main
# ============================================================
cd "$ROOT_DIR"
TARGETS=("$@")
[[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=("vps1" "vps2" "vps3")

START_TIME=$(date +%s)
log "Force-deploy started   targets: ${TARGETS[*]}"
echo ""

for target in "${TARGETS[@]}"; do
  case "$target" in
    vps1) deploy_vps1 ;;
    vps2) deploy_vps2 ;;
    vps3) deploy_vps3 ;;
    vps4) deploy_vps4 ;;
    all)  deploy_vps1; deploy_vps2; deploy_vps3; deploy_vps4 ;;
    *)    die "Unknown target '$target'. Use: vps1 | vps2 | vps3 | vps4 | all" ;;
  esac
done

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo ""
ok "════════════════════════════════════════════"
ok "  All targets deployed in ${ELAPSED}s"
ok "  http://SMEsAgent.dev   (DNS → $VPS1_HOST)"
ok "  http://preview.SMEsAgent.app"
ok "  http://gen.SMEsAgent.dev"
ok "  http://agent.SMEsAgent.dev"
[[ -n "$VPS4_HOST" ]] && ok "  http://$VPS4_HOST:4000 (hosting)"
ok "════════════════════════════════════════════"