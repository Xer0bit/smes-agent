-- =============================================================================
-- Fix infinite recursion in projects SELECT RLS policy (42P17)
--
-- Root cause:
--   projects_select policy queries project_member_access
--   project_member_access "project_owner_manage_member_access" policy calls
--   is_project_owner_or_creator() which queries projects → loop
--
-- Fix: add a SECURITY DEFINER helper that reads project_member_access
-- without going through RLS (bypasses the loop on both sides).
-- =============================================================================

-- Helper: check if current user has explicit access in project_member_access
-- SECURITY DEFINER bypasses RLS on project_member_access, breaking the loop.
CREATE OR REPLACE FUNCTION public.user_has_project_member_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_member_access
    WHERE project_id = p_project_id
      AND user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_has_project_member_access(UUID)
TO authenticated, anon, service_role;

-- Helper: check if current user is an org admin for a given org
-- SECURITY DEFINER bypasses any RLS on org_members too.
CREATE OR REPLACE FUNCTION public.user_is_org_admin(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.org_members
    WHERE org_id = p_org_id
      AND user_id = auth.uid()
      AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_is_org_admin(UUID)
TO authenticated, anon, service_role;

-- Drop all old stale policies (not cleaned up by prior migrations) that contain
-- inline subqueries on project_member_access causing the recursion chain.
DROP POLICY IF EXISTS "Role-based project access" ON public.projects;
DROP POLICY IF EXISTS "Users can update projects"  ON public.projects;
DROP POLICY IF EXISTS "Users can create projects"  ON public.projects;
DROP POLICY IF EXISTS "Admins can delete projects" ON public.projects;

-- Replace the projects_select policy to use SECURITY DEFINER helpers
-- instead of inline subqueries that cause recursion.
DROP POLICY IF EXISTS "projects_select" ON public.projects;

CREATE POLICY "projects_select" ON public.projects
    FOR SELECT USING (
        -- own project
        user_id = auth.uid()
        OR created_by = auth.uid()
        -- org admin sees all projects in their org
        OR (organization_id IS NOT NULL AND public.user_is_org_admin(organization_id))
        -- explicitly assigned member (non-recursive via SECURITY DEFINER)
        OR public.user_has_project_member_access(id)
        -- platform super_admin only
        OR public.get_my_role() = 'super_admin'
    );
