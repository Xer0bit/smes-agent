#!/bin/bash
# =============================================================================
# Task 2.1 smoke test   run against the NEW gen-server host (VPS1) BEFORE any
# DNS cutover. Confirms the migrated instance is actually healthy end to end,
# not just "the process started."
#
# IMPORTANT: port 5001 is NOT exposed externally on VPS3 today (ufw only
# allows 80/443/22   nginx proxies 5001 internally). Confirmed live 2026-07-21:
# running this against the public IP:5001 hung on every check for exactly the
# curl timeout (10s x N), which looks identical to "server is down" but
# actually means "working as intended, firewalled." Run this ONE of two ways:
#   (a) copied onto the VPS itself, invoked against localhost:
#         scp this script to the box, then: ./smoke-test-gen-migration.sh localhost 5001
#   (b) through an SSH tunnel from your own machine:
#         ssh -L 5001:localhost:5001 root@<vps-ip>   (separate terminal, left open)
#         scripts/smoke-test-gen-migration.sh localhost 5001
#
# Usage:
#   scripts/smoke-test-gen-migration.sh <host> [port]
#
# Exits non-zero on the first failed check   do not proceed with DNS cutover
# if this script fails.
# =============================================================================
set -uo pipefail

HOST="${1:?Usage: $0 host port -- localhost via SSH tunnel or run directly on the VPS, see header comment, port 5001 is not public}"
PORT="${2:-5001}"
BASE="http://${HOST}:${PORT}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; FAILED=1; }
info() { echo -e "${YELLOW}▶${NC} $*"; }

FAILED=0

info "Target: $BASE"

# ── 1. Basic health ───────────────────────────────────────────────────────
info "Checking /health..."
HEALTH_CODE=$(curl -s -o /tmp/smoke_health.json -w "%{http_code}" -m 10 "$BASE/health" 2>&1)
if [ "$HEALTH_CODE" = "200" ]; then
    pass "/health returned 200"
else
    fail "/health returned $HEALTH_CODE (expected 200)"
fi

# ── 2. LLM provider health (added this session   real per-provider status) ──
info "Checking /api/v1/ai/health..."
AI_HEALTH=$(curl -s -m 10 "$BASE/api/v1/ai/health" 2>&1)
ALL_OK=$(echo "$AI_HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('allOk', False))" 2>/dev/null || echo "PARSE_ERROR")
if [ "$ALL_OK" = "True" ]; then
    pass "All LLM providers healthy"
else
    fail "Provider health check failed or not all providers OK: $AI_HEALTH"
fi

# ── 3. Latency sanity check (the whole point of this migration) ────────────
info "Measuring /health round-trip latency (5 samples)..."
TOTAL=0
for i in 1 2 3 4 5; do
    T=$(curl -s -o /dev/null -w "%{time_total}" -m 10 "$BASE/health" 2>&1)
    echo "  sample $i: ${T}s"
    TOTAL=$(echo "$TOTAL + $T" | bc)
done
AVG=$(echo "scale=3; $TOTAL / 5" | bc)
echo "  average: ${AVG}s"
if (( $(echo "$AVG < 1.0" | bc -l) )); then
    pass "Average latency ${AVG}s (under 1s)"
else
    fail "Average latency ${AVG}s   higher than expected, investigate before cutover"
fi

# ── 4. Real end-to-end generation (the actual point of Task 2.1) ───────────
# Requires a real auth token   this is the ONE check this script can't do
# unattended. Run it manually against a disposable test project:
echo ""
info "MANUAL STEP (not automated   needs a real user JWT):"
echo "  1. Log in to the app pointed at $BASE (temporarily, via VITE_GEN_SERVER_URL override)."
echo "  2. Create or open a throwaway test project."
echo "  3. Send one real prompt (e.g. 'add a footer with a copyright line')."
echo "  4. Confirm: agent responds, a file actually gets written, preview updates."
echo "  5. Check this host's logs for the [AgentLoop] step lines   confirm provider=/model= look normal."
echo "  Do NOT proceed to DNS cutover until this manual step has been done once, successfully."

echo ""
if [ "$FAILED" = "1" ]; then
    echo -e "${RED}SMOKE TEST FAILED   do not cut over DNS.${NC}"
    exit 1
else
    echo -e "${GREEN}Automated checks passed.${NC} Complete the manual step above before cutover."
    exit 0
fi
