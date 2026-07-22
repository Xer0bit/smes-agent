-- =============================================================================
-- Agent runs: cost attribution gap (rebuild plan Task 3.1, lean scope)
-- agent_runs already tracks run-level tokens/cost for the main loop, but:
--   (a) has no org_id/is_internal, so internal dogfooding can't be excluded
--       from cost/abort aggregates (see organizations.is_internal, migration
--       20260721090000);
--   (b) the vision pre-analysis call (agentVision.ts) and the narration
--       status-line call (narration.service.ts) run on their own LLM calls
--       that were never folded into the run's cost   this is most of the
--       53% invoice/ledger gap found in the 2026-07-21 audit.
-- Vision cost gets folded directly into the existing input/output/cost
-- columns (it runs on the same model as the main loop). Narration runs on
-- its own, separately-chosen cheap model, so it gets its own column.
-- =============================================================================

ALTER TABLE public.agent_runs
    ADD COLUMN IF NOT EXISTS organization_id    uuid REFERENCES public.organizations(id),
    ADD COLUMN IF NOT EXISTS is_internal         boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS narration_cost_usd  numeric(10,5) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_runs_org_internal
    ON public.agent_runs(organization_id, is_internal, created_at DESC);

COMMENT ON COLUMN public.agent_runs.narration_cost_usd IS
    'Cost of the separate status-narration LLM calls for this run (own model choice, not foldable into the main loop''s input/output/cost columns).';
