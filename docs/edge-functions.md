# Edge Functions

Server-side JavaScript functions the AI agent writes for a project, for logic that must never run in the browser (secret API keys, webhooks, payment/checkout logic, server-side validation). Only the agent can create, update, or delete them — the human-facing HTTP endpoints for those operations are hard-locked to `403`.

## Write path — the only way a function is created or changed

`server/src/agent-tools/write_edge_function.ts` is the sole write path. Sequence on every call:

1. **Name validation**: `^[A-Za-z][A-Za-z0-9_-]{0,63}$`.
2. **AST-based static validation** (`server/src/services/edgeFunctionValidator.ts`, acorn/acorn-walk): parses the code with `sourceType: 'script'` (so `import`/`export` are syntax errors — no separate check needed), then walks the AST to reject banned identifiers (`require`, `process`, `global`, `globalThis`, `Function`, `eval`, `module`, `exports`, `__dirname`, `__filename`), any `.constructor` access (dot or bracket-literal form — the exact primitive a sandbox-escape chain needs), `with` statements, and dynamic `import()`. This replaced an older regex/`vm.Script`-syntax-only check that never caught `.constructor` access; covered by `server/src/services/__tests__/edgeFunctionValidator.test.ts`. The same validator re-runs at invoke time (`functionRunner.service.ts`) as defense-in-depth against a DB row tampered with directly.
3. **Per-project cap**: max 20 edge functions per project (`MAX_FUNCTIONS_PER_PROJECT`), to stop a runaway generation loop from creating unbounded rows.
4. **Owner resolution**: the row is always saved under the **project owner's** `user_id` (looked up from `projects.user_id`), never `ctx.userId` (whoever is currently chatting). This is deliberate — the invoke route looks up a function by matching `edge_functions.user_id` against the project owner, so saving under a collaborator's id would silently make the function permanently uninvokable (a 404 that looks like a bug but is actually an ownership mismatch).
5. **Upsert** into `edge_functions` on `(project_id, name)` conflict — same name in the same project overwrites; different projects never collide. Also sets `requires_service_role` (default `true`) and `is_public` (default `true`) — see "Least-privilege flags" below.
6. **Mirror to disk**: writes `__edge_functions__/<name>.js` into the project's file tree (`safeJoin(ctx.appPath, ...)`) and registers it in `ctx.pendingPreviewFiles`. This exists so the agent's own `read_file`/`list_files`/`grep` tools can see which functions already exist — before this mirror existed, functions were invisible outside the DB, which is the documented cause of the agent creating duplicate/orphaned functions instead of reusing one. **The DB row remains the actual invocation source of truth; the mirror is read/write convenience only.** It is never served to the browser — the preview build excludes `__edge_functions__/`.
7. **Permission preflight + VPS5 sync** (only if a hosted database is provisioned — see below). As of the 2026-08-05 stability review, a failed or skipped sync no longer silently succeeds from the agent/user's point of view — see "Where execution actually happens" below.

## Least-privilege flags (`edge_functions.requires_service_role` / `.is_public`)

Two boolean columns, added `supabase/migrations/20260805060000_edge_functions_least_privilege.sql`, both default `true` (matches pre-existing behavior for old rows):

- **`requires_service_role`**: when `false`, the function's `db.*` calls run with the project's **anon** key instead of the RLS/grant-bypassing service key (`functions.routes.ts`'s `resolveFunctionBundle`: `serviceKey: fn.requires_service_role ? creds.service_key : creds.anon_key`). This is a real privilege reduction, not a label — the function's `db.*` calls become genuinely scoped to whatever the anon role can already do. Set `false` for functions that only read data the anon role can already see.
- **`is_public`**: when `false`, invocation is rejected (`403`) for any caller authenticating with the project's public anon/service key (`callerRole === 'tenant-public'`) — only a verified owner platform session can invoke it. Set `false` for admin-only operations.

Both are agent-settable via `write_edge_function`'s `requiresServiceRole`/`isPublic` optional args.

`server/src/services/agentLoopService.ts` has a companion function, `backfillEdgeFunctionMirrors(appPath, projectId)`, called once per run: it reads every `edge_functions` row for the project and writes any mirror file that's missing on disk (e.g. after a preview container reset). Best-effort — a DB or FS failure here never blocks the run.

## Delete path

`server/src/agent-tools/delete_edge_function.ts`, symmetric to write: deletes the `edge_functions` row (scoped by `project_id` + `name`), tells VPS5 to deactivate its copy (`is_active: false`, empty code), and removes the local mirror file. Also owner-resolved the same way as write.

## Sandbox contract (what the code actually runs inside)

The agent is told, in the tool description, exactly what's available in scope:
- `params` — caller's input object
- `db` — hosted-database helper (`db.select/insert/update/delete/rpc`) — errors if no database is provisioned
- `secrets` — read-only map of the project's saved secrets (`secrets.STRIPE_SECRET_KEY`, etc. — see `set_secret.ts`)
- `fetch` — HTTPS-only, no internal hosts
- `console` — captured and shown to the project owner
- `ecg` — portal helper, `null` unless the project is portal-linked

Hard limits: no `import`/`export`/`require`/npm packages, no `process.env`, 5-second execution timeout.

### Sandbox mechanics (post 2026-08 security remediation)

`server/src/services/functionRunner.service.ts` runs guest code inside an **`isolated-vm` isolate** — a genuinely separate V8 realm, not the shared-realm `vm.createContext` used before (which had a live `Object.constructor.constructor(...)` escape to host-process RCE). No host object or function is ever handed directly into the isolate; every capability (`db.*`, `ecg.*`, `fetch`, `console`) is proxied through a single `_hostCall` bridge that only crosses JSON strings, so the guest realm never touches a host-realm `Object`/`Function`/`Promise`. The 5s timeout is a real V8-level interrupt (`isolate.compileScript(...).run(context, { timeout, promise: true })`), not a non-cancelling `Promise.race` — it can actually terminate a synchronous `while(true){}` inside guest code. `fetch` blocks HTTP, localhost, all private/link-local ranges (including `169.254.169.254`, the AWS/GCP/Azure metadata endpoint), and IPv6 loopback/link-local equivalents. `secrets` passed into the sandbox are frozen and copied by value (`ExternalCopy`) — there is no bridge call that writes a value back into `project_secrets`, so they're genuinely read-only from inside guest code.

`isolated-vm` is an `optionalDependency` (see `server/package.json`) and dynamically imported only when a function actually runs — this lets hosts that don't mount `/api/v1/functions` (or that run a Node version without a prebuilt binary for it) skip it entirely without crashing on startup. If it fails to load, invocation returns a clean "unavailable on this server instance" error rather than crashing.

## Where execution actually happens

**Unresolved doc/behavior mismatch, flagged by the 2026-08 security audit and still open as of this write-up.** An inline comment in `server/src/routes/functions.routes.ts` (right above the `/invoke` route) states plainly: the route's own code calls `runEdgeFunction()` **in-process, on this server** — not on VPS5. This doc previously claimed the opposite ("execution happens entirely on VPS5, never on the platform API"), which was wrong; that claim is corrected here, but which side is the *intended* target architecture (dispatch to VPS5 for real, vs. accept in-process execution as the actual design) has not been decided as a product question — don't treat either side as settled.

What IS true and unambiguous: after `write_edge_function`/`delete_edge_function`/`set_secret` write to this repo's DB, they separately push the same data to VPS5:

- `POST https://cloud.ecomgear.app/<schema>/functions/_sync` — code + active flag
- `POST https://cloud.ecomgear.app/<schema>/secrets/_sync` — secrets (implied by the comment; not verified in this repo's code)

Both syncs are authenticated with `X-Internal-Secret: $FUNCTIONS_INTERNAL_SECRET`. **This env var is required for the sync to actually happen.** As of the 2026-08-05 stability review, an unset secret or a failed sync is no longer a silent no-op from the caller's point of view: `write_edge_function.ts` tracks sync status and, on `skipped_no_secret`/`failed`, returns a message telling the agent the function was *saved* but is **NOT yet invocable at the VPS5 URL** — the agent is expected to relay that to the user instead of claiming the function works. (The DB row and local mirror still save successfully regardless; only the returned status message changed.)

Before syncing, `write_edge_function.ts` also runs a **permission preflight** (`databaseService.ensureFunctionDbAccess`) — a function can validate fine but still 403 the first real invocation if it touches a table/RPC never granted to the project's DB roles (e.g. `pgcrypto` via `extensions.crypt`). This step self-heals missing grants proactively and reports what it healed back to the agent, rather than waiting for a user's crash report.

**This is a different execution mechanism from the tenant hosting system described in `docs/hosting-service-guide.md`** (VPS4+ Docker/Caddy nodes with a per-tenant "Edge Runtime"). Both exist in this codebase; this doc only covers the `edge_functions` table / VPS5 functions-runner path. Whether/how the two relate wasn't verified here — flag if you need that reconciled.

### Invocation kill switch

`functions.routes.ts`'s `/invoke` route is gated by `EDGE_FUNCTIONS_INVOKE_ENABLED` — must be exactly `'true'` or every invocation returns `503`. Defaults **closed** (disabled) on any unset or misspelled value. Added as an emergency stop during the 2026-08 sandbox-escape remediation; check current value before assuming invocation is live in any given environment.

## Database schema

Two tables, `supabase/migrations/20260620100000_edge_functions.sql` (original) + `supabase/migrations/20260709120000_edge_functions_project_scope.sql` (added project scoping) + `supabase/migrations/20260805060000_edge_functions_least_privilege.sql` (added the two flags below):

```sql
CREATE TABLE edge_functions (
  id                     UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id             UUID        REFERENCES public.projects(id) ON DELETE CASCADE,  -- added later
  name                   TEXT        NOT NULL,
  description            TEXT,
  code                   TEXT        NOT NULL DEFAULT '',
  is_active              BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_service_role  BOOLEAN     NOT NULL DEFAULT TRUE,   -- added later, see "Least-privilege flags"
  is_public              BOOLEAN     NOT NULL DEFAULT TRUE,   -- added later, see "Least-privilege flags"
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- auto-touched by a trigger
  CONSTRAINT name_valid CHECK (name ~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$')
);
-- UNIQUE(project_id, name) where project_id IS NOT NULL (partial index, replaced the original UNIQUE(user_id, name))

CREATE TABLE edge_function_logs (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id  UUID        REFERENCES public.projects(id) ON DELETE CASCADE,  -- added later
  function_id UUID        NOT NULL REFERENCES edge_functions(id) ON DELETE CASCADE,
  params      JSONB,
  result      JSONB,
  logs        TEXT[],
  duration_ms INTEGER,
  error       TEXT,
  invoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Why project scoping was added** (per the migration's own comment): originally scoped by `user_id` only, so a user with multiple projects could silently overwrite one project's function with another's (same name across projects), and invoking a function ran whichever project last wrote that name — against a *different* project's database credentials. The fix backfills `project_id` only when a user has exactly one project (unambiguous); everyone else's pre-existing rows are left `project_id = NULL` and become inert until rewritten by the agent.

### RLS

Both tables: `auth.uid() = user_id` AND (`project_id IS NULL` OR the caller owns that project OR is an `editor` in `project_members` for that project), for `ALL` operations, plus a blanket `service_role` bypass policy. So a viewer/non-editor project member cannot read or invoke another member's functions via direct table access — but note the actual **invoke route bypasses this entirely** (it uses the `service_role`-keyed `supabase` client, not a per-user RLS-scoped one), so invoke authorization is enforced in `functions.routes.ts` application code (`resolveInvokeAuth` / `requireProjectAccess`), not by RLS.

## HTTP routes (`server/src/routes/functions.routes.ts`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/v1/functions` | owner session (`authMiddleware`) | List functions for a project. Queried by `project_id` only, not `user_id` + `project_id` — necessary because rows are saved under the *owner's* `user_id`, and a collaborator's own `req.user.id` differs from that. |
| `GET /api/v1/functions/:name` | owner session | Full function row (includes code). |
| `POST /api/v1/functions` | owner session | **Locked — always 403.** "Ask the agent to write or update your edge function." |
| `PATCH /api/v1/functions/:name` | owner session | **Locked — always 403.** |
| `DELETE /api/v1/functions/:name` | owner session | **Locked — always 403.** |
| `POST /api/v1/functions/:name/invoke` | see below | The one public path — a generated app's own end users call this. Rate-limited to 30/min per the router's own limiter. |
| `GET /api/v1/functions/:name/logs` | owner session | Last 50 invocation logs for the function. |

### Invoke auth (`resolveInvokeAuth`)

Two accepted credential types, tried in order:
1. **Tenant anon/service JWT** — a local HMAC check (`verifyTenantJwt`, no network call) against the project's own `VITE_DB_ANON_KEY`/`VITE_DB_SERVICE_KEY`. This is how a *generated app's real end users* invoke a function — they never have an EcomGear platform session.
2. **EcomGear platform session** (via `supabaseAuth.auth.getUser(token)`, 10s timeout) — lets the project *owner* test invocation from Settings without needing the anon key.

At invoke time, `resolveFunctionBundle` re-resolves the project owner (same reasoning as the write path — a collaborator's session has a different `user_id` than the owner whose `edge_functions`/`tenant_databases` rows are being looked up), loads DB credentials (optional — a function with no `db.*` calls runs fine unprovisioned), loads project secrets and, if present, `ECG_PORTAL_TOKEN`/`ECG_LLM_*` secrets for portal-linked projects, then hands everything to `runEdgeFunction()` (in `functionRunner.service.ts`, not read in this pass).

## Settings / management UI

Not verified directly in this pass (owned by the `docs/settings.md` doc) — but `write_edge_function.ts`'s own returned message tells the agent: "the owner can still test it from Settings → Edge Functions," confirming a Settings-side surface exists for viewing/testing/reading logs, consistent with the locked-create/patch/delete + open GET/invoke/logs route shape above.
