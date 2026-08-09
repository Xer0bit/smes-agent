# AI Dev Hub Bootstrap (VPS3 + VPN + Secure Deploy)

This is the initial implementation baseline for your migration to VPS3-centric development with secure remote access.

## What is now implemented in repo

- Key-first deployment guardrails in GitHub Actions:
  - .github/workflows/deploy-vps1-frontend.yml
  - .github/workflows/deploy-vps2-preview.yml
  - .github/workflows/deploy-vps3-agent.yml
- Manual deploy script now supports SSH key auth:
  - scripts/deploy.sh
- PM2 port config is now environment-driven:
  - infrastructure/ecosystem.config.cjs
- New operational scripts:
  - scripts/harden-ssh-auth.sh
  - scripts/setup-tailscale.sh
  - scripts/setup-code-server.sh
  - scripts/bootstrap-vps3-dev-hub.sh
  - scripts/rotate-vps2-preview-port.sh

- Local access guide:
  - docs/vps3-editor-local-access.md

## Required secret changes (GitHub)

Set these secrets/variables for each VPS workflow:

- VPS1_KEY (or VPS1_SSH_KEY / VPS1_PRIVATE_KEY)
- VPS2_KEY (or VPS2_SSH_KEY / VPS2_PRIVATE_KEY)
- VPS3_KEY (or VPS3_SSH_KEY / VPS3_PRIVATE_KEY)

Transition control variable:

- ALLOW_PASSWORD_DEPLOY=false (recommended default)
- Set true only as a temporary migration fallback.

## VPS hardening order (do this per server)

1. Add your public key to /root/.ssh/authorized_keys (or deploy user).
2. Verify SSH key login works in a second terminal.
3. Run:

```bash
sudo bash scripts/harden-ssh-auth.sh
```

4. Re-test SSH key login.
5. Rotate old passwords.

## VPN setup (Tailscale)

Run on VPS3 and VPS2:

```bash
sudo TS_AUTHKEY="tskey-..." TS_HOSTNAME="vps3-devhub" TS_ADVERTISE_TAGS="tag:prod,tag:devhub" bash scripts/setup-tailscale.sh
```

Then apply tailnet ACLs so only approved users/devices can access editor/admin paths.

## One-command VPS3 bootstrap

On VPS3 (as root):

```bash
TS_AUTHKEY="tskey-..." \
CODESERVER_PASSWORD="strong-unique-password" \
TS_HOSTNAME="vps3-devhub" \
TS_ADVERTISE_TAGS="tag:prod,tag:devhub" \
bash scripts/bootstrap-vps3-dev-hub.sh
```

This configures Tailscale, code-server, nginx VPN-only editor route, and SSH hardening in one run.

## code-server setup on VPS3

```bash
sudo CODESERVER_PASSWORD="strong-unique-password" CODESERVER_USER="root" CODESERVER_BIND_ADDR="127.0.0.1:8443" bash scripts/setup-code-server.sh
```

Keep code-server private behind VPN or private reverse proxy only.

## Manual VPS2 preview port rotation

Rotate only when needed:

```bash
./scripts/rotate-vps2-preview-port.sh --new-port 3901
```

Expected behavior:
- Updates VPS2 nginx upstream port.
- Restarts PM2 preview process with PREVIEW_PORT/PORT set.
- Runs local health check on the new port.
- Automatically rolls back on failure.

## Notes

- Existing password-based deploy still works only if ALLOW_PASSWORD_DEPLOY=true in workflows.
- Key-based deploy is now the default expected path.
