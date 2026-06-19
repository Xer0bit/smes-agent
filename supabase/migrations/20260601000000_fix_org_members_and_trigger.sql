-- Fix 1: Backfill missing org_members rows for org creators
-- Orgs created via admin panel or direct DB inserts skip the membership row.
-- Without a membership row the RLS idempotency guard can incorrectly provision
-- a second org, and the OrganizationContext can't reliably find these orgs.
INSERT INTO public.org_members (org_id, user_id, role)
SELECT o.id, o.created_by, 'admin'
FROM public.organizations o
WHERE o.created_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.org_members om
    WHERE om.org_id = o.id
      AND om.user_id = o.created_by
  )
ON CONFLICT DO NOTHING;

-- Fix 2: Trigger – automatically add org creator as admin member on every new org
-- This ensures the membership row is ALWAYS present, even for admin-panel-created orgs.
CREATE OR REPLACE FUNCTION public.auto_add_org_creator_to_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'admin')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_add_org_creator ON public.organizations;
CREATE TRIGGER trg_auto_add_org_creator
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  WHEN (NEW.created_by IS NOT NULL)
  EXECUTE FUNCTION public.auto_add_org_creator_to_members();
