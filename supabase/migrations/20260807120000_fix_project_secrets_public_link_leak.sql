-- Fix: project_secrets policies use has_project_access(project_id), but that
-- function was later extended (20260404000006_rls_permissions_update.sql) to
-- return TRUE for ANY caller -- including anonymous/anon-role requests --
-- when the project is a public share link (status='active' AND
-- visibility='org_all'). That bypass is correct for projects/revisions (the
-- public-preview feature), but project_secrets stores plaintext API
-- keys/tokens and must NEVER be reachable through a public share link.
--
-- Confirmed live against a local fixture: an anon-role SELECT against
-- project_secrets for a public (org_all/active) project returned the
-- plaintext key_value with zero authentication. This migration closes that
-- without touching has_project_access() itself (other tables' public-link
-- behavior is intentional and must not regress).

CREATE OR REPLACE FUNCTION public.has_project_secrets_access(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project projects%ROWTYPE;
  v_uid     uuid := auth.uid();
BEGIN
  -- No bypass for unauthenticated callers, ever -- unlike has_project_access().
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role IN ('super_admin','admin')
  ) THEN RETURN true; END IF;

  IF v_project.created_by = v_uid OR v_project.user_id = v_uid THEN
    RETURN true;
  END IF;

  IF v_project.organization_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.org_members
      WHERE org_id = v_project.organization_id
        AND user_id = v_uid
        AND role IN ('admin','billing_admin')
    ) THEN RETURN true; END IF;

    IF EXISTS (
      SELECT 1 FROM public.project_member_access
      WHERE project_id = p_project_id AND user_id = v_uid
    ) THEN RETURN true; END IF;
  END IF;

  -- Intentionally NO public/org_all share-link clause here.
  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_project_secrets_access(uuid) TO authenticated;
-- Deliberately NOT granted to anon -- secrets access always requires a real session.

DROP POLICY IF EXISTS "project_secrets_select" ON public.project_secrets;
DROP POLICY IF EXISTS "project_secrets_insert" ON public.project_secrets;
DROP POLICY IF EXISTS "project_secrets_update" ON public.project_secrets;
DROP POLICY IF EXISTS "project_secrets_delete" ON public.project_secrets;

CREATE POLICY "project_secrets_select" ON public.project_secrets
  FOR SELECT USING (public.has_project_secrets_access(project_id));

CREATE POLICY "project_secrets_insert" ON public.project_secrets
  FOR INSERT WITH CHECK (public.has_project_secrets_access(project_id));

CREATE POLICY "project_secrets_update" ON public.project_secrets
  FOR UPDATE USING (public.has_project_secrets_access(project_id))
  WITH CHECK (public.has_project_secrets_access(project_id));

CREATE POLICY "project_secrets_delete" ON public.project_secrets
  FOR DELETE USING (public.has_project_secrets_access(project_id));
