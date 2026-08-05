# Settings System

Three distinct "settings" surfaces exist in this codebase. Don't conflate them:

1. **Project settings** (per-project: secrets, domains, git, knowledge base) — `src/components/referral/settings/`
2. **Plan/tier configuration** (product policy: what free/pro/agency unlock) — `server/src/services/tier-config.service.ts`
3. **System-wide LLM/model config** (which model, which API keys, admin-only) — `server/src/services/llm-control.service.ts`

All UI panels are tabs inside one dialog, not separate pages.

## 1. Settings UI (`src/components/referral/settings/`)

`SettingsDialog.tsx` + `SettingsSidebar.tsx` + `SettingsContent.tsx` render a tabbed dialog with three sections (see `SettingsSidebar.tsx`):

- **Project**: `project-settings`, `project-seo` (badge: hot), `project-domains` (gated by `hosting` feature), `integrations` (hub), `ecg-customizer` (only if `isEcgProject`), `project-collaborators` (gated by `invite_editors`), `project-knowledge` (gated by `knowledge_base`), `project-git`, `project-secrets`
- **Platform** (admin-facing): `ecomgear-database`, `ecomgear-functions`, `ecomgear-llm` (currently `disabled: true` in the sidebar config), plus a China-market group (`integrations-china`, `china-icp`, `china-qq` disabled, `china-iamsmart` disabled)
- **Account/Workspace**: `workspace-plans` (Plan & Usage), `workspace-referrals`, `workspace-api-access` (gated by `api_access`, disabled), `workspace-white-label` (gated by `remove_branding`, disabled)

Tabs carry a `featureKey` that's checked against the org's tier features (section 2) to show/hide or disable — this is the actual gating mechanism, not a separate permissions system.

Components: `SecretsSettings.tsx`, `DatabaseSettings.tsx`, `EdgeFunctionsSettings.tsx`, `DomainSettings.tsx`, `GitHubSettings.tsx`, `IntegrationsSettings.tsx`, `KnowledgeSettings.tsx`, `CollaboratorManager.tsx`, `RedirectSettings.tsx`, `CustomizerSettings.tsx`, `HeaderIntegrationsSettings.tsx`, `OrganizationBillingContent.tsx`, `PlanUsageContent.tsx`, `StripeSettingsContent.tsx`, `ZapierSettingsContent.tsx`, `ReferralContent.tsx`, `ICPFilingForm.tsx`.

## 2. Project secrets (`project_secrets` table)

Storage is **plaintext**, not a Supabase Vault or KMS-backed secret store: `set_secret.ts` upserts into `project_secrets(project_id, key_name, key_value, key_preview)` via `onConflict: 'project_id,key_name'`. `key_preview` is a masked `****<last4>` shown in the UI; `key_value` is the real value, readable by anyone with DB access.

Flow (`server/src/agent-tools/set_secret.ts`):
- The agent tool validates `key_name` into `UPPER_SNAKE_CASE` (letters/digits/underscore only, must start with letter/underscore).
- A `VITE_`-prefixed name is readable from frontend code (`import.meta.env.VITE_X`); an unprefixed name is server-only / edge-function-only (`secrets.KEY_NAME` inside a written edge function).
- After saving, the tool pushes the **full current secret set** for the project to the live preview service so it's usable immediately as `import.meta.env.KEY_NAME` — Vite only reads `.env.local` at startup, so the preview-service endpoint is asked to restart the dev server to pick up the change.
- The tool's own description explicitly forbids echoing/logging the secret value back to the user or model output.
- `list_secrets.ts` is the read counterpart (not fully read in this pass, but is the tool the agent is told to call before asking a user to repeat a value they've already set).
- `SecretsSettings.tsx` (UI) deletes rows directly via `supabase.from('project_secrets').delete().eq('id', id)` — i.e. the settings UI talks to Supabase directly for deletes, not through a server route.

**Gap flagged**: no encryption-at-rest layer was found for `key_value` in this pass — only DB-level access control (whatever RLS exists on `project_secrets`, not verified here — see `docs/database.md`) protects it.

## 3. Plan/tier configuration (`tier-config.service.ts`)

Three tiers: `free`, `pro`, `agency`. Config is a single `TierConfig` object persisted in the **`system_settings`** table (not per-org — one global tier policy for the whole platform) and merged over a hardcoded `DEFAULT_CONFIG` at load.

`TierFeatures` (18 boolean flags per tier) — the actual current defaults in code:

| Feature | free | pro | agency |
|---|---|---|---|
| custom_domains | ✗ | ✓ | ✓ |
| remove_branding | ✗ | ✓ | ✓ |
| export_code | ✗ | ✓ | ✓ |
| analytics | ✗ | ✓ | ✓ |
| api_access | ✗ | ✓ | ✓ |
| invite_editors | ✗ | ✓ | ✓ |
| invite_clients | ✗ | ✗ | ✓ |
| ai_agent | ✓ | ✓ | ✓ |
| hosting | ✓ | ✓ | ✓ |
| ali_cloud | ✗ | ✓ | ✓ |
| ecomgear_cloud | ✗ | ✓ | ✓ |
| integration_app | ✗ | ✓ | ✓ |
| auto_pilot | ✗ | ✓ | ✓ |
| client_markup | ✗ | ✗ | ✓ |
| priority_support | ✗ | ✗ | ✓ |
| premium_templates | ✓ | ✓ | ✓ |
| sso | ✗ | ✗ | ✓ |
| sla | ✗ | ✗ | ✓ |

`TierLimits` (current defaults):

| Limit | free | pro | agency |
|---|---|---|---|
| ai_gens_limit | 10 | 100 | 100 |
| publish_lines_limit | 30 | 100 | 100 |
| seats_total | 1 | 5 | 20 |
| max_projects | 1 | 999999 (unlimited) | 999999 (unlimited) |

A `normalizeTierConfig()` pass enforces one hardcoded product-policy override on load: free-tier eco/AI-gen limit is pinned to 10/month regardless of what's persisted, paid tiers to 100/month (see the comment at the top of that function) — meaning this one number cannot actually be changed via whatever admin UI writes to `system_settings`, only the rest of the config can.

**Do not confuse this with the agent's per-request step-tier system** (`micro`/`fix`/`edit`/`feature`/`build` classified per-message in `intentClassifier.ts`, driving `MAX_STEPS` in `agentLoopService.ts`). That's a cost-control mechanism for a single agent run; `free`/`pro`/`agency` here is the subscription plan. Two unrelated "tier" concepts sharing a word.

## 4. Billing

Two separate Stripe surfaces exist — don't conflate them:

- **eComGear's own org/workspace billing** (`OrganizationBillingContent.tsx`, `PlanUsageContent.tsx`): checkout, customer portal, and payment setup all go through **Supabase Edge Functions**, not this Express server — `fetch(`${lovableCloudUrl}/functions/v1/org-create-checkout`)`, `.../org-customer-portal`, `.../org-setup-payment`. The `lovableCloudUrl` naming suggests this stack originates from/still uses a "Lovable Cloud" Supabase functions endpoint convention. These edge functions weren't read in this pass — their logic isn't in `server/src/`.
- **Per-project Stripe integration** (`StripeSettingsContent.tsx`, `server/src/routes/stripe.routes.ts`): a single route, `POST /:projectId/test`, which tests a **user-supplied** Stripe secret key for their own generated app (i.e. the app being built has its own Stripe integration, unrelated to eComGear's subscription billing).

## 5. System-wide LLM configuration (`llm-control.service.ts`)

Persisted in the same **`system_settings`** table (different key/row than tier config — not verified which distinguishes them without reading the full file, but they don't collide since tier-config and llm-control are separate service modules each doing their own `.from('system_settings')` read/write).

**Precedence is DB-persisted-over-env, not "env over DB"** (a prior note calling it "env > DB" is wrong — corrected here): on load, `mergeWithDefaults()` builds `defaults` from `process.env.*` (e.g. `AI_ANTHROPIC_API_KEY || ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `ZAI_API_KEY`, and `AI_MODEL`/`AI_FALLBACK_MODEL`/`FREE_TIER_MODEL` via `canonicalizeModelId`), then the merge is `persisted.apiKeys?.X || defaults.apiKeys.X` — **whatever's saved in the DB wins if present; env vars are only the fallback for keys/models never configured through the admin UI.**

After merging, `applyRuntimeEnv()` writes the resolved values straight back into `process.env` (e.g. `process.env.AI_ANTHROPIC_API_KEY = state.apiKeys.anthropic`) — so any other code in the process that reads `process.env.AI_ANTHROPIC_API_KEY` directly sees the DB-resolved value, not the raw env var, once this has run once. Also notable: setting the Gemini key additionally sets `GOOGLE_GENERATIVE_AI_API_KEY` (used by the KB vector store's embedding model) and resets a provider cache so the embedder switches off a `bm25` fallback once a real key is available.

Also stored/merged here: per-provider `enabled`/`fallbackEnabled` flags (`anthropic`, `deepseek`, `gemini`, `zai`), and the `allowed` model list (persisted list ∪ defaults, deduped, with `primary`/`fallback` guaranteed present).

Org-membership checks (`org_members`, `organizations` tables) also appear in this file — likely gating who can view/edit these platform-wide LLM settings — not traced further in this pass.

## 6. Env vars that are effectively system settings (`server/src/config/environment.ts`)

Static, deploy-time config (no DB override) — the difference from section 5 is these have **no admin UI and no `system_settings` merge**, they're read once from `process.env` with a hardcoded fallback:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | server port |
| `CORS_ORIGIN` | `http://localhost:3000` | CORS |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) / `SUPABASE_ANON_KEY` | — | DB client creds |
| `AI_MODEL` | `gemini-2.5-pro` | initial default model before `llm-control` DB override applies |
| `AI_MAX_TOKENS` | `8192` | |
| `REDIS_URL` | — | |
| `PREVIEW_BASE_URL` / `PREVIEW_CONTROL_URL` (or `PREVIEW_SERVICE_URL`) / `DOCKER_MANAGER_URL` | localhost defaults | preview infrastructure |
| `MAX_CONCURRENT_PREVIEWS` | `50` | |
| `PREVIEW_IDLE_TIMEOUT_MINUTES` | `15` | |
| `MAX_FILE_SIZE_MB` | `10` | |
| `MAX_PROJECTS_PER_USER` | `100` | a global cap, separate from the per-tier `max_projects` in section 3 |
| `ECG_AUTH_BASE_URL` / `ECG_AUTH_API_KEY` / `ECG_AUTH_2FA_ACTIVE` | — | external eCG auth integration |
| `LOG_LEVEL` | `info` | |

Note `MAX_PROJECTS_PER_USER` (env, global, 100) vs `max_projects` (per-tier limit, section 3, 1/unlimited/unlimited) — two different caps that could conflict; whichever code path checks first wins, not verified here.
