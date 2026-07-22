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
START_FRONTEND=0; START_BACKEND=0; START_PREVIEW=0
if [ $# -eq 0 ]; then
    echo ""
    echo "  Which services do you want to start?"
    read -rp "  Frontend (vite, :$FRONTEND_PORT)?        [Y/n] " a; [[ "$a" =~ ^[Nn] ]] || START_FRONTEND=1
    read -rp "  Backend (gen API, :$BACKEND_PORT)?        [Y/n] " b; [[ "$b" =~ ^[Nn] ]] || START_BACKEND=1
    read -rp "  Preview service (:$PREVIEW_PORT)?         [Y/n] " c; [[ "$c" =~ ^[Nn] ]] || START_PREVIEW=1
    echo ""
else
    for arg in "$@"; do
        case "$arg" in
            --all)      START_FRONTEND=1; START_BACKEND=1; START_PREVIEW=1 ;;
            --frontend) START_FRONTEND=1 ;;
            --backend)  START_BACKEND=1 ;;
            --preview)  START_PREVIEW=1 ;;
            *) warn "Unknown flag: $arg (use --all / --frontend / --backend / --preview / --stop)"; exit 1 ;;
        esac
    done
fi

# ── Supabase: only touch it if a service that needs it is being started ─────
if [ "$START_BACKEND" -eq 1 ] || [ "$START_FRONTEND" -eq 1 ]; then
    if port_alive "$SUPABASE_PORT"; then
        success "Supabase already running on :$SUPABASE_PORT"
    else
        info "Starting local Supabase (this can take a minute)..."
        (cd "$ROOT" && supabase start) || { warn "supabase start failed   check docker is running"; exit 1; }
    fi
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
if [ "$START_FRONTEND" -eq 1 ]; then
    free_port "$FRONTEND_PORT" "frontend"
    info "Starting frontend on :$FRONTEND_PORT..."
    (cd "$ROOT" && nohup npx vite --port "$FRONTEND_PORT" > "$LOG_DIR/frontend.log" 2>&1 &)
fi

# ── Backend ───────────────────────────────────────────────────────────────────
if [ "$START_BACKEND" -eq 1 ]; then
    free_port "$BACKEND_PORT" "backend"
    info "Starting backend on :$BACKEND_PORT..."
    # tsx watch, not plain tsx: code edits must hot-reload. A plain-tsx backend
    # kept serving stale agent-loop code after a bug fix landed on disk, and the
    # retry burned $1.34 re-hitting the already-fixed bug (2026-07-21).
    (cd "$ROOT/server" && nohup npx tsx watch src/index.ts > "$LOG_DIR/backend.log" 2>&1 &)
fi

# ── Preview service ───────────────────────────────────────────────────────────
if [ "$START_PREVIEW" -eq 1 ]; then
    free_port "$PREVIEW_PORT" "preview-service"
    info "Starting preview service on :$PREVIEW_PORT..."
    (cd "$ROOT/preview-service" && nohup node --no-deprecation server.js > "$LOG_DIR/preview.log" 2>&1 &)
fi

# ── Wait + report ─────────────────────────────────────────────────────────────
sleep 3
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ "$START_FRONTEND" -eq 1 ] && { port_alive "$FRONTEND_PORT" && success "Frontend → http://localhost:$FRONTEND_PORT" || warn "Frontend did not come up   check logs/frontend.log"; }
[ "$START_BACKEND" -eq 1 ]  && { port_alive "$BACKEND_PORT"  && success "Backend  → http://localhost:$BACKEND_PORT (health: /health)" || warn "Backend did not come up   check logs/backend.log"; }
[ "$START_PREVIEW" -eq 1 ]  && { port_alive "$PREVIEW_PORT"  && success "Preview  → http://localhost:$PREVIEW_PORT" || warn "Preview did not come up   check logs/preview.log"; }
echo ""
echo "  Live logs:  tail -f logs/backend.log | grep --line-buffered AgentLoop"
echo "  Stop all:   scripts/start-dev.sh --stop"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
