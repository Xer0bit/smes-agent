# Environments

This repo runs in three distinct contexts. Mixing them up is the single
biggest source of confusion in this codebase   read this before touching env
files or deploy scripts.

## 1. The three environments

| | Where it runs | What it talks to |
|---|---|---|
| **Local dev** | Your machine (`npm run dev:all`) | Frontend/vite: `localhost`. **Gen server + preview-service: REAL PRODUCTION Supabase, tenant DB, and preview infra** (see warning below). |
| **Production** | VPS1 (frontend+API+Supabase), VPS2 (preview), VPS3 (gen/agent), VPS4 (hosting), VPS5 (tenant Postgres) | Each other, over the real domains (`api.ecomgear.dev`, `preview.ecomgear.app`, `gen.ecomgear.dev`, etc.) |
| **Generated projects** | User apps built by the agent, served from VPS2 (preview) / VPS4 (published) | Their own `project_secrets` row   a completely separate credential set from the platform's own env files below |

Don't confuse "generated projects" with "this repo." CardPro, or any other
app the agent builds, has its own `VITE_SUPABASE_URL` / `VITE_DB_API_URL` /
etc., stored in the `project_secrets` table   nothing to do with the env
files described here, which configure the *platform itself* (this repo).

## 2. ⚠️ Local dev is NOT sandboxed from production data

`npm run dev:server` boots the real `agentLoopService.ts` against the real
production Supabase project and the real tenant DB (VPS5)   `.env.development`
(which seeds `server/.env` via `scripts/dev-setup.sh`) points at production
domains for everything except the frontend's own `localhost` URLs. There is
no local Supabase stack, no local tenant DB, no isolated sandbox.

**What this means in practice:**
- Running the gen server locally and firing a real `/agent-stream` request
  against a real `projectId` will write real files to that real project,
  exactly like a production run would.
- `npm run test:local` (`scripts/local-test.sh`) is safe   it only checks
  that the server *boots* and its `/health` endpoint responds. It does not
  fire a real agent request.
- If you need to exercise real agent logic end-to-end, do it against a
  dedicated test project you don't mind mutating   never against a real
  customer's project ID.

## 3. Env files   what's what, and load order

Vite's precedence (lowest → highest, later overrides earlier):
`.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local`

| File | Tracked in git? | Purpose |
|---|---|---|
| `.env.example` | ✅ yes (template, no real values) | Copy to `.env.local` and fill in for frontend dev |
| `server/.env.example` | ✅ yes (template, no real values) | Copy to `server/.env` and fill in for backend dev |
| `.env.local` | ❌ no | Your real frontend config   mostly `localhost` URLs |
| `.env.development` | ❌ no | Seeds `server/.env` (via `dev-setup.sh`)   mostly **production** URLs, see warning above |
| `.env.staging.local` | ❌ no | Frontend config for testing against the staging deploy, if you have one |
| `.env` / `.env.production` / `server/.env` | ❌ no (as of this cleanup) | Real secrets   **never commit these**. If you see them tracked in `git status`, something regressed; re-run `git rm --cached <file>` and check `.gitignore`. |

`server/.env`, `.env`, and `.env.production` were previously tracked in git
with real, live production secrets (`SUPABASE_SERVICE_ROLE_KEY`,
`ANTHROPIC_API_KEY`, `TENANT_DB_SUPERUSER_PASSWORD`, etc.)   this was fixed
by untracking them, but anyone who cloned the repo before that point already
has those old values in their local git history. If you're setting up
credentials for the first time after this date, treat any value that was
ever in one of those files as compromised and use a freshly rotated one.

## 4. Ports (local dev)

| Service | Port | Health check |
|---|---|---|
| Frontend (vite) | 8080 |   |
| Gen/agent server | 5001 | `GET /health` |
| preview-service | 3001 | `GET /health` |

These match the ports each service also uses in production (behind nginx on
each VPS), so there's no local/prod port mismatch to worry about   just make
sure nothing else on your machine is already bound to 5001/3001/8080.

## 5. Before deploying

Run `npm run test:local` (or `npm run test:local:build-only` for a faster
type-check-only pass) before `./scripts/deploy.sh <target>`. It type-checks
and builds the server and frontend, syntax-checks preview-service, and boots
both the gen server and preview-service locally to confirm they actually
come up healthy   catching import/config errors before they reach production.
