-- Enforce monthly eco policy:
--   free: 10 eco / month
--   paid tiers (starter/professional/enterprise + legacy pro/agency): 100 eco / month

-- Keep tier limits synchronized for both new and updated organizations.
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  CASE NEW.plan_tier
    WHEN 'free'         THEN NEW.seats_total := 1;      NEW.max_projects := 1;      NEW.ai_gens_limit := 10;
    WHEN 'starter'      THEN NEW.seats_total := 3;      NEW.max_projects := 5;      NEW.ai_gens_limit := 100;
    WHEN 'professional' THEN NEW.seats_total := 10;     NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
    WHEN 'enterprise'   THEN NEW.seats_total := 999999; NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
    -- legacy aliases kept for backward compatibility
    WHEN 'pro'          THEN NEW.seats_total := 10;     NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
    WHEN 'agency'       THEN NEW.seats_total := 999999; NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
    ELSE NULL;
  END CASE;

  IF NEW.ai_gens_reset_at IS NULL THEN
    NEW.ai_gens_reset_at := NOW() + INTERVAL '30 days';
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure default reset window is monthly.
ALTER TABLE public.organizations
  ALTER COLUMN ai_gens_reset_at SET DEFAULT (NOW() + INTERVAL '30 days');

-- Apply new limits to existing organizations.
UPDATE public.organizations
SET ai_gens_limit = CASE
  WHEN plan_tier = 'free' THEN 10
  ELSE 100
END;

-- Recreate request counter to use monthly reset window.
CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID, p_tokens NUMERIC DEFAULT 1)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  NUMERIC;
  v_used   NUMERIC;
  v_reset  TIMESTAMPTZ;
  v_tokens NUMERIC;
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

  -- Reset counter when rolling 30-day window expires.
  IF v_reset IS NOT NULL AND NOW() >= v_reset THEN
    UPDATE public.organizations
      SET ai_gens_used = 0,
          ai_gens_reset_at = NOW() + INTERVAL '30 days'
      WHERE id = p_org_id;
    v_used := 0;
  ELSIF v_reset IS NULL THEN
    UPDATE public.organizations
      SET ai_gens_reset_at = NOW() + INTERVAL '30 days'
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

CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.increment_ai_gen(p_org_id, 1::NUMERIC);
$$;

GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID) TO authenticated;
