#!/usr/bin/env bash
set -euo pipefail

# Hardens SSH access on a server to key-based authentication.
# Run as root on the target server after key login is confirmed.
#
# Options:
#   --disable-root-login    Sets PermitRootLogin no (default is prohibit-password)

DISABLE_ROOT_LOGIN=false
if [[ "${1:-}" == "--disable-root-login" ]]; then
  DISABLE_ROOT_LOGIN=true
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "[error] Run as root"
  exit 1
fi

ROOT_KEYS="/root/.ssh/authorized_keys"
if [[ ! -s "$ROOT_KEYS" ]]; then
  echo "[error] No root SSH key found at $ROOT_KEYS"
  echo "[hint] Add at least one SSH public key before disabling password login"
  exit 1
fi

mkdir -p /etc/ssh/sshd_config.d

ROOT_MODE="prohibit-password"
if [[ "$DISABLE_ROOT_LOGIN" == true ]]; then
  ROOT_MODE="no"
fi

cat > /etc/ssh/sshd_config.d/99-SMEsAgent-hardening.conf <<EOF
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin ${ROOT_MODE}
UsePAM yes
EOF

if ! sshd -t; then
  echo "[error] sshd config test failed. Reverting hardening file"
  rm -f /etc/ssh/sshd_config.d/99-SMEsAgent-hardening.conf
  exit 1
fi

if systemctl list-unit-files | grep -q '^sshd\.service'; then
  systemctl restart sshd
else
  systemctl restart ssh
fi

echo "[ok] SSH hardening applied"
echo "[next] Keep your current SSH session open and verify a new key-based login before closing."
