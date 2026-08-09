#!/bin/bash
# =============================================================================
# EcomGear   Start local dev stack
#
# Clears whatever's squatting on our dev ports, then starts the services you
# pick (or all of them, or interactively). Logs go to logs/*.log (gitignored)
# so `tail -f` / `grep` work the same for you and for an assistant helping you
# debug. Existing services already running and healthy are left alone   this
# is idempotent, not a hard reset.
#
# Usage:
#   scripts/start-dev.sh                # ask interactively
#   scripts/start-dev.sh --all          # frontend + backend + preview
#   scripts/start-dev.sh --frontend --backend
#   scripts/start-dev.sh --prod-backend # frontend only, pointed at the real
#                                       # production backend (api.ecomgear.dev /
#                                       # gen.ecomgear.dev / preview.ecomgear.app)
#                                       # -- no local Supabase/backend/preview
#                                       # needed. Use this when you're only
#                                       # touching frontend code. Writes REAL
#                                       # production data -- be careful.
#   scripts/start-dev.sh --stop         # stop everything this script started
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

FRONTEND_PORT=8080
BACKEND_PORT=5001
PREVIEW_PORT=3001
SUPABASE_PORT=54321

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${YELLOW}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${RED}✗ $*${NC}"; }

port_pid()   { fuser "$1"/tcp 2>/dev/null | tr -d ' '; }
port_alive() { [ -n "$(port_pid "$1")" ]; }

# Kill whatever owns a port, unless --keep-<name> was passed for it.
free_port() {
    local port="$1" label="$2"
    local pid; pid="$(port_pid "$port")"
    if [ -n "$pid" ]; then
        info "Port $port ($label) is in use by pid $pid   stopping it"
        kill "$pid" 2>/dev/null
        for _ in 1 2 3 4 5; do port_alive "$port" || break; sleep 1; done
        port_alive "$port" && kill -9 "$pid" 2>/dev/null
    fi
}

# ── --stop: kill our three app ports and exit ────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
    free_port "$FRONTEND_PORT" "frontend"
    free_port "$BACKEND_PORT"  "backend"
    free_port "$PREVIEW_PORT"  "preview-service"
    success "Stopped."
    exit 0
fi

# ── Parse flags (any combination), or ask interactively if none given ───────
START_FRONTEND=0; START_BACKEND=0; START_PREVIEW=0; PROD_BACKEND=0
if [ $# -eq 0 ]; then
    echo ""
    echo "  Which services do you want to start?"
    read -rp "  Frontend only, against PRODUCTION backend? [y/N] " p
    if [[ "$p" =~ ^[Yy] ]]; then
        START_FRONTEND=1; PROD_BACKEND=1
    else
        read -rp "  Frontend (vite, :$FRONTEND_PORT)?        [Y/n] " a; [[ "$a" =~ ^[Nn] ]] || START_FRONTEND=1
        read -rp "  Backend (gen API, :$BACKEND_PORT)?        [Y/n] " b; [[ "$b" =~ ^[Nn] ]] || START_BACKEND=1
        read -rp "  Preview service (:$PREVIEW_PORT)?         [Y/n] " c; [[ "$c" =~ ^[Nn] ]] || START_PREVIEW=1
    fi
    echo ""
else
    for arg in "$@"; do
        case "$arg" in
            --all)          START_FRONTEND=1; START_BACKEND=1; START_PREVIEW=1 ;;
            --frontend)     START_FRONTEND=1 ;;
            --backend)      START_BACKEND=1 ;;
            --preview)      START_PREVIEW=1 ;;
            --prod-backend) START_FRONTEND=1; PROD_BACKEND=1 ;;
            *) warn "Unknown flag: $arg (use --all / --frontend / --backend / --preview / --prod-backend / --stop)"; exit 1 ;;
        esac
    done
fi

if [ "$PROD_BACKEND" -eq 1 ] && { [ "$START_BACKEND" -eq 1 ] || [ "$START_PREVIEW" -eq 1 ]; }; then
    warn "--prod-backend can't be combined with --backend/--preview (there's no local backend to point at production)"; exit 1
fi

# ── Supabase: only touch it if a LOCAL service that needs it is being started ─
# --prod-backend skips this entirely -- the frontend talks straight to
# api.ecomgear.dev, no local Supabase required at all.
if { [ "$START_BACKEND" -eq 1 ] || [ "$START_FRONTEND" -eq 1 ]; } && [ "$PROD_BACKEND" -eq 0 ]; then
    if port_alive "$SUPABASE_PORT"; then
        success "Supabase already running on :$SUPABASE_PORT"
    else
        # `supabase start` sometimes reports "already running" (stale project
        # lock) while the actual DB container has exited/crashed underneath it
        # -- confirmed live: supabase_db_* showed "Exited (137)" for days while
        # every start attempt just printed "already running" and did nothing.
        # Detect that specific mismatch and force a clean restart once instead
        # of leaving the user stuck on a lie.
        DB_CONTAINER="$(docker ps -a --filter 'name=supabase_db_' --format '{{.Names}}' | head -1)"
        if [ -n "$DB_CONTAINER" ] && ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
            warn "Supabase DB container ($DB_CONTAINER) exited but the CLI thinks it's running -- restarting cleanly"
            (cd "$ROOT" && supabase stop >/dev/null 2>&1)
        fi
        info "Starting local Supabase (this can take a minute)..."
        (cd "$ROOT" && supabase start) || { warn "supabase start failed   check docker is running (docker ps -a | grep supabase)"; exit 1; }
    fi
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
if [ "$START_FRONTEND" -eq 1 ]; then
    free_port "$FRONTEND_PORT" "frontend"
    if [ "$PROD_BACKEND" -eq 1 ]; then
        warn "PRODUCTION MODE: this frontend will read/write REAL production data (api.ecomgear.dev, gen.ecomgear.dev, preview.ecomgear.app). No local backend/Supabase/preview will start."
        info "Starting frontend on :$FRONTEND_PORT (--mode production)..."
        # --mode production makes Vite load .env.production (already committed
        # with the real prod URLs) instead of .env/.env.local, and flips
        # import.meta.env.PROD so every VITE_*_URL fallback in
        # apps/web-client/config/external-api.ts resolves to the production host too --
        # same mechanism a real `vite build` uses, just kept in dev/serve mode.
        (cd "$ROOT" && nohup npx vite --port "$FRONTEND_PORT" --mode production > "$LOG_DIR/frontend.log" 2>&1 &)
    else
        info "Starting frontend on :$FRONTEND_PORT..."
        # Force local Supabase for this process only (never written to disk).
        # Root cause of a real incident (2026-08-04): .env.local and
        # .env.development both commit VITE_SUPABASE_URL=https://api.ecomgear.dev
        # (production) -- Vite's precedence (.env.local > .env.[mode] > .env)
        # means plain `vite`/`npm run dev` ALWAYS resolved to production for
        # auth/DB, even though the local backend/agent-loop writes projects to
        # local Supabase. A tester's agent run wrote real files to the local
        # project, but the browser's post-generation save (revisionService.
        # createRevision) went to production, where that project_id doesn't
        # exist -- RLS silently rejected the insert, caught and logged to the
        # browser console only. The user saw "no code inserted" despite a
        # real, paid run. These are the same anon key/URL every `supabase
        # start` uses locally -- not a secret, safe to inline here.
        VITE_SUPABASE_URL="http://127.0.0.1:$SUPABASE_PORT" \
        VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
        VITE_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
        nohup bash -c "cd '$ROOT' && npx vite --port '$FRONTEND_PORT'" > "$LOG_DIR/frontend.log" 2>&1 &
    fi
fi

# ── Backend ───────────────────────────────────────────────────────────────────
if [ "$START_BACKEND" -eq 1 ]; then
    free_port "$BACKEND_PORT" "backend"
    info "Starting backend on :$BACKEND_PORT..."
    # tsx watch, not plain tsx: code edits must hot-reload. A plain-tsx backend
    # kept serving stale agent-loop code after a bug fix landed on disk, and the
    # retry burned $1.34 re-hitting the already-fixed bug (2026-07-21).
    (cd "$ROOT/apps/api-gateway" && nohup npx tsx watch src/index.ts > "$LOG_DIR/backend.log" 2>&1 &)
fi

# ── Preview service ───────────────────────────────────────────────────────────
if [ "$START_PREVIEW" -eq 1 ]; then
    free_port "$PREVIEW_PORT" "preview-service"
    info "Starting preview service on :$PREVIEW_PORT..."
    (cd "$ROOT/apps/preview-service" && nohup node --no-deprecation server.js > "$LOG_DIR/preview.log" 2>&1 &)
fi

# ── Wait + report ─────────────────────────────────────────────────────────────
sleep 3
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ "$START_FRONTEND" -eq 1 ] && { port_alive "$FRONTEND_PORT" && success "Frontend → http://localhost:$FRONTEND_PORT" || warn "Frontend did not come up   check logs/frontend.log"; }
[ "$START_BACKEND" -eq 1 ]  && { port_alive "$BACKEND_PORT"  && success "Backend  → http://localhost:$BACKEND_PORT (health: /health)" || warn "Backend did not come up   check logs/backend.log"; }
[ "$START_PREVIEW" -eq 1 ]  && { port_alive "$PREVIEW_PORT"  && success "Preview  → http://localhost:$PREVIEW_PORT" || warn "Preview did not come up   check logs/preview.log"; }

# ── Sanity check: frontend and backend must agree on which Supabase they talk to ──
# This is the actual defense against the 2026-08-04 incident: the agent loop
# writes projects to whatever Supabase the BACKEND resolves, but the browser's
# post-generation save (revisionService.createRevision) goes wherever the
# FRONTEND resolves. If those two processes disagree, every agent-generated
# file "vanishes" (RLS silently rejects the save against a project_id that
# doesn't exist in the other Supabase) with nothing but a browser-console
# error -- see the toast added in Editor.tsx for the user-facing half of this.
if [ "$START_FRONTEND" -eq 1 ] && [ "$START_BACKEND" -eq 1 ] && [ "$PROD_BACKEND" -eq 0 ]; then
    FE_PID="$(port_pid "$FRONTEND_PORT")"
    BE_PID="$(port_pid "$BACKEND_PORT")"
    FE_URL="$([ -n "$FE_PID" ] && tr '\0' '\n' < "/proc/$FE_PID/environ" 2>/dev/null | sed -n 's/^VITE_SUPABASE_URL=//p')"
    BE_URL="$([ -n "$BE_PID" ] && tr '\0' '\n' < "/proc/$BE_PID/environ" 2>/dev/null | sed -n 's/^SUPABASE_URL=//p')"
    if [ -n "$FE_URL" ] && [ -n "$BE_URL" ] && [ "$FE_URL" != "$BE_URL" ]; then
        warn "Frontend Supabase ($FE_URL) != Backend Supabase ($BE_URL) -- agent-generated files WILL silently fail to save. Check apps/api-gateway/.env's SUPABASE_URL."
    fi
fi
echo ""
echo "  Live logs:  tail -f logs/backend.log | grep --line-buffered AgentLoop"
echo "  Stop all:   scripts/start-dev.sh --stop"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
