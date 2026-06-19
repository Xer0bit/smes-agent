-- Fix has_project_access to allow any org member (not just admin) to access projects
CREATE OR REPLACE FUNCTION public.has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = p_project_id
          AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
    )
    OR EXISTS (
        SELECT 1 FROM projects p
        JOIN org_members om ON om.org_id = p.organization_id
        WHERE p.id = p_project_id
          AND om.user_id = auth.uid()
    )
    OR EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p_project_id
          AND pm.user_id = auth.uid()
    );
END;
$$;
