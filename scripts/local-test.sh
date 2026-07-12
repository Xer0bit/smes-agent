#!/bin/bash
# =============================================================================
# EcomGear — Local Build + Boot Smoke Test
#
# Run this before every ./scripts/deploy.sh. Type-checks and builds each
# service, boots the gen server and preview-service locally, and confirms
# both actually come up healthy — catches the class of bugs that only show
# up at runtime (missing exports, wrong secret names, broken imports) before
# they ever reach production.
#
# Usage:
#   bash scripts/local-test.sh            # full check: build + boot both services
#   bash scripts/local-test.sh --build-only   # skip boot, just typecheck+build
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${YELLOW}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
fail()    { echo -e "${RED}✗ $*${NC}"; }

BUILD_ONLY=false
[[ "${1:-}" == "--build-only" ]] && BUILD_ONLY=true

FAILURES=0
GEN_PID=""
PREVIEW_PID=""

cleanup() {
    [[ -n "$GEN_PID" ]] && kill "$GEN_PID" 2>/dev/null
    [[ -n "$PREVIEW_PID" ]] && kill "$PREVIEW_PID" 2>/dev/null
    wait 2>/dev/null
}
trap cleanup EXIT

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Local Build + Boot Smoke Test      ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. Server: typecheck + build ──────────────────────────────────────────────
info "Type-checking + building server..."
if (cd server && npx tsc --noEmit -p tsconfig.json) 2>&1 | tail -30; then
    success "Server type-check OK"
else
    fail "Server type-check FAILED"
    FAILURES=$((FAILURES+1))
fi
if (cd server && npm run build) 2>&1 | tail -10; then
    success "Server build OK"
else
    fail "Server build FAILED"
    FAILURES=$((FAILURES+1))
fi

# ── 2. Frontend: typecheck + build ────────────────────────────────────────────
info "Type-checking + building frontend..."
if npx tsc --noEmit -p tsconfig.json 2>&1 | tail -30; then
    success "Frontend type-check OK"
else
    fail "Frontend type-check FAILED"
    FAILURES=$((FAILURES+1))
fi
if npm run build 2>&1 | tail -10; then
    success "Frontend build OK"
else
    fail "Frontend build FAILED"
    FAILURES=$((FAILURES+1))
fi

# ── 3. preview-service: syntax check ──────────────────────────────────────────
info "Syntax-checking preview-service..."
if node --check preview-service/server.js; then
    success "preview-service syntax OK"
else
    fail "preview-service syntax FAILED"
    FAILURES=$((FAILURES+1))
fi

if $BUILD_ONLY; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    [[ $FAILURES -eq 0 ]] && success "Build-only check passed" || fail "$FAILURES check(s) failed"
    exit $FAILURES
fi

# ── 4. Boot gen server locally, wait for /health ──────────────────────────────
if [[ ! -f server/.env ]]; then
    fail "server/.env not found — run scripts/dev-setup.sh first. Skipping boot test."
    FAILURES=$((FAILURES+1))
else
    info "Booting gen server (port 5001)..."
    (cd server && node dist/index.js > /tmp/local-test-gen.log 2>&1) &
    GEN_PID=$!
    GEN_OK=0
    for i in $(seq 1 20); do
        if curl -sf http://127.0.0.1:5001/health >/dev/null 2>&1; then
            GEN_OK=1
            break
        fi
        sleep 1
    done
    if [[ $GEN_OK -eq 1 ]]; then
        success "Gen server booted and healthy"
    else
        fail "Gen server did not become healthy within 20s — see /tmp/local-test-gen.log"
        tail -20 /tmp/local-test-gen.log
        FAILURES=$((FAILURES+1))
    fi
fi

# ── 5. Boot preview-service locally, wait for /health ─────────────────────────
info "Booting preview-service (port 3001)..."
(cd preview-service && node --no-deprecation server.js > /tmp/local-test-preview.log 2>&1) &
PREVIEW_PID=$!
PREVIEW_OK=0
for i in $(seq 1 20); do
    if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
        PREVIEW_OK=1
        break
    fi
    sleep 1
done
if [[ $PREVIEW_OK -eq 1 ]]; then
    success "preview-service booted and healthy"
else
    fail "preview-service did not become healthy within 20s — see /tmp/local-test-preview.log"
    tail -20 /tmp/local-test-preview.log
    FAILURES=$((FAILURES+1))
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAILURES -eq 0 ]]; then
    success "All local checks passed — safe to deploy"
else
    fail "$FAILURES check(s) failed — fix before deploying"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit $FAILURES
