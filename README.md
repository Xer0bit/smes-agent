# SMEsAgent

AI-powered website generation platform with a 3-module production architecture:

1. `frontend` (VPS1): React app and user experience.
2. `preview-service` (VPS2): on-demand project preview runtime.
3. `agent/server` (VPS3): agentic code generation and orchestration APIs.

This README is the operational guide for developers and operators.

## What SMEsAgent Does

SMEsAgent lets users describe a website/app in natural language, then:

1. Generates multi-file project code through AI agents.
2. Materializes files into an isolated preview project.
3. Validates and runs the generated app in preview mode.
4. Supports iterative edits/regeneration.
5. Serves production modules via dedicated VPS deployments.

## Repository Layout

```text
.
├── apps/
│   ├── web-client/             # Frontend source (React + Vite + TypeScript), built from repo root
│   ├── api-gateway/             # Agent/backend API (Node + Express + TypeScript, SERVICE_ROLE=api|gen|all)
│   ├── preview-service/         # Preview runtime service (Node + Express + Vite)
│   ├── hosting-service/         # Published/custom-domain static hosting + per-tenant containers (Caddy)
│   └── tenant-functions-runner/ # Tenant-schema edge-function bridge (paired with VPS5 Postgres/PostgREST)
├── supabase/                   # Supabase config, migrations, functions
├── infrastructure/
│   ├── nginx/                   # Per-VPS nginx configs (current 5-VPS production layout)
│   └── single-server/           # Target: same services consolidated onto one box — see below
├── .github/workflows/          # CI + per-module deploy workflows
├── scripts/                    # Deploy + ops scripts
└── docs/                       # Deep architecture/design docs
```

## 3 Modules (Production)

### 1) Frontend Module (VPS1)

- Path: `src/`
- Stack: React, Vite, TypeScript, Tailwind
- Purpose:
  - User auth and dashboard UX
  - Prompt input + code/preview interfaces
  - Calls preview and agent APIs
- Deployed by: `.github/workflows/deploy-vps1-frontend.yml`
- Main URL: `https://www.SMEsAgent.dev`

### 2) Preview Module (VPS2)

- Path: `preview-service/`
- Stack: Node.js, Express, Vite runtime
- Purpose:
  - Hosts/generated project workspaces
  - Validates and writes generated files
  - Starts/stops project preview servers
  - Handles preview/published slug routes
- Deployed by: `.github/workflows/deploy-vps2-preview.yml`
- Main URL: `https://preview.SMEsAgent.app`

### 3) Agent Module (VPS3)

- Path: `server/`
- Stack: Node.js, Express, TypeScript
- Purpose:
  - Agentic code generation orchestration
  - LLM provider calls and prompt pipeline
  - Build/generation endpoints for frontend
  - Integrates with Supabase and preview module
- Deployed by: `.github/workflows/deploy-vps3-agent.yml`
- Main URL: `https://gen.SMEsAgent.dev`

## Agentic Website Generation Flow

High-level runtime flow:

1. User submits a build prompt from frontend.
2. Frontend sends request to agent module (`server/`).
3. Agent module generates/updates structured multi-file output.
4. Preview module receives files and validates source syntax.
5. Preview module materializes files into project workspace.
6. Vite preview server serves the generated site.
7. Frontend embeds/links preview URL for live iteration.

Key implementation points in preview module:

- Tracks active Vite servers per `projectId`
- Validates files using esbuild transforms before write
- Preserves certain config files if unchanged
- Supports slug-based published preview lookup

## Local Development

### Requirements

- Node.js 20+
- npm 10+
- PM2 (optional for local parity)
- Supabase CLI (optional, for local DB workflows)

### Install Dependencies

```bash
npm ci
cd preview-service && npm ci
cd ../server && npm ci
```

### Run Modules

Frontend only:

```bash
npm run dev
```

Frontend + preview service together:

```bash
npm run dev:all
```

Preview service only:

```bash
npm run dev:preview
```

Agent server:

```bash
cd server
npm run dev
```

### Build

Frontend build:

```bash
npm run build
```

Server build:

```bash
cd server
npm run build
```

Preview syntax check:

```bash
cd preview-service
node --check server.js
```

## Environment Configuration

Use environment files for local/prod values:

- Root: `.env`, `.env.local`, `.env.production`
- Deploy helper: `.deploy.env`

Typical keys used across modules:

- `OPENROUTER_API_KEY` (single LLM provider   see `config/models.ts`: `qwen/qwen3.7-flash` for code, `google/gemini-2.5-flash-lite` for small tasks)
- `GEMINI_API_KEY` (embeddings only   `knowledgebase/embedder.ts`, unrelated to the chat LLM)
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `VPS1_*`, `VPS2_*`, `VPS3_*` deploy credentials/hosts

Never commit real secrets to git.

## CI/CD

### CI Workflow

- File: `.github/workflows/ci.yml`
- Jobs:
  1. Frontend tests + build
  2. Preview-service dependency install + syntax check
  3. Server build

### Module-Scoped Deployment (Changed Modules Only)

Deploy workflows are path-filtered so only relevant modules deploy:

- `deploy-vps1-frontend.yml`: frontend + VPS1 shared files
- `deploy-vps2-preview.yml`: preview module files only
- `deploy-vps3-agent.yml`: server/agent + supabase function/migration files

This avoids full fleet deploys for unrelated changes.

### Caching

- GitHub Actions uses npm dependency caching via `actions/setup-node` with lockfiles.
- Deploys use `rsync` for delta transfer (only changed files copied).

## Single-Server Architecture (target)

Scaffolding to consolidate the 5-VPS layout above onto one box, for lower
cost at smaller scale. Files live in `infrastructure/single-server/`:

- `Caddyfile` — the one public 80/443 edge (automatic HTTPS). Reverse-proxies
  every platform hostname to an internal nginx on `127.0.0.1:8081`, and keeps
  importing `apps/hosting-service`'s own per-tenant-domain Caddy config
  (`/etc/caddy/sites/*.caddy`) unchanged — that piece is already single-host
  native.
- `nginx-platform.conf` — the old vps1/vps2/vps3/vps5 vhosts merged into one
  file, internal-only, server_name-differentiated exactly as before. Carries
  forward the incident-driven CORS/rate-limit/path-rewrite logic verbatim
  (PostgREST rate limiting, tenant-schema path routing, SSE buffering/gzip
  tuning, asset-path rescue routes) rather than re-deriving it.
- `ecosystem.config.cjs` — one PM2 file for `ecg-api` (api-gateway with
  `SERVICE_ROLE=all`, merging the old separate api/gen processes),
  `ecg-preview`, `ecg-hosting`, `ecg-tenant-functions`.
- `docker-compose.yml` — just the tenant-schema PostgREST container. Tenant
  data lives as another database (`ecg_tenants`) on the box's own Postgres
  instead of a second Postgres server — the same pattern
  `scripts/local-tenant-db.sh` already uses for local dev.

Not included: self-hosted Supabase itself (Kong/Auth/Storage/Realtime/its
Postgres). That's a large third-party stack provisioned via its own official
install path (https://supabase.com/docs/guides/self-hosting/docker) and is
assumed already running on `127.0.0.1:54321` before running the setup script.

```bash
sudo ENV_FILE=.deploy.env ./scripts/setup-single-server.sh
```

Domain names are hardcoded to `smes.xer0bit.com` / `app-smes.xer0bit.com` in both config
files (matches the existing per-VPS confs' convention); `sed` both files if
the domain changes. `preview.gen-smes.xer0bit.com` and `*.app-smes.xer0bit.com` need a
DNS-01 wildcard cert (stock Caddy can't do that without a DNS-provider
plugin) — the Caddyfile loads the certbot-issued cert already in place from
the current VPS2/VPS4 setup rather than requiring a custom Caddy build.

## Manual Deployment

Single script for direct deploy control:

```bash
set -a && source .deploy.env && set +a
./scripts/deploy.sh [vps1|vps2|vps3|all]
```

Examples:

```bash
./scripts/deploy.sh vps2
./scripts/deploy.sh all
```

## Health Checks

Frontend:

```bash
curl -si https://www.SMEsAgent.dev | head -n 12
```

Preview service:

```bash
curl -si https://preview.SMEsAgent.app/health | head -n 12
```

Agent API:

```bash
curl -si https://gen.SMEsAgent.dev/health | head -n 12
```

## Nginx and Infra

Per-VPS Nginx configs:

- `infrastructure/nginx/vps1-SMEsAgent.dev.conf`
- `infrastructure/nginx/vps2-preview.SMEsAgent.app.conf`
- `infrastructure/nginx/vps3-gen.SMEsAgent.dev.conf`

These are pushed by their corresponding deploy workflows.

## Troubleshooting Quick Reference

### Deploy auth fails

- Ensure GitHub Actions env values have no hidden CRLF/newline artifacts.
- Ensure host/user/password variables are set in the deployment environment.

### Preview hotfix rollout (safe path)

- Run verification before shipping preview-service changes:

```bash
./scripts/preview-preflight.sh
```

- If local Docker legacy Compose fails with `ContainerConfig`, avoid `docker-compose` v1 and run a clean container cycle:

```bash
docker rm -f SMEsAgent-preview-dev || true
docker build --no-cache -t SMEsAgent-preview-dev-image ./preview-service
docker run -d --name SMEsAgent-preview-dev \
  -p 3001:3001 -p 24679:24679 \
  -v "$(pwd)/preview-data:/app/projects" \
  -e NODE_ENV=development -e PORT=3001 \
  SMEsAgent-preview-dev-image
```

- Validate module MIME and payload after restart:

```bash
curl -sSI "http://localhost:3001/preview/<project-id>/src/main.tsx"
curl -sS "http://localhost:3001/preview/<project-id>/src/main.tsx" | head
```

### Preview deploy times out on SSH

- Usually transient runner network path issue.
- Re-run workflow; VPS2 deploy workflow includes retries/timeouts.

### Agent deploy fails after sync

- Check PM2 process state on VPS3:

```bash
pm2 status
pm2 logs SMEsAgent-gen
```

- Confirm `.env.production` exists and required keys are present.

### Generated preview fails to render

- Check preview service logs.
- Inspect validation errors returned by preview API.
- Verify generated `package.json` dependencies are aligned.

## Additional Documentation

- `docs/llm-platform-complete-design-guide.md`
- `docs/storage-architecture.md`

## Operational Notes

- Keep workflows module-scoped to prevent unnecessary deploys.
- Keep lockfiles current to maximize cache hits.
- Prefer `rsync` over full copy for deployment efficiency.
- Validate generated source before writing/running preview projects.

---
