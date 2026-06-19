-- =============================================================================
-- Fix: ensure org creator is always 'admin' in org_members.
-- Root cause: signup flow set created_by user as 'member' instead of 'admin'.
-- =============================================================================

-- 1. Promote any org creator who is currently a non-admin member to admin.
UPDATE public.org_members om
SET role = 'admin'
FROM public.organizations o
WHERE o.id = om.org_id
  AND o.created_by = om.user_id
  AND om.role != 'admin';

-- 2. Update the org_invitations INSERT/ALL policy to also allow the org creator,
--    in case they were never added to org_members as admin.
DROP POLICY IF EXISTS "Admins can manage invitations" ON public.org_invitations;

CREATE POLICY "Admins can manage invitations" ON public.org_invitations
    FOR ALL
    USING (
        org_id IN (
            SELECT org_id FROM public.org_members
            WHERE user_id = auth.uid()
              AND role IN ('admin', 'billing_admin')
        )
        OR org_id IN (
            SELECT id FROM public.organizations
            WHERE created_by = auth.uid()
        )
    );
