-- =============================================================================
-- Migration: Full subscription system
-- - Add plan_tier, seats, status, usage counters to organizations
-- - Create usage_tracking table
-- - Admin-bypass RLS policies using get_my_role()
-- - Helper DB functions for limit enforcement
-- =============================================================================

-- =============================================================================
-- 1. Extend organizations with subscription columns
-- =============================================================================
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_tier     TEXT    NOT NULL DEFAULT 'free'
    CHECK (plan_tier IN ('free','starter','professional','enterprise')),
  ADD COLUMN IF NOT EXISTS status        TEXT    NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','cancelled')),
  ADD COLUMN IF NOT EXISTS seats_total   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS seats_used    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_projects  INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ai_gens_used  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_gens_limit INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS ai_gens_reset_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days');

-- Sync seats/projects limits with tier on insert (trigger keeps them consistent)
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  CASE NEW.plan_tier
    WHEN 'free'         THEN NEW.seats_total := 1;  NEW.max_projects := 1;  NEW.ai_gens_limit := 10;
    WHEN 'starter'      THEN NEW.seats_total := 3;  NEW.max_projects := 5;  NEW.ai_gens_limit := 100;
    WHEN 'professional' THEN NEW.seats_total := 10; NEW.max_projects := 999999; NEW.ai_gens_limit := 1000;
    WHEN 'enterprise'   THEN NEW.seats_total := 999999; NEW.max_projects := 999999; NEW.ai_gens_limit := 999999;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_org_plan_limits ON organizations;
CREATE TRIGGER trg_sync_org_plan_limits
  BEFORE INSERT OR UPDATE OF plan_tier ON organizations
  FOR EACH ROW EXECUTE FUNCTION public.sync_org_plan_limits();

-- Back-fill existing orgs
UPDATE organizations SET plan_tier = plan_tier;

-- =============================================================================
-- 2. usage_tracking table
-- =============================================================================
CREATE TABLE IF NOT EXISTS usage_tracking (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,   -- 'ai_generate' | 'revision' | 'deploy' | 'preview' | 'invite'
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_tracking_org     ON usage_tracking(org_id);
CREATE INDEX IF NOT EXISTS idx_usage_tracking_user    ON usage_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_tracking_action  ON usage_tracking(action);
CREATE INDEX IF NOT EXISTS idx_usage_tracking_created ON usage_tracking(created_at DESC);

ALTER TABLE usage_tracking ENABLE ROW LEVEL SECURITY;

-- Users see their own usage; admins see all
CREATE POLICY "usage_tracking_select"
  ON usage_tracking FOR SELECT
  USING (user_id = auth.uid() OR public.get_my_role() IN ('admin','super_admin'));

CREATE POLICY "usage_tracking_insert"
  ON usage_tracking FOR INSERT
  WITH CHECK (user_id = auth.uid() OR public.get_my_role() IN ('admin','super_admin'));

CREATE POLICY "usage_tracking_admin_all"
  ON usage_tracking FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- =============================================================================
-- 3. SECURITY DEFINER helper: check org limits without RLS loops
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_org_limits(p_org_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'plan_tier',      plan_tier,
    'status',         status,
    'seats_total',    seats_total,
    'seats_used',     seats_used,
    'max_projects',   max_projects,
    'ai_gens_used',   ai_gens_used,
    'ai_gens_limit',  ai_gens_limit,
    'ai_gens_reset_at', ai_gens_reset_at
  )
  FROM public.organizations
  WHERE id = p_org_id
  LIMIT 1;
$$;

-- Count projects for an org (bypasses RLS)
CREATE OR REPLACE FUNCTION public.count_org_projects(p_org_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER FROM public.projects WHERE organization_id = p_org_id;
$$;

-- Increment AI gen counter; returns TRUE if under limit, FALSE if over
CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  INTEGER;
  v_used   INTEGER;
  v_reset  TIMESTAMPTZ;
BEGIN
  SELECT ai_gens_limit, ai_gens_used, ai_gens_reset_at
    INTO v_limit, v_used, v_reset
    FROM public.organizations WHERE id = p_org_id FOR UPDATE;

  -- Reset counter if past reset date
  IF v_reset IS NOT NULL AND NOW() > v_reset THEN
    UPDATE public.organizations
      SET ai_gens_used = 0, ai_gens_reset_at = NOW() + INTERVAL '30 days'
      WHERE id = p_org_id;
    v_used := 0;
  END IF;

  IF v_used >= v_limit THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations SET ai_gens_used = ai_gens_used + 1 WHERE id = p_org_id;
  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 4. Admin-bypass RLS for all tables
-- =============================================================================

-- ORGANIZATIONS: admins can read/write all orgs
DROP POLICY IF EXISTS "admin_orgs_all" ON organizations;
CREATE POLICY "admin_orgs_all"
  ON organizations FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- PROJECTS: admins can read/write all projects
DROP POLICY IF EXISTS "admin_projects_all" ON projects;
CREATE POLICY "admin_projects_all"
  ON projects FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- PROFILES: admins can read all profiles
DROP POLICY IF EXISTS "admin_profiles_select" ON profiles;
CREATE POLICY "admin_profiles_select"
  ON profiles FOR SELECT
  USING (id = auth.uid() OR public.get_my_role() IN ('admin','super_admin'));

DROP POLICY IF EXISTS "admin_profiles_update" ON profiles;
CREATE POLICY "admin_profiles_update"
  ON profiles FOR UPDATE
  USING (id = auth.uid() OR public.get_my_role() IN ('admin','super_admin'));

DROP POLICY IF EXISTS "admin_profiles_all" ON profiles;
CREATE POLICY "admin_profiles_all"
  ON profiles FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- ORG_MEMBERS: admins can see all memberships
DROP POLICY IF EXISTS "admin_org_members_all" ON org_members;
CREATE POLICY "admin_org_members_all"
  ON org_members FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- ORG_INVITATIONS: super_admins see all
DROP POLICY IF EXISTS "admin_invitations_all" ON org_invitations;
CREATE POLICY "admin_invitations_all"
  ON org_invitations FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- REVISIONS: admins can see all
DROP POLICY IF EXISTS "admin_revisions_all" ON revisions;
CREATE POLICY "admin_revisions_all"
  ON revisions FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- =============================================================================
-- 5. Expose get_org_limits and increment_ai_gen to authenticated clients
-- =============================================================================
GRANT EXECUTE ON FUNCTION public.get_org_limits(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_org_projects(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;
