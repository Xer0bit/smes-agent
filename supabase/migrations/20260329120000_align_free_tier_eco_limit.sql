-- Align free-tier eco limit to 4,000 across DB, trigger, and frontend.
--
-- Problem: sync_org_plan_limits trigger and the column DEFAULT both used 2,000
-- for free tier, while UsageContext.tsx normalizes it to 4,000 client-side.
-- This meant users were blocked by the DB function at 2,000 even though the
-- UI showed 4,000 remaining.
--
-- Fix: set the canonical limit to 4,000 everywhere.

-- 1. Update the sync_org_plan_limits trigger function
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  CASE NEW.plan_tier
    WHEN 'free'         THEN NEW.seats_total := 1;      NEW.max_projects := 1;      NEW.ai_gens_limit := 4000;
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

-- 2. Update the column DEFAULT for new rows
ALTER TABLE public.organizations
  ALTER COLUMN ai_gens_limit SET DEFAULT 4000;

-- 3. Back-fill existing free-tier orgs that are still capped at 2,000
UPDATE public.organizations
  SET ai_gens_limit = 4000
  WHERE plan_tier = 'free'
    AND ai_gens_limit = 2000;
