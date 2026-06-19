-- =============================================================================
-- Migration: Token quotas with 24-hour reset
-- - Free organizations: 2,000 tokens / 24h
-- - Paid organizations (starter/professional/enterprise): 1,000,000 tokens / 24h
-- - increment_ai_gen now supports token increments
-- =============================================================================

-- Keep plan limits in sync whenever plan_tier changes.
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  CASE NEW.plan_tier
    WHEN 'free'         THEN NEW.seats_total := 1;      NEW.max_projects := 1;      NEW.ai_gens_limit := 2000;
    WHEN 'starter'      THEN NEW.seats_total := 3;      NEW.max_projects := 5;      NEW.ai_gens_limit := 1000000;
    WHEN 'professional' THEN NEW.seats_total := 10;     NEW.max_projects := 999999; NEW.ai_gens_limit := 1000000;
    WHEN 'enterprise'   THEN NEW.seats_total := 999999; NEW.max_projects := 999999; NEW.ai_gens_limit := 1000000;
    ELSE NULL;
  END CASE;

  IF NEW.ai_gens_reset_at IS NULL THEN
    NEW.ai_gens_reset_at := NOW() + INTERVAL '24 hours';
  END IF;

  RETURN NEW;
END;
$$;

-- Defaults for newly-created rows.
ALTER TABLE public.organizations
  ALTER COLUMN ai_gens_limit SET DEFAULT 2000,
  ALTER COLUMN ai_gens_reset_at SET DEFAULT (NOW() + INTERVAL '24 hours');

-- Backfill limits/reset windows for existing organizations.
UPDATE public.organizations
SET
  ai_gens_limit = CASE
    WHEN plan_tier = 'free' THEN 2000
    ELSE 1000000
  END,
  ai_gens_reset_at = NOW() + INTERVAL '24 hours'
WHERE
  ai_gens_limit IS DISTINCT FROM CASE
    WHEN plan_tier = 'free' THEN 2000
    ELSE 1000000
  END
  OR ai_gens_reset_at IS NULL;

-- Token-based increment function.
CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID, p_tokens INTEGER DEFAULT 1)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  INTEGER;
  v_used   INTEGER;
  v_reset  TIMESTAMPTZ;
  v_tokens INTEGER;
BEGIN
  v_tokens := GREATEST(COALESCE(p_tokens, 0), 0);

  IF v_tokens = 0 THEN
    RETURN TRUE;
  END IF;

  SELECT ai_gens_limit, ai_gens_used, ai_gens_reset_at
    INTO v_limit, v_used, v_reset
    FROM public.organizations
    WHERE id = p_org_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Reset counter when rolling 24-hour window expires.
  IF v_reset IS NOT NULL AND NOW() >= v_reset THEN
    UPDATE public.organizations
      SET ai_gens_used = 0,
          ai_gens_reset_at = NOW() + INTERVAL '24 hours'
      WHERE id = p_org_id;
    v_used := 0;
  ELSIF v_reset IS NULL THEN
    UPDATE public.organizations
      SET ai_gens_reset_at = NOW() + INTERVAL '24 hours'
      WHERE id = p_org_id;
  END IF;

  IF v_used + v_tokens > v_limit THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations
  SET ai_gens_used = ai_gens_used + v_tokens
  WHERE id = p_org_id;

  RETURN TRUE;
END;
$$;

-- Backward-compatible wrapper for old callers.
CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.increment_ai_gen(p_org_id, 1);
$$;

GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID) TO authenticated;
