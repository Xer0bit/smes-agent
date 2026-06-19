-- =============================================================================
-- Fix: infinite recursion in RLS policies for relation "projects"
--
-- Root cause (recursive cycle):
--   1. Query projects → applies "Role-based project access" policy
--      → that policy does: id IN (SELECT project_id FROM project_member_access ...)
--   2. Query project_member_access → applies "Admins manage project access" policy
--      → that policy does: project_id IN (SELECT p.id FROM projects p JOIN org_members ...)
--   3. Back to step 1 → infinite recursion
--
-- Fix: break the cycle by using a SECURITY DEFINER helper to look up a
-- project's organization_id without triggering RLS on projects.
-- SECURITY DEFINER functions owned by postgres (superuser) bypass RLS.
-- =============================================================================

-- ─── 1. Helper: get org_id for a project, bypassing RLS ─────────────────────
CREATE OR REPLACE FUNCTION public.get_project_org_id(p_project_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT organization_id FROM projects WHERE id = p_project_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_project_org_id(UUID) TO authenticated, anon, service_role;

-- ─── 2. Fix project_member_access admin policy ───────────────────────────────
-- Old policy queried projects → caused recursion.
-- New policy uses get_project_org_id() (SECURITY DEFINER, bypasses projects RLS).

DROP POLICY IF EXISTS "Admins manage project access" ON project_member_access;

CREATE POLICY "Admins manage project access" ON project_member_access
    FOR ALL USING (
        -- Users can always see/modify their own access entries
        user_id = auth.uid()
        -- Org admins can manage assignments for projects in their org
        -- Uses SECURITY DEFINER helper to avoid re-entering projects RLS
        OR EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.org_id = public.get_project_org_id(project_id)
              AND om.user_id = auth.uid()
              AND om.role = 'admin'
        )
    );

-- ─── 3. Also fix storage RLS if it queries projects (causes storage 500s) ────
-- Storage policies that use has_project_access() are fine because
-- has_project_access is already SECURITY DEFINER.
-- But ensure the function is up to date (allow any org member):
CREATE OR REPLACE FUNCTION public.has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        -- Project creator/owner
        SELECT 1 FROM projects p
        WHERE p.id = p_project_id
          AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
    )
    OR EXISTS (
        -- Any org member (admin or regular)
        SELECT 1 FROM projects p
        JOIN org_members om ON om.org_id = p.organization_id
        WHERE p.id = p_project_id
          AND om.user_id = auth.uid()
    )
    OR EXISTS (
        -- Explicitly assigned via project_member_access
        SELECT 1 FROM project_member_access pma
        WHERE pma.project_id = p_project_id
          AND pma.user_id = auth.uid()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_project_access(UUID) TO authenticated, anon, service_role;
