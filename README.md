# eComGear

AI-powered website generation platform with a 3-module production architecture:

1. `frontend` (VPS1): React app and user experience.
2. `preview-service` (VPS2): on-demand project preview runtime.
3. `agent/server` (VPS3): agentic code generation and orchestration APIs.

This README is the operational guide for developers and operators.

## What eComGear Does

eComGear lets users describe a website/app in natural language, then:

1. Generates multi-file project code through AI agents.
2. Materializes files into an isolated preview project.
3. Validates and runs the generated app in preview mode.
4. Supports iterative edits/regeneration.
5. Serves production modules via dedicated VPS deployments.

## Repository Layout

```text
.
├── src/                        # Frontend (React + Vite + TypeScript)
├── preview-service/            # Preview runtime service (Node + Express + Vite)
├── server/                     # Agent/backend API (Node + Express + TypeScript)
├── supabase/                   # Supabase config, migrations, functions
├── infrastructure/nginx/       # Nginx configs per VPS
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
- Main URL: `https://www.ecomgear.dev`

### 2) Preview Module (VPS2)

- Path: `preview-service/`
- Stack: Node.js, Express, Vite runtime
- Purpose:
  - Hosts/generated project workspaces
  - Validates and writes generated files
  - Starts/stops project preview servers
  - Handles preview/published slug routes
- Deployed by: `.github/workflows/deploy-vps2-preview.yml`
- Main URL: `https://preview.ecomgear.app`

### 3) Agent Module (VPS3)

- Path: `server/`
- Stack: Node.js, Express, TypeScript
- Purpose:
  - Agentic code generation orchestration
  - LLM provider calls and prompt pipeline
  - Build/generation endpoints for frontend
  - Integrates with Supabase and preview module
- Deployed by: `.github/workflows/deploy-vps3-agent.yml`
- Main URL: `https://gen.ecomgear.dev`

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

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
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
curl -si https://www.ecomgear.dev | head -n 12
```

Preview service:

```bash
curl -si https://preview.ecomgear.app/health | head -n 12
```

Agent API:

```bash
curl -si https://gen.ecomgear.dev/health | head -n 12
```

## Nginx and Infra

Per-VPS Nginx configs:

- `infrastructure/nginx/vps1-ecomgear.dev.conf`
- `infrastructure/nginx/vps2-preview.ecomgear.app.conf`
- `infrastructure/nginx/vps3-gen.ecomgear.dev.conf`

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
docker rm -f ecomgear-preview-dev || true
docker build --no-cache -t ecomgear-preview-dev-image ./preview-service
docker run -d --name ecomgear-preview-dev \
  -p 3001:3001 -p 24679:24679 \
  -v "$(pwd)/preview-data:/app/projects" \
  -e NODE_ENV=development -e PORT=3001 \
  ecomgear-preview-dev-image
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
pm2 logs ecomgear-gen
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
