#!/usr/bin/env bash
# Local eCG Cloud: a tenant database next to the local Supabase stack.
#
# Production keeps tenant schemas on VPS5 (ecg_tenants, PostgREST behind
# cloud-smes.xer0bit.com/<schema>, a reload hook on :9999). A dev machine cannot
# use that host (pg_hba rejects it, and it should), so this script gives the
# local backend the same shape on the local Docker Postgres:
#
#   - database  ecg_tenants  on the local Supabase Postgres (:54322)
#   - role      ecg_provisioner (superuser, LOGIN) used by provisioning AND PostgREST
#   - PostgREST container  ecg_tenant_postgrest  on host :3010, in-database config
#   - scripts/local-tenant-api.mjs  on :54330  = cloud-smes.xer0bit.com/<schema> + /reload
#
# Then it rewrites the TENANT_DB_* lines in apps/api-gateway/.env to point at
# all of that, keeping the previous values as "# prod:" comments and a backup.
#
# Idempotent: run it again after `supabase stop && supabase start`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/apps/api-gateway/.env"
DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep -aE '^supabase_db_' | head -1 || true)"
[ -n "$DB_CONTAINER" ] || { echo "local Supabase is not running (no supabase_db_* container); run 'supabase start' first"; exit 1; }
NETWORK="$(docker inspect "$DB_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
PGRST_IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -aE 'supabase/postgrest' | sort -V | tail -1)"
[ -n "$PGRST_IMAGE" ] || PGRST_IMAGE="postgrest/postgrest:v12.2.3"

# `|| true`: an absent key is normal here and must not trip `set -e` through the substitution.
getenv() { { grep -aE "^$1=" "$ENV" 2>/dev/null || true; } | head -1 | cut -d= -f2- | sed -E 's/^"|"$//g'; }
JWT_SECRET="$(getenv TENANT_DB_JWT_SECRET)"
[ -n "$JWT_SECRET" ] || { echo "TENANT_DB_JWT_SECRET missing in $ENV"; exit 1; }
# Reuse a password already set for the local host, else mint one.
PROV_PASS="$(getenv TENANT_DB_SUPERUSER_PASSWORD_LOCAL)"
[ -n "$PROV_PASS" ] || PROV_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
RELOAD_SECRET="$(getenv TENANT_DB_RELOAD_SECRET_LOCAL)"
[ -n "$RELOAD_SECRET" ] || RELOAD_SECRET="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"

# supabase_admin is the real superuser on a Supabase Postgres; `postgres` there cannot create SUPERUSER roles.
# Over TCP so password auth applies; the Supabase CLI's local password is "postgres" (override with SUPABASE_DB_PASSWORD).
psql_root() { docker exec -i -e PGPASSWORD="${SUPABASE_DB_PASSWORD:-postgres}" "$DB_CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "▶ database + roles on $DB_CONTAINER"
psql_root <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecg_provisioner') THEN
    CREATE ROLE ecg_provisioner LOGIN SUPERUSER PASSWORD '$PROV_PASS';
  ELSE
    ALTER ROLE ecg_provisioner WITH LOGIN SUPERUSER PASSWORD '$PROV_PASS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecg_nobody') THEN
    CREATE ROLE ecg_nobody NOLOGIN;
  END IF;
END \$\$;
SQL
psql_root -tAc "SELECT 1 FROM pg_database WHERE datname = 'ecg_tenants'" | grep -aq 1 || psql_root -c "CREATE DATABASE ecg_tenants OWNER ecg_provisioner"
psql_root -d ecg_tenants <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO ecg_nobody;
-- Provisioning registers every schema here (VPS5 has the same table); the
-- functions runner and the invoke route resolve a tenant JWT through it.
CREATE TABLE IF NOT EXISTS public.ecg_tenant_registry (
  id           text PRIMARY KEY,
  schema_name  text NOT NULL UNIQUE,
  anon_role    text NOT NULL,
  service_role text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- id is the schema name (database.service.ts inserts [schema, schema, ...]); repair an earlier uuid column.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ecg_tenant_registry' AND column_name = 'id' AND data_type = 'uuid') THEN
    ALTER TABLE public.ecg_tenant_registry ALTER COLUMN id TYPE text USING id::text;
  END IF;
END $$;
-- PostgREST reads these from its connecting role (db-config = true).
ALTER ROLE ecg_provisioner SET pgrst.db_schemas = 'public';
ALTER ROLE ecg_provisioner SET pgrst.db_anon_role = 'ecg_nobody';
SQL

echo "▶ PostgREST container ecg_tenant_postgrest ($PGRST_IMAGE) on :3010"
docker rm -f ecg_tenant_postgrest >/dev/null 2>&1 || true
docker run -d --name ecg_tenant_postgrest --network "$NETWORK" -p 127.0.0.1:3010:3000 \
  -e PGRST_DB_URI="postgres://ecg_provisioner:$PROV_PASS@$DB_CONTAINER:5432/ecg_tenants" \
  -e PGRST_DB_SCHEMAS="public" \
  -e PGRST_DB_ANON_ROLE="ecg_nobody" \
  -e PGRST_DB_CONFIG="true" \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_PORT="3000" \
  "$PGRST_IMAGE" >/dev/null

echo "▶ apps/api-gateway/.env → local tenant settings (backup: .env.bak.$(date +%s))"
cp "$ENV" "$ENV.bak.$(date +%s)"
python3 - "$ENV" "$PROV_PASS" "$RELOAD_SECRET" <<'PY'
import sys, re
path, prov_pass, reload_secret = sys.argv[1:4]
local = {
    'TENANT_DB_HOST': '127.0.0.1', 'TENANT_DB_PORT': '54322', 'TENANT_DB_SUPERUSER': 'ecg_provisioner',
    'TENANT_DB_SUPERUSER_PASSWORD': prov_pass, 'TENANT_DB_NAME': 'ecg_tenants', 'TENANT_DB_SSL': 'false',
    'TENANT_DB_API_URL': 'http://127.0.0.1:54330', 'TENANT_DB_RELOAD_URL': 'http://127.0.0.1:54330/reload',
    'TENANT_DB_RELOAD_SECRET': reload_secret,
}
lines = open(path).read().split('\n'); out = []; seen = set()
for line in lines:
    m = re.match(r'^(TENANT_DB_[A-Z_]+)=(.*)$', line)
    if m and m.group(1) in local:
        key = m.group(1)
        if key not in seen:
            if m.group(2).strip('"') != local[key] and not m.group(2).startswith('# '):
                out.append(f'# prod: {line}')
            out.append(f'{key}={local[key]}'); seen.add(key)
        continue
    out.append(line)
for key, val in local.items():
    if key not in seen: out.append(f'{key}={val}')
if 'TENANT_DB_SUPERUSER_PASSWORD_LOCAL' not in open(path).read(): out.append(f'TENANT_DB_SUPERUSER_PASSWORD_LOCAL={prov_pass}')
if 'TENANT_DB_RELOAD_SECRET_LOCAL' not in open(path).read(): out.append(f'TENANT_DB_RELOAD_SECRET_LOCAL={reload_secret}')
open(path, 'w').write('\n'.join(out))
PY

echo "▶ tenant API proxy on :54330"
P="$(fuser 54330/tcp 2>/dev/null | tr -d ' ' || true)"; [ -n "$P" ] && kill "$P" 2>/dev/null || true
mkdir -p "$ROOT/logs"
# Must match start-dev.sh's BACKEND_PORT: the proxy's own default is :5001, which
# on this machine is the sibling ecomgear-main backend, not ours.
BACKEND_PORT="${BACKEND_PORT:-5002}"
(cd "$ROOT" && TENANT_DB_RELOAD_SECRET="$RELOAD_SECRET" TENANT_DB_CONTAINER="$DB_CONTAINER" TENANT_FUNCTIONS_URL="http://localhost:$BACKEND_PORT/api/v1/functions" setsid nohup node scripts/local-tenant-api.mjs > "$ROOT/logs/tenant-api.log" 2>&1 &)
sleep 1
curl -s -o /dev/null -w "   proxy health: %{http_code}\n" http://127.0.0.1:54330/health || true
curl -s -o /dev/null -w "   postgrest:    %{http_code}\n" http://127.0.0.1:3010/ || true

echo
echo "Local tenant stack ready. Restart the backend so it reads the new .env:"
echo "   bash scripts/start-dev.sh --backend"
echo "Then:  npm run cloud:check -- --provision --with-function"
