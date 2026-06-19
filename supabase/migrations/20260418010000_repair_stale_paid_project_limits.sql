-- Repair organizations that still carry the free-tier project cap even though
-- their plan tier is already a paid tier. These stale rows cause the client to
-- show errors like "1 project limit on the Professional plan".

UPDATE public.organizations
SET max_projects = CASE plan_tier::text
  WHEN 'starter' THEN 5
  WHEN 'professional' THEN 999999
  WHEN 'enterprise' THEN 999999
  WHEN 'pro' THEN 999999
  WHEN 'agency' THEN 999999
  ELSE max_projects
END
WHERE plan_tier::text IN ('starter', 'professional', 'enterprise', 'pro', 'agency')
  AND COALESCE(max_projects, 0) <= 1;