#!/usr/bin/env bash
# =============================================================================
# setup-local-secrets.sh
# Generates a shared PREVIEW_UPDATE_SECRET for local dev and writes it into:
#   - .env.local          (frontend  → VITE_PREVIEW_UPDATE_SECRET)
#   - server/.env         (gen server → PREVIEW_UPDATE_SECRET)
# The preview-service Docker container reads the secret from the host env
# via docker-compose.dev.yml (PREVIEW_UPDATE_SECRET=${PREVIEW_UPDATE_SECRET:-}).
#
# Run once: bash scripts/setup-local-secrets.sh
# Then start normally: ./start-dev.sh && cd server && npm run dev
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Generate secret ───────────────────────────────────────────────────────────
SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
echo "Generated secret: ${SECRET:0:8}…  (full value written to env files)"

# ── Helper: upsert a KEY=VALUE line in a file ─────────────────────────────────
upsert_env() {
    local file="$1" key="$2" value="$3"
    if [ ! -f "$file" ]; then
        echo "  creating $file"
        touch "$file"
    fi
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        # Replace existing line (portable sed)
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
        echo "  updated  $file  →  ${key}=<secret>"
    else
        echo "" >> "$file"
        echo "${key}=${value}" >> "$file"
        echo "  appended $file  →  ${key}=<secret>"
    fi
}

# ── 1. Frontend .env.local ────────────────────────────────────────────────────
upsert_env "$ROOT/.env.local" "VITE_PREVIEW_UPDATE_SECRET" "$SECRET"

# ── 2. Gen server server/.env ─────────────────────────────────────────────────
upsert_env "$ROOT/server/.env" "PREVIEW_UPDATE_SECRET" "$SECRET"

# ── 3. Export for current shell + docker-compose ─────────────────────────────
export PREVIEW_UPDATE_SECRET="$SECRET"

echo ""
echo "Done. To make docker-compose pick up the secret in this shell:"
echo "  export PREVIEW_UPDATE_SECRET=\"$SECRET\""
echo ""
echo "Or add it to your shell profile (~/.zshrc / ~/.bashrc):"
echo "  echo 'export PREVIEW_UPDATE_SECRET=\"$SECRET\"' >> ~/.zshrc"
echo ""
echo "Then run:  ./start-dev.sh"
