-- Phase 2/3 agent-loop telemetry (stuck-loop reason, auto-continue flag,
-- SEARCH-miss/circuit-breaker counters) and the shared circuit-breaker table
-- for multi-instance gen serving. Already applied by hand to production and
-- local dev on 2026-08-04; this migration exists so a fresh environment
-- (local reset, disaster recovery, a new dev machine) gets the same schema
-- automatically instead of agent_runs updates silently failing.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS stuck_abort_reason text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS needs_auto_continue boolean;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS edit_search_miss_count integer DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS build_error_circuit_break_count integer DEFAULT 0;

CREATE TABLE IF NOT EXISTS build_error_breaker (
  project_id text PRIMARY KEY,
  signature text NOT NULL,
  hit_count integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE build_error_breaker ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service-role access only, no anon/authenticated
-- access needed (internal circuit-breaker state, not user-facing data).
