-- Enhanced telemetry columns for agent_runs: cost routing tier, model, and
-- per-run token breakdown. Used by the agent loop to record what each run cost.
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS request_tier        text,           -- micro/fix/edit/feature/build
  ADD COLUMN IF NOT EXISTS model_used          text,           -- e.g. claude-sonnet-4-6
  ADD COLUMN IF NOT EXISTS estimated_cost_usd  numeric(10,6),  -- e.g. 0.000450
  ADD COLUMN IF NOT EXISTS input_tokens        integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens       integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens   integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_write_tokens  integer DEFAULT 0;
