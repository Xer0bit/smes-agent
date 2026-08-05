# Database

Postgres via Supabase. 124 timestamped migrations in `supabase/migrations/` (`YYYYMMDDHHMMSS_description.sql`), applied in filename order. Apply locally with `supabase db push --local` (see `docs/hosting-service-guide.md`); no other migration-runner script exists in `package.json`.

`supabase/migrations/20260105133931_initial_schema.sql` is **not a real migration** — its own header says "WARNING: This schema is for context only and is not meant to be run." Treat it as a schema-dump snapshot for orientation, not as something that executes. The actual current schema is the cumulative result of all 124 files applied in order; later files frequently redefine functions/policies created in earlier ones (e.g. `has_project_access` has at least 4 rewrites — always trust the latest-dated one).

## Core tables

| Table | Purpose |
|---|---|
| `profiles` | 1:1 with `auth.users`, extra profile fields (region, MFA flag, account_status) |
| `organizations` | Tenant/org record — plan_tier, Stripe customer/connect IDs, seats, security_policy jsonb |
| `org_members` / `org_invitations` | Org membership and pending invites |
| `projects` | A user's app-builder project. `organization_id` + `user_id`/`created_by`, `visibility` enum, storage/revision counters |
| `project_members` / `project_collaborators` | Per-project sharing (roles: editor/viewer/client) |
| `revisions` | One row per AI-generated code version of a project (`generated_files` jsonb, `preview_url`, `is_published`/`is_active`). See `docs/storage-architecture.md` — the DB is a temporary staging point for file content; Supabase Storage is the permanent source of truth, and `generated_files`/`generated_code` here get nulled out after upload. Don't re-derive that flow here, read that doc. |
| `revision_preview` | Preview build status/URL per revision, added later as a compatibility table for the editor's history API (`20260216141000`) |
| `messages` | Chat/editor message history |
| `ai_agents` | User-defined automation agents (distinct from the app-builder's own coding agent) — `workflow_data` jsonb, linked to a `project_id` |
| `agent_runs` (+ `_tracking`, `_tokens`, `_snapshot_id`, `_enhanced`, `_attribution` migrations) | One row per app-builder agent-loop run. Columns accumulated over 6 migrations: tokens in/out, cost, snapshot id, then (2026-07-21) `organization_id`/`is_internal`/`narration_cost_usd` to fix a cost-attribution gap where vision/narration LLM calls weren't being folded into run cost. If you need the current full column list, `grep -A2 'ALTER TABLE.*agent_runs' supabase/migrations/*.sql` in date order — no single CREATE TABLE has the whole shape. |
| `project_secrets` | Per-project env vars/API keys the agent's `set_secret`/`list_secrets` tools manage. **Values are stored in plaintext** (`key_value text`) — the migration's own comment says so; protection is RLS-only, not encryption at rest. |
| `plan_tiers`, `subscriptions`, `usage_records`, `usage_tracking`, `invoices`, `billing_events`, `credit_balances` | Billing/usage — see `docs/settings.md` for the tier-config and billing service layer built on these |
| `hosting_servers`, `tenant_deployments`, `tenant_domains` | Multi-VPS hosting/publish system — fully documented already in `docs/hosting-service-guide.md`, don't duplicate here |
| `project_agent_skills`, `agent_skill_templates` | Per-project reusable "skills" attachable to the coding agent (added `20260221`) |

Not verified from migrations in this pass: exact current full column list for `agent_runs` (accumulated additively — see above) and for `organizations`/`projects` beyond what the initial-schema snapshot shows plus later `ALTER TABLE`s spotted; if a column matters for a change you're making, grep the actual migrations rather than trusting this table's summary as exhaustive.

## Row Level Security

28 migration files touch `ENABLE ROW LEVEL SECURITY`; 48 files add/replace `CREATE POLICY` statements. RLS is real and load-bearing here, not decorative — but only for **direct** Postgres access. The Node server (`server/src/config/database.ts`) connects with the **service-role key**, which bypasses RLS entirely:

```ts
// server/src/config/database.ts
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supabase = createClient(process.env.SUPABASE_URL, supabaseServiceKey, { ... });
// separate client, anon key, used only to verify a user's JWT:
export const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || supabaseServiceKey);
```

So for this platform's own frontend (`src/`), authorization is enforced in the Express route/middleware layer, not by RLS — the main app's `src/` doesn't create its own Supabase client to query the DB directly (confirmed: the only `createClient` usages under `src/` are inside `src/base-example/`, which is the scaffold template copied into *user-generated* projects, not this app's own code). RLS's real audience here is: (a) defense-in-depth if the anon key ever gets used directly, and (b) every user-generated app built by the platform, which does talk to Supabase directly from its own frontend using the base-example client pattern — for those apps, RLS is the only access control that exists.

### The central access-control function: `has_project_access(project_id)`

Redefined at least 4 times (`20260210120000`, `20260228123500`, `20260304000000` — fixed an infinite-recursion bug, `20260221140000`, `20260404000006`). Current version (`20260404000006_rls_permissions_update.sql`) grants access if any of:
- caller has `user_roles.role IN ('super_admin','admin')`
- caller is the project's `created_by` or `user_id`
- caller is a member of the project's org (with org-admin/billing_admin seeing all org projects)
- caller is a `project_members` row for that project
- (this migration's own stated purpose) unauthenticated access is allowed when the project is publicly shared (`visibility='org_all'` + active status) or via a `shared_view_public` role

It's `SECURITY DEFINER`, granted to `anon`, `authenticated`, and `service_role` — most per-table policies (e.g. `revisions`, see `20260216154500_add_revisions_rls_policies.sql`) just call `has_project_access(project_id)` rather than re-implementing the access logic per table. `project_secrets` (`20260620000000`) is a rare exception that inlines its own project-ownership/editor check instead of using the shared helper.

## Gaps / not verified in this pass

- No single migration shows `agent_runs`' full current column set — it's additive across 6+ files, listed above by name only.
- Did not check whether the Postgres `vector`/pgvector extension or any embedding-storage table exists here (the app-builder has a per-project vector KB per `agentLoopService.ts`'s `retrieveRelevantFiles` — its storage location wasn't traced in this pass; check `server/src/knowledgebase/vectorStore.ts` if that matters for your task).
- Billing table columns (`plan_tiers`, `subscriptions`, etc.) not enumerated here — covered from the service-layer side in `docs/settings.md`.
- **Real, unaddressed gap (2026-08 security audit, Domain 5):** the tenant-schema tracking above (`supabase_migrations.schema_migrations`) is for the *platform's own* Postgres schema only. Per-tenant database schemas (one per provisioned project, `server/src/services/database.service.ts`) have no migration/versioning system at all — tenant DDL arrives ad hoc via the agent's `runQuery(role='service')` tool call, with no per-tenant version ledger, no rollback path, and no way to know a given tenant schema's actual current state without inspecting it directly. Implementing real tenant-schema versioning (e.g. a `tenant_schema_migrations` table per schema, or a shared ledger keyed by `schema_name`) is a real feature, not a quick fix — flagged here rather than attempted as part of a cleanup pass.
