# VPS3 Editor Access from Local System

This guide explains how to connect your local machine to the VPS3 editor (code-server) over Tailscale + nginx VPN-only routing.

## 1. Run bootstrap on VPS3

From VPS3 (as root, inside repo):

```bash
TS_AUTHKEY="tskey-..." \
CODESERVER_PASSWORD="your-strong-password" \
TS_HOSTNAME="vps3-devhub" \
TS_ADVERTISE_TAGS="tag:prod,tag:devhub" \
bash scripts/bootstrap-vps3-dev-hub.sh
```

What this does:
- Installs/configures Tailscale.
- Installs/configures code-server on localhost:8443 with base path /editor.
- Applies nginx config with VPN-only /editor route.
- Enables key-only SSH auth.

## 2. Install Tailscale on your local machine

Install Tailscale client and sign in to the same tailnet used by VPS3.

- Linux:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

- macOS/Windows:
Use Tailscale desktop app and sign in.

## 3. Verify tailnet connectivity

On your local machine:

```bash
tailscale status
```

Confirm VPS3 appears online (hostname usually vps3-devhub).

Optional connectivity check:

```bash
ping vps3-devhub
```

## 4. Open the editor in browser

Preferred URL:

- https://gen.ecomgear.dev/editor/

Because nginx route is VPN-only, this URL should be reachable only when your local device is on the same tailnet.

If DNS/VPN policy is still propagating, fallback test via SSH tunnel:

```bash
ssh root@vps3-devhub -L 8443:127.0.0.1:8443
```

Then open:

- http://127.0.0.1:8443/editor/

## 5. Log in to code-server

Use the password from CODESERVER_PASSWORD.

After login, open your workspace path on server:

- /var/www/ecomgear

## 6. Troubleshooting

- Cannot open /editor:
  - Confirm your local device is connected to tailnet.
  - Confirm nginx config deployed from infrastructure/nginx/vps3-gen.ecomgear.dev.conf.

- 403 Forbidden on /editor:
  - Your source IP is not in allowed VPN range (100.64.0.0/10).
  - Check Tailscale ACL and node connectivity.

- code-server not running:
  - On VPS3 run:
  ```bash
  systemctl status code-server@root
  journalctl -u code-server@root -n 100 --no-pager
  ```

- SSH blocked after hardening:
  - Keep one existing SSH session open until key-login is verified in a second terminal.

## 7. Security notes

- Keep code-server bound to localhost.
- Keep /editor route VPN-only.
- Keep ALLOW_PASSWORD_DEPLOY=false in GitHub variables.
- Rotate CODESERVER_PASSWORD periodically.
