-- =============================================================================
-- Stability hardening (June 2026)
--   1. Pin search_path on sync_org_plan_limits() (mutable search_path warning)
--   2. Recover jobs stuck in 'processing' (process-job catch never set 'failed')
-- =============================================================================

-- ── 1. Re-declare trigger function with an immutable search_path ──────────────
-- The function only mutates NEW (no privileged table access), so SECURITY
-- DEFINER is not needed; pinning search_path silences the linter and prevents
-- search_path hijacking.
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  CASE NEW.plan_tier::text
    WHEN 'free' THEN
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 4000;
    WHEN 'pro' THEN
      NEW.seats_total   := 5;
      NEW.max_projects  := 2147483647;   -- unlimited (INT max)
      NEW.ai_gens_limit := 1000000;
    WHEN 'agency' THEN
      NEW.seats_total   := 20;
      NEW.max_projects  := 2147483647;
      NEW.ai_gens_limit := 1000000;
    -- legacy values — treat like their migration target
    WHEN 'starter' THEN
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 4000;
    WHEN 'professional' THEN
      NEW.seats_total   := 5;
      NEW.max_projects  := 2147483647;
      NEW.ai_gens_limit := 1000000;
    WHEN 'enterprise' THEN
      NEW.seats_total   := 20;
      NEW.max_projects  := 2147483647;
      NEW.ai_gens_limit := 1000000;
    ELSE
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 4000;
  END CASE;
  RETURN NEW;
END;
$$;

-- ── 2. Recover stuck jobs ────────────────────────────────────────────────────
-- Jobs that entered 'processing' before the catch-block fix could never leave
-- that state. Mark anything stuck for >15 minutes as failed so it can be retried.
UPDATE public.jobs
SET status = 'failed',
    result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('error', 'Recovered: stuck in processing'),
    updated_at = now()
WHERE status = 'processing'
  AND updated_at < now() - interval '15 minutes';
