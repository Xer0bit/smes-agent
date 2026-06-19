-- Fix: sync_org_plan_limits trigger should only override ai_gens_limit
-- when plan_tier actually changes (or on INSERT). This allows admins to
-- set custom eco limits without them being reverted on every row update.

CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Only sync tier-derived fields when plan_tier changes or on INSERT
  IF TG_OP = 'INSERT' OR OLD.plan_tier IS DISTINCT FROM NEW.plan_tier THEN
    CASE NEW.plan_tier
      WHEN 'free'         THEN NEW.seats_total := 1;      NEW.max_projects := 1;      NEW.ai_gens_limit := 10;
      WHEN 'starter'      THEN NEW.seats_total := 3;      NEW.max_projects := 5;      NEW.ai_gens_limit := 100;
      WHEN 'professional' THEN NEW.seats_total := 10;     NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
      WHEN 'enterprise'   THEN NEW.seats_total := 999999; NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
      WHEN 'pro'          THEN NEW.seats_total := 10;     NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
      WHEN 'agency'       THEN NEW.seats_total := 999999; NEW.max_projects := 999999; NEW.ai_gens_limit := 100;
      ELSE NULL;
    END CASE;
  END IF;

  IF NEW.ai_gens_reset_at IS NULL THEN
    NEW.ai_gens_reset_at := NOW() + INTERVAL '30 days';
  END IF;

  RETURN NEW;
END;
$$;
