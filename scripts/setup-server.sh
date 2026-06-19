#!/bin/bash
# =============================================================================
# EcomGear Server Setup — Entrypoint
# Delegates to the appropriate VPS-specific script.
#
#   Usage: bash setup-server.sh [vps1|vps2|vps3]
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [[ -z "$TARGET" ]]; then
    echo -e "${YELLOW}Usage:${NC} bash setup-server.sh [vps1|vps2|vps3]"
    echo ""
    echo "  vps1  → Setup Frontend + Supabase Edge (156.67.218.75)"
    echo "  vps2  → Setup Preview Service           (72.62.126.99)"
    echo "  vps3  → Setup LLM / Agent Runner        (3.148.126.20)"
    echo ""
    exit 1
fi

case "$TARGET" in
    vps1) bash "$SCRIPT_DIR/setup-vps1.sh" ;;
    vps2) bash "$SCRIPT_DIR/setup-vps2.sh" ;;
    vps3) bash "$SCRIPT_DIR/setup-vps3.sh" ;;
    *)
        echo -e "${RED}Unknown target:${NC} $TARGET"
        echo "Valid targets: vps1  vps2  vps3"
        exit 1
        ;;
esac


