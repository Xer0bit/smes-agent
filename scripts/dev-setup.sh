#!/bin/bash
# =============================================================================
# EcomGear — Local Development Setup
#
# Wires up a local dev environment that uses production services:
#   Supabase  → https://api.ecomgear.dev    (real DB, auth, edge functions)
#   Tenant DB → https://cloud.ecomgear.app  (real isolated per-project DBs)
#   Preview   → https://preview.ecomgear.app (real preview service)
#   Gen API   → http://localhost:5001        (run locally for debugging)
#
# Usage:
#   bash scripts/dev-setup.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${YELLOW}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
error()   { echo -e "${RED}✗ $*${NC}"; exit 1; }

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   EcomGear Dev Setup                 ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. Check prerequisites ────────────────────────────────────────────────────
info "Checking prerequisites..."
command -v node  >/dev/null 2>&1 || error "node not found — install Node.js 20+"
command -v npm   >/dev/null 2>&1 || error "npm not found"
NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[ "$NODE_VER" -ge 20 ] || error "Node.js 20+ required (found v$(node -v))"
success "Node.js $(node -v)"

# ── 2. Create .env.local from .env.development ────────────────────────────────
if [ ! -f "$ROOT/.env.local" ]; then
    info "Creating .env.local from .env.development template..."
    cp "$ROOT/.env.development" "$ROOT/.env.local"
    success ".env.local created — open it and fill in the blank values"
else
    success ".env.local already exists"
fi

# ── 3. Create server/.env from .env.local if not present ─────────────────────
if [ ! -f "$ROOT/server/.env" ]; then
    info "Creating server/.env..."
    # Extract server-relevant vars from .env.local (non-VITE_ lines)
    grep -v '^VITE_\|^#\|^$' "$ROOT/.env.local" > "$ROOT/server/.env" 2>/dev/null || true
    success "server/.env created"
else
    success "server/.env already exists"
fi

# ── 4. Install frontend dependencies ─────────────────────────────────────────
info "Installing frontend dependencies..."
cd "$ROOT" && npm install --prefer-offline 2>/dev/null | tail -2
success "Frontend dependencies installed"

# ── 5. Install server dependencies ───────────────────────────────────────────
info "Installing server dependencies..."
cd "$ROOT/server" && npm install --prefer-offline 2>/dev/null | tail -2
success "Server dependencies installed"

# ── 6. Validate required env vars are filled ─────────────────────────────────
info "Checking required values in server/.env..."
MISSING=()
for VAR in SUPABASE_SERVICE_ROLE_KEY GEMINI_API_KEY TENANT_DB_SUPERUSER_PASSWORD TENANT_DB_JWT_SECRET; do
    VAL=$(grep "^${VAR}=" "$ROOT/server/.env" 2>/dev/null | cut -d= -f2-)
    [ -z "$VAL" ] && MISSING+=("$VAR")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}  Missing values in server/.env:${NC}"
    for v in "${MISSING[@]}"; do echo "    - $v"; done
    echo ""
    echo "  Copy values from .deploy.env (do NOT commit them)."
    echo ""
else
    success "All required env vars present"
fi

# ── 7. Build server TypeScript ────────────────────────────────────────────────
info "Building server..."
cd "$ROOT/server" && npm run build 2>&1 | tail -3
success "Server built"

# ── 8. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
success "Dev environment ready!"
echo ""
echo "  Start gen server:   cd server && npm run dev"
echo "  Start frontend:     npm run dev              (new terminal)"
echo ""
echo "  Frontend → http://localhost:8080"
echo "  Gen API  → http://localhost:5001"
echo "  Supabase → https://api.ecomgear.dev (production)"
echo "  Tenant DB→ https://cloud.ecomgear.app (production)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
