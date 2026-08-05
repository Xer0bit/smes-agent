# Architecture

EcomGear is an AI-powered web app builder: a user describes an app in chat, an
LLM agent writes real files into a sandboxed Vite/React project, and the
result renders in a live preview. This doc is the entry point — it ties
together the subsystem docs below rather than duplicating them. Read the
linked doc for depth on any one piece.

```
Browser (chat UI, editor, live preview)
   │
   ▼
Express API (server/) ── SERVICE_ROLE splits one codebase into two deployments:
   │                       gen  → only /api/v1/ai (agent-stream, LLM traffic) — VPS3
   │                       api  → everything else (projects, files, hosting, auth) — VPS1
   │                       all  → both, default for local dev/single-process deploys
   ▼
Agent loop (runAgentLoop) ── tiered step budget, hybrid context retrieval,
   │                          26 tools, per-step compaction
   ▼
Supabase Postgres (projects, revisions, agent_runs, secrets, ...) + Storage (files)
   │
   ▼
Preview service (Docker, single-host) ── live HMR preview via WebSocket
   │
   ▼
Publish/hosting ── tenant deployments on separate VPS4+ hosting nodes
                    (own Postgres + PostgREST + Edge Runtime + Caddy per tenant)
```

## The subsystem docs

| Doc | Covers |
|---|---|
| [`docs/agents/agent-loop.md`](agents/agent-loop.md) | The agent's internal reasoning: request tiering, hybrid context retrieval, per-step compaction, the 26-tool surface, edit application, in-loop syntax checking. |
| [`docs/server.md`](server.md) | The Express HTTP layer: entry point, middleware, the `SERVICE_ROLE` process split, full route inventory, ~30 services grouped by concern, a traced request flow. |
| [`docs/database.md`](database.md) | Supabase/Postgres schema, migration convention, core tables, RLS policies, the central `has_project_access()` function. |
| [`docs/settings.md`](settings.md) | The 3 distinct settings surfaces (project settings UI, plan/tier config, system-wide LLM config), secrets storage, billing, LLM key/model precedence. |
| [`docs/edge-functions.md`](edge-functions.md) | The `write_edge_function`/`delete_edge_function` agent tools, sandbox contract, execution path, DB schema/RLS, HTTP routes. |
| [`docs/brand.md`](brand.md) | Verified product positioning, visual identity (colors/fonts), with inferred content clearly separated from verified fact. |
| [`docs/storage-architecture.md`](storage-architecture.md) | *(pre-existing)* File storage: Supabase Storage as source of truth, DB JSONB as transient transfer only. |
| [`docs/hosting-service-guide.md`](hosting-service-guide.md) | *(pre-existing)* Multi-server tenant hosting: VPS topology, per-tenant Postgres/PostgREST/Edge Runtime/Caddy. |

## Request flow, end to end

1. Browser sends a chat message to `POST /api/v1/ai/agent-stream` (only live on
   a process where `SERVICE_ROLE` is `gen` or `all` — see `docs/server.md`).
2. Auth middleware resolves the user (JWT) or a guest fingerprint.
3. `intentClassifier.ts` tiers the request (`micro`/`fix`/`edit`/`feature`/`build`),
   which sets the agent's step budget and retrieval depth — see
   `docs/agents/agent-loop.md` §1.
4. `runAgentLoop()` assembles initial context (hybrid retrieval: direct
   mention + import graph + vector KB, Copilot-style small working set),
   then loops: model call → tool calls (file ops, search, `think`,
   `save_memory`, database/secrets/edge-function tools) → per-step compaction
   → repeat, until the step budget or a natural stop.
5. Each `write_file`/`edit_file` call persists through the project's file
   layer (Storage-backed, see `docs/storage-architecture.md`) and pushes to
   the preview service over WebSocket for live HMR.
6. The preview renders in a Docker container (`runtime_mode:
   'single-host-docker'`, per `runtime.service.ts` — not a Firecracker
   microVM; namespace/cgroup isolation only).
7. When the user publishes, `publish_site` hands off to the hosting system —
   a separate tenant gets its own Postgres, PostgREST, Edge Runtime, and
   Caddy config on a VPS4+ hosting node (`docs/hosting-service-guide.md`).

## Known cross-doc gaps (surfaced by the docs above, not resolved here)

- `runtime.routes.ts` vs `preview.routes.ts` look like they may duplicate
  responsibility — not resolved (`docs/server.md`).
- Whether the edge-functions VPS5 functions-runner is the same system as the
  VPS4+ tenant-hosting "Edge Runtime" is unconfirmed — treat as possibly
  distinct until verified (`docs/edge-functions.md`).
- `agent_runs`' full column list is additive across 6+ migrations with no
  single source-of-truth snapshot (`docs/database.md`).
- No encryption-at-rest confirmed for `project_secrets` values — RLS is the
  only verified protection layer (`docs/settings.md`).

## How to keep these docs honest

Every fact in these docs traces to a real file at the time it was written.
This is a large, actively-changing codebase — before relying on a specific
claim (a column name, a route path, a config default), grep the cited file to
confirm it still matches. Treat these as a fast-orientation map, not a frozen
source of truth.
