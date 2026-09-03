-- Drop dead / superseded agent + logging schema (Category A of the
-- 2026-09-01 DB schema-usage audit; see docs/design/db-schema-usage-audit.md).
--
-- These 15 tables are queried by NO application or edge-function code and are
-- superseded by the live run-state path: agent_runs (status), agent_run_effects
-- (effect ledger), and the actual streaming loop. Verified self-contained: no
-- inbound foreign key from any WIRED table points at them (only intra-cluster
-- refs), so dropping the group breaks nothing live. CASCADE removes each
-- table's own dependent views, triggers, and FK constraints. A handful of
-- standalone plpgsql functions reference these tables by name in their bodies;
-- those are late-bound (not hard dependencies), so the drop proceeds and they
-- become inert — a follow-up DROP FUNCTION sweep can remove them later.
--
-- NOT YET APPLIED. This runs against the PRODUCTION control-plane database and
-- deletes any historical rows these tables hold (the *_logs tables in
-- particular). Review, then apply only via the normal migration + deploy path
-- with explicit go-ahead. There is no automatic rollback — restore from backup.

BEGIN;

-- Order: referrers before referents (CASCADE makes order moot, but explicit is clearer).
DROP TABLE IF EXISTS public.agent_run_events        CASCADE;  -- FK -> agent_run_jobs
DROP TABLE IF EXISTS public.agent_run_jobs          CASCADE;  -- unwired run-queue design (audit gap D9)

DROP TABLE IF EXISTS public.agent_chats             CASCADE;  -- FK -> ai_agents
DROP TABLE IF EXISTS public.agent_task_logs         CASCADE;  -- FK -> ai_agents
DROP TABLE IF EXISTS public.ai_agent_cron           CASCADE;  -- FK -> ai_agents
DROP TABLE IF EXISTS public.ai_agents               CASCADE;  -- legacy "AI agents" product surface, unwired

DROP TABLE IF EXISTS public.project_agent_skills    CASCADE;
DROP TABLE IF EXISTS public.agent_skill_templates   CASCADE;
DROP TABLE IF EXISTS public.project_chat_history    CASCADE;

DROP TABLE IF EXISTS public.build_error_breaker     CASCADE;
DROP TABLE IF EXISTS public.generate_app_idempotency CASCADE;

-- Logging tables: superseded, written by no current code. Dropping deletes
-- historical rows (audit/analytics history) — intended, per the audit.
DROP TABLE IF EXISTS public.generation_logs         CASCADE;
DROP TABLE IF EXISTS public.build_logs              CASCADE;
DROP TABLE IF EXISTS public.error_logs              CASCADE;
DROP TABLE IF EXISTS public.api_usage_logs          CASCADE;

COMMIT;
