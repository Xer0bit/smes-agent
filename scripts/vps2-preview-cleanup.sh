#!/usr/bin/env bash
set -euo pipefail

# Daily cleanup policy for preview project folders on VPS2.
# Keeps recent/active folders and prunes stale ones.

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

PROJECTS_DIR="${PROJECTS_DIR:-/var/www/ecomgear/preview-service/projects}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
KEEP_RECENT_COUNT="${KEEP_RECENT_COUNT:-30}"
PM2_APP_NAME="${PM2_APP_NAME:-ecomgear-preview}"
LOG_FILE="${LOG_FILE:-/var/log/ecomgear-preview-cleanup.log}"
LOCK_FILE="${LOCK_FILE:-/tmp/ecomgear-preview-cleanup.lock}"

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[$(date -Is)] cleanup skipped: another run is active" >> "$LOG_FILE"
    exit 0
  fi
fi

log() {
  echo "[$(date -Is)] $*" >> "$LOG_FILE"
}

if [[ ! -d "$PROJECTS_DIR" ]]; then
  log "projects directory missing: $PROJECTS_DIR"
  exit 1
fi

log "cleanup started retention_days=$RETENTION_DAYS keep_recent=$KEEP_RECENT_COUNT dir=$PROJECTS_DIR"

# Build a set of published project IDs from .slugs.json   these are NEVER deleted.
declare -A published_ids
SLUGS_FILE="$PROJECTS_DIR/.slugs.json"
if [[ -f "$SLUGS_FILE" ]] && command -v python3 >/dev/null 2>&1; then
  while IFS= read -r project_id; do
    [[ -n "$project_id" ]] && published_ids["$project_id"]=1
  done < <(python3 -c "import json,sys; d=json.load(open('$SLUGS_FILE')); [print(v) for v in d.values()]" 2>/dev/null || true)
fi
log "published projects protected from cleanup count=${#published_ids[@]}"

mapfile -t all_dirs < <(find "$PROJECTS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' | sort -nr)
total_count=${#all_dirs[@]}

keep_file=$(mktemp)
clean_file=$(mktemp)
trap 'rm -f "$keep_file" "$clean_file"' EXIT

idx=0
for row in "${all_dirs[@]}"; do
  dir="${row#* }"
  project_id="$(basename "$dir")"
  idx=$((idx + 1))

  # Never delete a published (slug-registered) project regardless of age or rank.
  if [[ -n "${published_ids[$project_id]+x}" ]]; then
    echo "$dir" >> "$keep_file"
    continue
  fi

  if [[ "$idx" -le "$KEEP_RECENT_COUNT" ]]; then
    echo "$dir" >> "$keep_file"
    continue
  fi

  if find "$dir" -maxdepth 0 -mtime -"$RETENTION_DAYS" | grep -q .; then
    echo "$dir" >> "$keep_file"
  else
    echo "$dir" >> "$clean_file"
  fi
done

keep_count=0
if [[ -s "$keep_file" ]]; then
  keep_count=$(wc -l < "$keep_file" | tr -d ' ')
fi

remove_count=0
if [[ -s "$clean_file" ]]; then
  remove_count=$(wc -l < "$clean_file" | tr -d ' ')
fi

log "policy result total=$total_count keep=$keep_count remove=$remove_count"

if [[ "$remove_count" -gt 0 ]]; then
  while IFS= read -r d; do
    [[ -n "$d" ]] || continue
    rm -rf -- "$d"
  done < "$clean_file"
  log "removed stale directories count=$remove_count"
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" --update-env >/dev/null
  sleep 3
  log "pm2 restarted app=$PM2_APP_NAME"
else
  log "pm2 not found; skipped restart"
fi

if command -v curl >/dev/null 2>&1; then
  health_payload=$(curl -sS --max-time 10 http://127.0.0.1:3001/health || true)
  log "post-restart health=$health_payload"
fi

log "cleanup completed"
