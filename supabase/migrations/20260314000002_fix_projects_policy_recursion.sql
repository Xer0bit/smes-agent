-- =============================================================================
-- Fix infinite recursion between projects and project_member_access RLS
--
-- Recursion chain:
-- projects SELECT policy -> references project_member_access
-- project_member_access owner policy -> referenced projects directly
--
-- Break the loop by using SECURITY DEFINER helper that checks ownership
-- without re-entering projects RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_project_owner_or_creator(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.projects p
        WHERE p.id = p_project_id
          AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_project_owner_or_creator(UUID)
TO authenticated, anon, service_role;

DROP POLICY IF EXISTS "project_owner_manage_member_access" ON public.project_member_access;

CREATE POLICY "project_owner_manage_member_access"
ON public.project_member_access
FOR ALL
USING (
    public.is_project_owner_or_creator(project_member_access.project_id)
)
WITH CHECK (
    public.is_project_owner_or_creator(project_member_access.project_id)
);
