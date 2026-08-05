# Server

The Express API that backs the eComGear editor, preview, hosting, and agent
system. This doc covers the HTTP layer (entry point, middleware, routes) and
the non-agent-loop service layer. The agent's internal reasoning/context logic
lives in `docs/agents/agent-loop.md` — this doc only says what triggers it.

## Entry point

`server/src/index.ts`:
- Loads env in order: `server/.env` (dotenv default) → `.env.local` (repo root, no override) → `.env.production` (repo root, no override). Local overrides always win; `.env.production` exists so secrets like `TENANT_DB_*` survive a PM2 restart without `--update-env`.
- Listens on `process.env.PORT || 5001`.
- On listen: signals PM2 readiness via `process.send('ready')` (required for zero-downtime cluster reloads), then in the background — tests all LLM providers and auto-disables failing ones (`testAndAutoDisableProviders`), starts an hourly re-check loop (`startLlmHealthLoop`), and warms the base template (`ensureBaseTemplate`, retried 3x).
- Loads LLM control state and probes the embedding provider *before* the server starts listening — sequential on purpose, per an inline comment: probing before the Google key is loaded silently caches `'bm25'` as the embedding provider and blocks all KB indexing until the next cache reset.

## App setup — `server/src/app.ts`

Middleware order:
1. `helmet()`
2. CORS — explicit allowlist (`localhost:3000/5173/8080/4173`, `ecomgear.dev`, `ecomgear.app` and subdomains) plus `CORS_ORIGIN` env var entries. Requests with no `Origin` header (server-to-server: preview service, health checks) are allowed through since browsers always send `Origin`. Notable allowed headers: `x-update-secret` (preview service auth), `x-project-id` (ECG proxy), `x-service-key` (ECG service-to-service), `x-dashboard-access` (generated-dashboard access token).
3. `express.json()` / `express.urlencoded()`, both capped at 50mb (base64 binary assets in sync payloads).
4. `morgan('combined')` + custom `requestLogger`.
5. `GET /health` (liveness: status/timestamp/uptime/version) — mounted before rate limiting or route groups, not versioned under `/api/v1`.
6. `aiRateLimiter` — 20 req/min per user (falls back to IP for guests), applied only to `/api/v1/ai`.
7. Route mounting (see below).
8. 404 handler, then `errorHandler`.

### `SERVICE_ROLE` — the process splits itself in two

```
SERVICE_ROLE=gen  → only /api/v1/ai (LLM/agent generation traffic)
SERVICE_ROLE=api  → everything else
SERVICE_ROLE=all  → both (default: local dev, tests, or a single-process deploy)
```
This is how the codebase can run as two physically separate deployments — a
"gen server" (VPS3, per other docs) handling only agent-stream/model traffic,
and an "api server" (VPS1) handling projects/files/hosting/auth/etc — from the
exact same source tree, just by setting one env var per process.

### Route inventory

All mounted under `/api/v1/*` unless noted.

| Mount | File | Endpoints |
|---|---|---|
| `/ai` (gen role) | `ai.routes.ts` | `POST /upload-attachment`, `POST /generate`, `GET /health`, `POST /test-providers`, `GET /models`, **`POST /agent-stream`** (the main one — SSE streaming agent run), `POST /suggestions`, `GET /active-run/:projectId`, `GET /history/:projectId`, `GET /generation/:generationId`, `POST /generate-app`, `POST /rollback`, `GET /versions/:projectId`, `POST /kb/:projectId/reindex`, `GET /kb/:projectId/stats` |
| `/auth` | `auth.routes.ts` | `GET /me`, `POST /refresh` |
| `/auth/ecg` | `ecgAuth.routes.ts` | `POST /login`, `/register`, `/2fa/verify`, `/2fa/resend`, `/forgot-password`, `/reset-password`, `/change-password`, `/refresh`, `/logout` — a **separate auth system** for eCG dashboard end-users, distinct from the main eComGear Supabase auth `auth.routes.ts` covers |
| `/projects` | `project.routes.ts` | `GET /`, `GET /:projectId`, `POST /:projectId/capture-thumbnail`, `DELETE /:projectId` |
| `/files` | `file.routes.ts` | `GET /project/:projectId`, `/project/:projectId/file`, `/project/:projectId/file/history` |
| `/preview` | `preview.routes.ts` | `POST /:projectId/start`, `/stop`, `/activity`, `GET /:projectId/status` |
| `/system` | `system.routes.ts` | `GET/PUT /llm/status`, `POST /llm/models`, `DELETE /llm/models/:id`, `GET/PUT /tier-config`, `POST /exec`, `GET /server-status`, `GET/POST /kb/status`, `/kb/reprobe` — the admin/ops control surface |
| `/runtime` | `runtime.routes.ts` | `POST /:projectId/start`, `/stop`, `/activity`, `GET /:projectId/status` — looks like a near-duplicate of `/preview`; worth confirming with whoever owns it whether both are still live or one supersedes the other |
| `/database` | `database.routes.ts` | `GET /status`, `/credentials`, `POST /sync-secrets`, `/preview-update`, `/provision`, `DELETE /deprovision`, `GET /ping`, `/dump`, `/tables`, `/tables/:table/rows`, `POST /query` — per-project tenant DB provisioning/inspection |
| `/admin/database` | `admin-database.routes.ts` | `GET /:id/ping`, `/:id/dump`, `POST /:id/deprovision` — admin-scoped version of the above |
| `/hosting` | `hosting.routes.ts` | `POST /:projectId/deploy`, `/verify-domain`, `/activate-domain`, `DELETE /domain/:domain`, `/deployment`, plus `/admin/health`, `/admin/domains`, `DELETE /admin/domains/:domain`, `/admin/deployment/:projectId` |
| `/seo` | `seo.routes.ts` | `POST /:projectId/sync`, `GET/PUT /:projectId/routes`, `DELETE /:projectId/routes/:routeId`, `GET/POST /:projectId/redirects`, `PUT/DELETE /:projectId/redirects/:redirectId` |
| `/header-integrations` | `header-integrations.routes.ts` | `POST /:projectId/sync` |
| `/github`, also `/auth/github` | `github.routes.ts` | `GET /connect`, `/callback`, `/status`, `DELETE /disconnect`, `GET /:projectId/link`, `POST /:projectId/create-repo`, `/:projectId/push`. Mounted **twice** — once under `/api/v1/github`, once bare at `/auth/github` — because the registered GitHub OAuth App's callback URL is `/auth/github/callback` and must match `REDIRECT_URI` in the route file exactly. |
| `/stripe` | `stripe.routes.ts` | `POST /:projectId/test` |
| `/functions` | `functions.routes.ts` | `GET /`, `/:name`, `POST /`, `PATCH /:name`, `DELETE /:name`, `POST /:name/invoke`, `GET /:name/logs` — edge function management, see `docs/edge-functions.md` |
| `/ecg-connect` (mount path only — see below) | `ecg-customize.routes.ts` | `GET/POST /:projectId/customize` |
| `/ecg-dev-agent` | `ecg-dev-agent.routes.ts` | `POST /discover`, `POST /` |
| `/ecg-proxy` | `ecg-proxy.routes.ts` | `POST /knowledge/upload`, `/ai-chat` |
| `/ecg-chat` | `ecg-chat.routes.ts` | `POST /` |
| `/ecg-access` | `ecg-access.routes.ts` | `POST /` — issues the `x-dashboard-access` token `dashboardAccessMiddleware` verifies |

**`ecg-connect.routes.ts` is not a router.** Despite the name (and despite
`/api/v1/ecg-connect` being mounted with `ecgCustomizeRoutes`, not this file),
it's a leftover module that now only exports two shared file-sync helpers
(`ecg-dev-agent.routes.ts` and `ecg-customize.routes.ts` both depend on them).
Its own comment explains why: the one-time launch-token handoff from
agent-portal's old "Dashboard Creator" trigger was retired 2026-07-23;
onboarding now goes through `ecg-dev-agent.routes.ts` (paste an MCP API key
directly, no portal token exchange).

## Middleware — `server/src/middleware/`

- **`auth.middleware.ts`**:
  - `authMiddleware` — requires `Authorization: Bearer <token>`, verifies against Supabase (`supabaseAuth.auth.getUser`), 10s timeout so a Supabase outage can't hang a request forever. 401 on missing/invalid token.
  - `optionalAuthMiddleware` — same verification, but never rejects; just leaves `req.user` unset on failure/absence and calls `next()`. Used on `/models`, `/agent-stream`, `/suggestions` etc. so guests can hit them.
  - `dashboardAccessMiddleware` — reads `x-dashboard-access`, verifies it via `verifyDashboardAccessToken`, sets `req.dashboardAccessProjectId` if valid. Never rejects either; route handlers decide what an unset project id means. This is what lets a *deployed* eCG dashboard call `ecg-proxy`/`ecg-chat` without its visitor having an eComGear account.
  - **Correction to a stale assumption**: guest-request fingerprinting (`FINGERPRINT_RE`, `GUEST_MAX_REQUESTS`) is NOT in this middleware file — it's implemented directly inside `ai.routes.ts` for the guest-model path, not as reusable middleware.
- **`ecgAuth.middleware.ts`** — separate auth check for the `ecgAuth.routes.ts` system (end-user auth for deployed eCG dashboards, distinct from `auth.middleware.ts`'s eComGear-account auth).
- **`error.middleware.ts`** — final error handler, mounted last in `app.ts`.
- **`request-logger.middleware.ts`** — custom request logging alongside morgan.
- **`validation.middleware.ts`** — request validation helpers (per-route usage, not globally mounted).

## Request flow: a chat message

1. Frontend `POST /api/v1/ai/agent-stream` (only live if this process has `servesGen`, i.e. `SERVICE_ROLE` is `gen` or `all`).
2. `optionalAuthMiddleware` resolves `req.user` if a token is present; guest flow proceeds unauthenticated with its own fingerprint-based rate limit inside the route handler.
3. `aiRateLimiter` caps it at 20/min keyed by `user.id` (or IP for guests).
4. The route handler in `ai.routes.ts` resolves the model/tier via `intentClassifier.ts`'s `classifyRequest`, resolves LLM provider config via `llm-control.service.ts`, then calls `runAgentLoop()` (`agentLoopService.ts` — see `docs/agents/agent-loop.md`).
5. `runAgentLoop` streams tokens/tool-call events back over the same HTTP response as Server-Sent Events (`Last-Event-ID` is in the CORS `exposedHeaders`/`allowedHeaders` list specifically to support SSE resume).
6. File writes during the run go through the agent tools (`server/src/agent-tools/`), which persist to Supabase Storage/DB (see `docs/database.md`, `docs/storage-architecture.md`) and push to the live preview via the preview service.

## Service layer — `server/src/services/`

Grouped by concern. One-line purpose per file (verified against the actual
file, not assumed from its name):

**Agent-loop-adjacent (each gets real depth in `docs/agents/agent-loop.md` if the name starts with `agent`, otherwise summarized here):**
- `agentLoopService.ts` — the main loop (separate doc).
- `agentContextCompaction.ts` — step-message compaction (separate doc).
- `agentToolSet.ts` — builds the tool set passed to the model each run (separate doc covers `save_memory`; the rest of the file wires up every tool in `agent-tools/`).
- `agentFileTree.ts` — builds the project file tree shown to the agent.
- `agentProjectLock.ts` — per-project lock so two concurrent agent runs on the same project can't interleave file writes.
- `agentSnapshot.ts` — project snapshot/restore for rollback; tracks which dotfiles are safe to include.
- `agentVision.ts` — image/PDF attachment handling and vision-model analysis (uses `pdf-parse`, a CJS module loaded via `createRequire` since the server is ESM).
- `agentXmlParser.ts` — parses XML-formatted operations out of model output (an alternate/legacy op format alongside tool-calling).
- `agentAppTsxGen.ts` — generates/patches `src/App.tsx` route wiring for the app being built.
- `agentProviderResolution.ts` — circuit-breaker for LLM providers: if a provider just returned a credit/billing error, avoid hammering it again, but the breaker must expire so a temporarily-out-of-quota provider isn't permanently blacklisted.
- `intentClassifier.ts` — classifies each request into a tier (`micro`/`fix`/`edit`/`feature`/`build`), which is what sets `MAX_STEPS` (`TIER_MAX_STEPS`, imported directly by `ai.routes.ts`) and whether the request is "cheap" (`isCheapTier`).
- `failureMemory.service.ts` — persists/recalls prior run failures (referenced doc format not confirmed here — see file directly if building on it).
- `runStateLedger.ts` — the per-run change journal (what compacted tool results point back to as "see Run Change Journal").
- `narration.service.ts` — turns agent activity into human-readable narration (likely for a live "what the agent is doing" UI feed — verify against its callers before relying on this description further).
- `geminiToolCache.service.ts` — caching layer specific to Gemini tool-calling.
- `promptCache.service.ts` — general prompt/response caching.

**LLM provider control:**
- `llm-control.service.ts` — resolves LLM config (API keys, provider state) with **env > DB** precedence per the code comment; `getLlmControlState()` and `getUserPlanTier()` both live here and are imported directly by `ai.routes.ts`.
- `llm-health.service.ts` — startup + hourly health checks (`testAndAutoDisableProviders`, `startLlmHealthLoop`), auto-disables a provider that's failing so requests don't keep routing to a dead one.

**Project/preview/runtime:**
- `project.service.ts` — project CRUD; contains an explicit prod-vs-local path split (`/var/ecomgear` is real and root-owned on VPS1; local dev can't `mkdir` there as a normal user).
- `preview.service.ts` — manages the live preview container/session per project.
- `runtime.service.ts` — reports `runtime_mode: 'single-host-docker'` (confirmed in an earlier exploration this session) — the actual isolation model backing previews is Docker, not a microVM.
- `baseTemplateService.ts` — bootstraps/warms the golden base Vite/React template new projects start from (`ensureBaseTemplate`, called at server startup).
- `thumbnailService.ts` — project thumbnail capture, backing `POST /:projectId/capture-thumbnail`.
- `functionRunner.service.ts` — executes/invokes edge functions (see `docs/edge-functions.md`).
- `hostingDeploy.service.ts` — deployment logic behind `hosting.routes.ts`.
- `database.service.ts` — tenant database provisioning/config, all env-var-driven per its own top comment; backs `database.routes.ts`.
- `tier-config.service.ts` — plan/tier configuration (see `docs/settings.md`).

**ECG (the generated-dashboard product line, distinct from the main app builder):**
- `ecgAuth.service.ts` — backs `ecgAuth.routes.ts`'s separate end-user auth.
- `ecgMcpClient.service.ts` — MCP client used by the ECG dev-agent flow.
- `ecg-template.ts` — reads the `server/agent-template` folder and injects it as a Supabase-ready file map; only `ecg-config.ts` is generated dynamically, everything else is read verbatim.
- `ecg-template-pages.ts` — pre-built page component generators (each returns a ready-to-write TSX string) for the ECG dashboard template.
- `ecg-template-chat.ts` — Gemini-style floating dashboard chat + placeholder page generators for the same template.

## Gaps / things worth verifying before relying on them further

- `runtime.routes.ts` and `preview.routes.ts` expose near-identical endpoint shapes (`start`/`stop`/`activity`/`status` per project) — this doc doesn't resolve whether one is legacy, whether both are actually live, or how a caller picks between them.
- `narration.service.ts` and `failureMemory.service.ts` were summarized from their evident purpose, not from tracing every caller — verify against the file directly before depending on the exact description.
- `agentXmlParser.ts`'s relationship to tool-calling (is XML a fallback format, a legacy format being phased out, or used for a specific tool?) wasn't traced in depth here.
