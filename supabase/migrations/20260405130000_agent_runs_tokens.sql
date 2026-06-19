-- Add tokens_used column to agent_runs
-- Tracks total token consumption per agent loop run.
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS tokens_used integer DEFAULT 0;

COMMENT ON COLUMN public.agent_runs.tokens_used IS 'Total LLM tokens consumed across all steps in this agent run.';
