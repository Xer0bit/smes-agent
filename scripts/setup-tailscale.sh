#!/usr/bin/env bash
set -euo pipefail

# Installs and configures Tailscale on Ubuntu/Debian.
# Required env:
#   TS_AUTHKEY
# Optional env:
#   TS_HOSTNAME
#   TS_ADVERTISE_TAGS   (example: tag:prod,tag:devhub)
#   TS_ACCEPT_ROUTES    (true/false, default false)

if [[ "$EUID" -ne 0 ]]; then
  echo "[error] Run as root"
  exit 1
fi

: "${TS_AUTHKEY:?Set TS_AUTHKEY before running this script}"

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"
TS_ACCEPT_ROUTES="${TS_ACCEPT_ROUTES:-false}"

UP_ARGS=(--authkey "$TS_AUTHKEY" --hostname "$TS_HOSTNAME" --accept-routes="$TS_ACCEPT_ROUTES")
if [[ -n "${TS_ADVERTISE_TAGS:-}" ]]; then
  UP_ARGS+=(--advertise-tags "$TS_ADVERTISE_TAGS")
fi

tailscale up "${UP_ARGS[@]}"
tailscale status || true

echo "[ok] Tailscale is configured"
echo "[next] Restrict editor/admin access with tailnet ACLs before exposing tooling."
