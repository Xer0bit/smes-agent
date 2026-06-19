# VPS2 Claude Dev + Prod Environment

This phase sets VPS2 as a combined code editing and deployment host with separate development and production directories.

## Provisioned layout on VPS2

- /srv/ecomgear/development/ecomgear-main
- /srv/ecomgear/production/ecomgear-main
- /srv/ecomgear/bin/claude-dev
- /srv/ecomgear/bin/claude-prod
- /root/workspaces/ecomgear-dev (symlink)
- /root/workspaces/ecomgear-prod (symlink)

## Claude Code CLI

Installed globally on VPS2:

- claude --version

Launchers:

- /srv/ecomgear/bin/claude-dev
- /srv/ecomgear/bin/claude-prod

## Sync code from local machine

Use the helper script:

```bash
chmod +x scripts/sync-vps2-workspaces.sh
VPS2_PASS='your-password' ./scripts/sync-vps2-workspaces.sh
```

Default behavior syncs development only and keeps `.git` metadata on VPS2 development workspace so promotions are commit-based.

If you need to hard-mirror production too:

```bash
VPS2_PASS='your-password' ./scripts/sync-vps2-workspaces.sh --sync-prod
```

Preferred with SSH key:

```bash
VPS2_KEY_PATH=~/.ssh/vps2_ed25519 ./scripts/sync-vps2-workspaces.sh
```

## Editor access

Current hardened policy:

- Public 72.62.126.99:8443 is blocked.
- Tailnet IP 100.74.190.28:8443 is allowed.

Open from local machine connected to Tailscale:

- http://100.74.190.28:8443

Fallback via tunnel:

```bash
ssh root@100.74.190.28 -L 8443:127.0.0.1:8443
```

Then open:

- http://127.0.0.1:8443

## Production workflow suggestion

1. Edit and test in /srv/ecomgear/development/ecomgear-main.
2. Promote by commit using the Git-based promotion script.
3. Run deployment scripts from production directory only.

## Git-based promote flow with rollback snapshots

Promotion script:

```bash
chmod +x scripts/vps2-promote-dev-to-prod.sh
VPS2_PASS='your-password' ./scripts/vps2-promote-dev-to-prod.sh
```

Behavior:

1. Validates development workspace is a Git repo.
2. Validates clean working tree (unless `--allow-dirty-dev` is set).
3. Creates snapshot: `/srv/ecomgear/backups/production/prod-<timestamp>-<sha>.tar.gz`.
4. Resets production workspace to the exact promoted commit.
5. Writes metadata to `/srv/ecomgear/backups/production/LAST_PROMOTION.txt`.

Rollback script:

```bash
chmod +x scripts/vps2-rollback-prod.sh
VPS2_PASS='your-password' ./scripts/vps2-rollback-prod.sh --latest
```

Or restore a specific snapshot:

```bash
VPS2_PASS='your-password' ./scripts/vps2-rollback-prod.sh --snapshot /srv/ecomgear/backups/production/prod-YYYYmmdd-HHMMSS-<sha>.tar.gz
```

## Security reminders

- Rotate all exposed credentials and API keys immediately.
- Migrate from password SSH to key-based SSH for VPS2.
- Keep editor bound to tailnet-only access.
