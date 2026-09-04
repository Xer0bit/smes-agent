#!/usr/bin/env bash
# =============================================================================
# Single-server bootstrap: everything the 5-VPS layout used to split across
# machines (frontend, api-gateway, preview-service, hosting-service, tenant
# Postgres/PostgREST/functions-runner), on one box.
#
# Prerequisite this script does NOT install: self-hosted Supabase (Kong,
# Auth, Storage, Realtime, its own Postgres) on 127.0.0.1:54321. That's a
# large third-party stack with its own official install path —
# https://supabase.com/docs/guides/self-hosting/docker — provision it first,
# separately. Everything below assumes it's already running.
#
# Usage:
#   sudo ./scripts/setup-single-server.sh
#
# Idempotent-ish: safe to re-run, skips what's already installed.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.deploy.env}"
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

[ -f "$ENV_FILE" ] || { echo -e "${RED}Missing $ENV_FILE${NC} (set ENV_FILE=... or create .deploy.env first)"; exit 1; }
set -a && source "$ENV_FILE" && set +a

echo "[1/8] System packages, Docker, Caddy, Node 20, PM2..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
command -v pm2 &>/dev/null || npm install -g pm2

echo "[2/8] Directories..."
mkdir -p /var/www/ecomgear/dist /var/www/ecomgear/sites /var/lib/ecomgear/tenants /etc/caddy/sites "$ROOT/logs"

echo "[3/8] Build web-client..."
(cd "$ROOT" && npm ci && npm run build && rm -rf /var/www/ecomgear/dist && cp -r dist /var/www/ecomgear/dist)

echo "[4/8] Build + install app services..."
(cd "$ROOT/apps/api-gateway" && npm ci && npm run build)
(cd "$ROOT/apps/preview-service" && npm ci --omit=dev)
(cd "$ROOT/apps/hosting-service" && npm ci --omit=dev)
(cd "$ROOT/apps/tenant-functions-runner" && npm ci --omit=dev)

echo "[5/8] Provision ecg_tenants database on the box's own Postgres..."
: "${TENANT_DB_SUPERUSER_PASSWORD:?set in $ENV_FILE}"
: "${TENANT_DB_JWT_SECRET:?set in $ENV_FILE}"
PGHOST="${TENANT_DB_HOST:-127.0.0.1}"
PGPORT="${TENANT_DB_PORT:-5432}"
PGSUPERUSER="${SUPABASE_DB_SUPERUSER:-postgres}"
psql_root() { PGPASSWORD="${SUPABASE_DB_PASSWORD:?set SUPABASE_DB_PASSWORD in $ENV_FILE   the self-hosted Supabase Postgres admin password}" \
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_root <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecg_provisioner') THEN
    CREATE ROLE ecg_provisioner LOGIN SUPERUSER PASSWORD '$TENANT_DB_SUPERUSER_PASSWORD';
  ELSE
    ALTER ROLE ecg_provisioner WITH LOGIN SUPERUSER PASSWORD '$TENANT_DB_SUPERUSER_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecg_nobody') THEN
    CREATE ROLE ecg_nobody NOLOGIN;
  END IF;
END \$\$;
SQL
psql_root -tAc "SELECT 1 FROM pg_database WHERE datname = 'ecg_tenants'" | grep -aq 1 || psql_root -c "CREATE DATABASE ecg_tenants OWNER ecg_provisioner"
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGSUPERUSER" -d ecg_tenants -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO ecg_nobody;
CREATE TABLE IF NOT EXISTS public.ecg_tenant_registry (
  id           text PRIMARY KEY,
  schema_name  text NOT NULL UNIQUE,
  anon_role    text NOT NULL,
  service_role text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER ROLE ecg_provisioner SET pgrst.db_schemas = 'public';
ALTER ROLE ecg_provisioner SET pgrst.db_anon_role = 'ecg_nobody';
SQL

echo "[6/8] Start tenant-postgrest via Docker Compose..."
export TENANT_DB_URI="postgres://ecg_provisioner:${TENANT_DB_SUPERUSER_PASSWORD}@host.docker.internal:${PGPORT}/ecg_tenants"
export TENANT_DB_JWT_SECRET
docker compose -f "$ROOT/infrastructure/single-server/docker-compose.yml" up -d

echo "[7/8] Install Caddy + nginx configs, reload..."
cp "$ROOT/infrastructure/single-server/Caddyfile" /etc/caddy/Caddyfile
if ! command -v nginx &>/dev/null; then
  apt-get install -y -qq nginx
fi
cp "$ROOT/infrastructure/single-server/nginx-platform.conf" /etc/nginx/sites-available/ecg-platform.conf
ln -sf /etc/nginx/sites-available/ecg-platform.conf /etc/nginx/sites-enabled/ecg-platform.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx && systemctl reload nginx
systemctl enable --now caddy && systemctl reload caddy

echo "[8/8] Start app services via PM2..."
pm2 delete ecg-api ecg-preview ecg-hosting ecg-tenant-functions 2>/dev/null || true
pm2 start "$ROOT/infrastructure/single-server/ecosystem.config.cjs"
pm2 save

echo ""
echo -e "${GREEN}Single-server setup complete.${NC}"
echo "Health checks:"
echo "  curl -s http://127.0.0.1:5001/health"
echo "  curl -s http://127.0.0.1:3001/health"
echo "  curl -s http://127.0.0.1:4000/health"
echo "  curl -s http://127.0.0.1:3000/"
echo "pm2 status / pm2 logs <name> for process state."
