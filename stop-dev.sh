#!/usr/bin/env bash
# =============================================================================
# stop-dev.sh   Stop the LOCAL dev stack started by start-dev.sh
# =============================================================================
# Only touches local dev containers/processes (ecg-preview-dev,
# ecomgear-hosting-dev, the local gen-server/edge-functions PIDs, ports
# 3001/4000/5001/54321). Never touches production PM2 processes
# (ecomgear-preview / ecomgear-gen from ecosystem.config.cjs)   those run on
# separate VPS hosts and are out of scope for this script entirely.
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

stop_pid_file() {
  local label="$1" file="$2"
  if [ -f "$file" ]; then
    local pid
    pid=$(cat "$file")
    if kill "$pid" 2>/dev/null; then
      echo "✓  Stopped $label (pid $pid)"
    fi
    rm -f "$file"
  fi
}

echo "▶  Stopping local dev stack..."

stop_pid_file "agent/gen API server" logs/gen-server.pid
stop_pid_file "hosting service"      logs/hosting-service.pid
stop_pid_file "supabase edge functions" logs/supabase-functions.pid

# Belt-and-suspenders: kill anything still bound to the local-only dev ports.
for port in 4000 5001; do
  pid=$(lsof -t -i:"$port" 2>/dev/null)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "✓  Freed port $port (pid $pid)"
done

echo "▶  Stopping preview service container..."
docker compose -f docker-compose.dev.yml stop preview-service 2>/dev/null || true

echo "▶  Stopping Supabase local stack..."
supabase stop 2>/dev/null || true

echo "✓  Local dev stack stopped. Production is untouched."
