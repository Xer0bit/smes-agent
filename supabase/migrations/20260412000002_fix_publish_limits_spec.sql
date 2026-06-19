-- Restore publish limits to match the product spec:
--   Free org member : 30 publishes/month
--   Pro             : 100 publishes/month
--   Agency          : 100 publishes/month
--
-- The previous migration (20260412000001) set limits to 1000/999999
-- because we were counting source-code lines per publish.
-- We now count each publish action as 1, so the spec numbers apply directly.

UPDATE organizations
SET publish_lines_limit = CASE plan_tier::text
  WHEN 'free'           THEN 30
  WHEN 'starter'        THEN 30
  WHEN 'pro'            THEN 100
  WHEN 'professional'   THEN 100
  WHEN 'agency'         THEN 100
  WHEN 'enterprise'     THEN 100
  ELSE 30
END,
-- Reset the used counter for everyone so no one is already over-limit
publish_lines_used = 0;

-- Rebuild the sync trigger with correct per-spec limits.
CREATE OR REPLACE FUNCTION sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  CASE NEW.plan_tier::text
    WHEN 'free' THEN
      NEW.publish_lines_limit := 30;
    WHEN 'starter' THEN
      NEW.publish_lines_limit := 30;
    WHEN 'pro' THEN
      NEW.publish_lines_limit := 100;
    WHEN 'professional' THEN
      NEW.publish_lines_limit := 100;
    WHEN 'agency' THEN
      NEW.publish_lines_limit := 100;
    WHEN 'enterprise' THEN
      NEW.publish_lines_limit := 100;
    ELSE
      NEW.publish_lines_limit := 30;
  END CASE;
  RETURN NEW;
END;
$$;
