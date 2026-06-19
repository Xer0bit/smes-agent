-- Hotfix: enforce monthly eco policy after stability_hardening reset free tier to 4000.
-- Policy:
--   free: 10 eco / month
--   paid tiers (starter/professional/enterprise + legacy pro/agency): 100 eco / month

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
      NEW.ai_gens_limit := 10;
    WHEN 'starter' THEN
      NEW.seats_total   := 3;
      NEW.max_projects  := 5;
      NEW.ai_gens_limit := 100;
    WHEN 'professional' THEN
      NEW.seats_total   := 10;
      NEW.max_projects  := 999999;
      NEW.ai_gens_limit := 100;
    WHEN 'enterprise' THEN
      NEW.seats_total   := 999999;
      NEW.max_projects  := 999999;
      NEW.ai_gens_limit := 100;
    -- legacy aliases
    WHEN 'pro' THEN
      NEW.seats_total   := 10;
      NEW.max_projects  := 999999;
      NEW.ai_gens_limit := 100;
    WHEN 'agency' THEN
      NEW.seats_total   := 999999;
      NEW.max_projects  := 999999;
      NEW.ai_gens_limit := 100;
    ELSE
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 10;
  END CASE;

  IF NEW.ai_gens_reset_at IS NULL THEN
    NEW.ai_gens_reset_at := NOW() + INTERVAL '30 days';
  END IF;

  RETURN NEW;
END;
$$;

-- Repair existing org rows that inherited stale high limits.
UPDATE public.organizations
SET
  ai_gens_limit = CASE
    WHEN plan_tier::text = 'free' THEN 10
    ELSE 100
  END,
  ai_gens_reset_at = COALESCE(ai_gens_reset_at, NOW() + INTERVAL '30 days')
WHERE
  (plan_tier::text = 'free' AND ai_gens_limit <> 10)
  OR (plan_tier::text <> 'free' AND ai_gens_limit <> 100)
  OR ai_gens_reset_at IS NULL;
