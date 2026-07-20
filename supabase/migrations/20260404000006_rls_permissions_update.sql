-- =============================================================================
-- Phase 6: RLS + Permission Updates
-- - Update tier-based policies to reference pro/agency instead of
--   professional/enterprise
-- - Update has_project_access() to allow shared_view_public (no auth required)
-- =============================================================================

-- ── 1. Update has_project_access() for public/share_view_public links ─────────
-- Allows unauthenticated access to projects with a shared link (visibility='org_all'
-- + active status), and to project members via shared_view_public role.
CREATE OR REPLACE FUNCTION public.has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project projects%ROWTYPE;
  v_uid     uuid := auth.uid();
BEGIN
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Super-admins always have access
  IF v_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role IN ('super_admin','admin')
  ) THEN RETURN true; END IF;

  -- Project creator
  IF v_uid IS NOT NULL AND (v_project.created_by = v_uid OR v_project.user_id = v_uid) THEN
    RETURN true;
  END IF;

  -- Org member with access
  IF v_uid IS NOT NULL AND v_project.organization_id IS NOT NULL THEN
    -- Org admins/billing_admin see all projects in their org
    IF EXISTS (
      SELECT 1 FROM public.org_members
      WHERE org_id = v_project.organization_id
        AND user_id = v_uid
        AND role IN ('admin','billing_admin')
    ) THEN RETURN true; END IF;

    -- Regular members: check project_member_access table
    IF EXISTS (
      SELECT 1 FROM public.project_member_access
      WHERE project_id = p_project_id AND user_id = v_uid
    ) THEN RETURN true; END IF;
  END IF;

  -- Direct project collaborator (legacy table if it still exists)
  IF v_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'project_collaborators'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.project_collaborators
      WHERE project_id = p_project_id AND user_id = v_uid
    ) THEN RETURN true; END IF;
  END IF;

  -- Public share link: project is active + visibility org_all → allow anonymous read
  IF v_project.status = 'active' AND v_project.visibility = 'org_all' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_project_access(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.has_project_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_project_access(uuid) TO service_role;

-- ── 2. Update CollaboratorManager-style checks: custom domains ────────────────
-- Any RLS policy that gate-checked 'starter' | 'professional' | 'enterprise'
-- should now also accept 'pro' | 'agency'.
-- The cleanest way is via the SECURITY DEFINER helper below.

CREATE OR REPLACE FUNCTION public.org_can_use_custom_domains(p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_org_id
      AND plan_tier::text IN ('pro','agency','starter','professional','enterprise')
      AND status = 'active'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.org_can_use_custom_domains(uuid) TO authenticated;

-- ── 3. Refresh project_custom_domains RLS to use the helper function ──────────
DROP POLICY IF EXISTS "project_owner_manage_custom_domains" ON public.project_custom_domains;
CREATE POLICY "project member manage custom domains"
  ON public.project_custom_domains FOR ALL
  USING (
    public.has_project_access(project_id)
    AND public.org_can_use_custom_domains(
      (SELECT organization_id FROM public.projects WHERE id = project_id)
    )
  )
  WITH CHECK (
    public.has_project_access(project_id)
    AND public.org_can_use_custom_domains(
      (SELECT organization_id FROM public.projects WHERE id = project_id)
    )
  );

-- Admin bypass
DROP POLICY IF EXISTS "admin full access project_custom_domains" ON public.project_custom_domains;
CREATE POLICY "admin full access project_custom_domains"
  ON public.project_custom_domains FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- ── 4. first_time_test_run role   90-day cached read access ───────────────────
-- Store the grant in project_member_access with a role column if it exists,
-- or in a new lightweight table.
CREATE TABLE IF NOT EXISTS public.guest_project_access (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  fingerprint    text NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '90 days',
  UNIQUE(project_id, fingerprint)
);

ALTER TABLE public.guest_project_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role manage guest_project_access"
  ON public.guest_project_access FOR ALL
  USING (false)  -- no authenticated user can access directly; only service_role
  WITH CHECK (false);

-- ── 5. Ensure all new tables from phases 3-5 have admin bypass policies ───────
-- (policies created inline in each phase, but guard with IF NOT EXISTS pattern here)

-- referral_rewards   already done in phase 2
-- preview_branding   already done in phase 3
-- client_markups     already done in phase 4
-- demo_requests      already done in phase 4

-- ── 6. Updated comment to reflect 3-tier model ───────────────────────────────
COMMENT ON FUNCTION public.sync_org_plan_limits IS
  'Keeps org limits in sync with plan_tier. Active tiers: free | pro | agency. Legacy: starter/professional/enterprise are redirected to free/pro/agency respectively.';

COMMENT ON FUNCTION public.check_addon_access IS
  'Returns true when an org has an active add-on subscription. Called from RLS policies and frontend.';
