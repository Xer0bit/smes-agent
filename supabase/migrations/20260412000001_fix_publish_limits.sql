-- =============================================================================
-- Fix publish_lines_limit — values of 30/100 are far too low for real projects.
-- Pro/agency now get effectively unlimited (999999).
-- Free tier gets 1000 (enough for a couple small projects).
-- Also resets publish_lines_used to 0 for all paid orgs so they can publish.
-- =============================================================================

-- ── 1. Update existing rows ──────────────────────────────────────────────────
UPDATE public.organizations
SET
  publish_lines_limit = CASE plan_tier::text
                          WHEN 'free'         THEN 1000
                          WHEN 'starter'      THEN 1000
                          WHEN 'pro'          THEN 999999
                          WHEN 'professional' THEN 999999
                          WHEN 'agency'       THEN 999999
                          WHEN 'enterprise'   THEN 999999
                          ELSE 1000
                        END,
  -- Reset used counter for paid orgs so they can publish immediately
  publish_lines_used  = CASE WHEN plan_tier::text IN ('pro','professional','agency','enterprise')
                               THEN 0
                             ELSE publish_lines_used
                        END;

-- ── 2. Rebuild sync_org_plan_limits trigger with correct limits ──────────────
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  CASE NEW.plan_tier::text
    WHEN 'free' THEN
      NEW.seats_total         := 1;
      NEW.max_projects        := 1;
      NEW.ai_gens_limit       := 4000;
      NEW.publish_lines_limit := 1000;
    WHEN 'starter' THEN
      NEW.seats_total         := 1;
      NEW.max_projects        := 1;
      NEW.ai_gens_limit       := 4000;
      NEW.publish_lines_limit := 1000;
    WHEN 'pro' THEN
      NEW.seats_total         := 5;
      NEW.max_projects        := 2147483647;
      NEW.ai_gens_limit       := 1000000;
      NEW.publish_lines_limit := 999999;
    WHEN 'professional' THEN
      NEW.seats_total         := 5;
      NEW.max_projects        := 2147483647;
      NEW.ai_gens_limit       := 1000000;
      NEW.publish_lines_limit := 999999;
    WHEN 'agency' THEN
      NEW.seats_total         := 20;
      NEW.max_projects        := 2147483647;
      NEW.ai_gens_limit       := 1000000;
      NEW.publish_lines_limit := 999999;
    WHEN 'enterprise' THEN
      NEW.seats_total         := 20;
      NEW.max_projects        := 2147483647;
      NEW.ai_gens_limit       := 1000000;
      NEW.publish_lines_limit := 999999;
    ELSE
      NEW.seats_total         := 1;
      NEW.max_projects        := 1;
      NEW.ai_gens_limit       := 4000;
      NEW.publish_lines_limit := 1000;
  END CASE;
  RETURN NEW;
END;
$$;
