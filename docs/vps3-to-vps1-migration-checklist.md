# Task 2.1 — Migrate agent runner: VPS3 (USA) → VPS1 (Singapore)

Status: **inventory + prep complete. Cutover NOT started — needs explicit go-ahead per stage.**

## Why

Every agent step's DB/auth calls cross the Pacific (agent on VPS3-USA, Supabase on
VPS1-Singapore) on top of the LLM call itself. VPS3 also runs the whole gen
server on **1.9GB RAM** at its ceiling; VPS1 has 7.8GB at ~40% utilization.
Moving the agent next to its database removes a real, paid-for latency hop on
every single step of every run.

## What's already migration-safe (verified, no code change needed)

- **No hardcoded VPS3 IP anywhere in application code.** Grepped the full
  codebase for `3.148.126.20` and `gen.ecomgear.dev` — every real reference is
  either (a) driven by `VITE_GEN_SERVER_URL` with a domain-name fallback
  (`src/config/external-api.ts:63`), or (b) prompt text telling the *generated
  app* not to hardcode EcomGear's own domains (irrelevant to this migration).
  The domain `gen.ecomgear.dev` already decouples app code from which VPS
  physically serves it — this is a DNS + infra cutover, not a code change.
- **Node version:** `server/package.json` requires `>=20.0.0`. VPS3 runs
  v24.11.1; VPS1 already runs v20.19.5 — compatible, no upgrade needed.
- **No custom crontab / cron.d entries** on VPS3 beyond system defaults
  (certbot, e2scrub_all, sysstat) — nothing extra to replicate.

## Inventory (pulled live from VPS3, 2026-07-21)

**Env vars / secrets** (`.env.production`, values redacted):
```
NODE_ENV, PORT=5001, PREVIEW_SERVICE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, TENANT_DB_HOST, TENANT_DB_PORT,
TENANT_DB_SUPERUSER, TENANT_DB_SUPERUSER_PASSWORD, TENANT_DB_NAME,
TENANT_DB_JWT_SECRET, TENANT_DB_API_URL, TENANT_DB_SSL, TENANT_DB_RELOAD_URL,
TENANT_DB_RELOAD_SECRET, ZAI_API_KEY, GEMINI_API_KEY, AI_MODEL,
AI_FALLBACK_MODEL, AI_DISABLED_MODEL_IDS, ECG_PORTAL_URL, ECG_SERVICE_KEY,
ECOMGEAR_SERVER_URL, DASHBOARD_ACCESS_SECRET, FUNCTIONS_INTERNAL_SECRET
```
Note: no `ANTHROPIC_API_KEY` in this file — Anthropic (and other provider) keys
are admin-panel-managed via Supabase (`system_settings.llm_control`), not env.
Confirm that DB-stored config is reachable identically from VPS1 (it should
be — same Supabase instance) before cutover.

**PM2:** `ecomgear-gen`, cluster mode, 2 instances, no custom ecosystem quirks
found beyond standard cluster mode.

**Nginx** (`/etc/nginx/sites-enabled/ecomgear-gen`): serves `gen.ecomgear.dev`
and `agent.ecomgear.dev`, both proxying to `127.0.0.1:5001`. Has a
`preview_bridge` upstream hardcoded to VPS2's IP (`72.62.126.99:3001`) for
internal file-push calls — this reference is unaffected by the migration
(VPS2 isn't moving) and must be copied as-is into VPS1's new config.

**Firewall (ufw) — found something to flag separately, not part of this
migration:** VPS3 has ports `54321`, `54322`, `54323` open to the internet —
Supabase's default local-stack ports. VPS3 is the agent runner, not a Supabase
host; these look like a leftover from local testing and are worth a
follow-up look (not carried over to VPS1's firewall rules for this service).

## Migration checklist

- [ ] Confirm current admin-panel LLM key config resolves correctly when read
      from VPS1 (same Supabase project, should be a non-issue, but verify —
      first real check, cheap to do before anything else).
- [ ] Copy `.env.production` (above var list) to VPS1, in the gen-server's own
      directory (not merged into VPS1's existing frontend/API `.env` — keep
      the gen service's config file separate, same as it is on VPS3 today).
- [ ] rsync the gen-server codebase + `projects/` data dir to VPS1. Use
      `rsync -a --info=progress2` (or `cp -al` locally if same filesystem) to
      preserve hardlinks on the per-project `node_modules` — a naive copy
      could balloon disk usage well past what `du` reported (the `du -sh`
      command on VPS3 timed out at 2 minutes against this directory; get a
      real number with a longer timeout, or just rsync and watch VPS1's
      `df -h` live, before assuming disk headroom is fine).
- [ ] Install PM2 ecosystem on VPS1 for `ecomgear-gen`, cluster mode, 2
      instances (match VPS3), pointed at the copied `.env.production`.
- [ ] Add the new nginx server blocks to VPS1 for `gen.ecomgear.dev` /
      `agent.ecomgear.dev`, including the unchanged `preview_bridge` upstream
      to VPS2. Do NOT touch VPS1's existing `api.ecomgear.dev` /
      `www.ecomgear.dev` blocks.
- [ ] Run the smoke test (`scripts/smoke-test-gen-migration.sh`, below)
      against VPS1's new instance directly by IP/port before any DNS change.
- [ ] **Cutover point 1 (reversible):** point `gen.ecomgear.dev` DNS at VPS1.
      TTL-dependent propagation; VPS3 keeps running in parallel as fallback.
- [ ] Watch VPS1 logs for a full day of real traffic (per the plan's own
      cutover order) before touching VPS3.
- [ ] **Cutover point 2 (not reversible without redeploying):** decommission
      VPS3 — stop PM2, then only after confirming zero traffic for several
      days, cancel the instance.

## What I will not do without explicit go-ahead

Nothing above has been executed against production. Each checkbox is a
distinct action; the two marked "cutover point" are the ones with real blast
radius (DNS change affects live traffic; decommissioning VPS3 is hard to
undo). I'll do the earlier prep steps (copying files, standing up PM2/nginx
on VPS1 without traffic yet) on request, but will stop and confirm before
either cutover point.
