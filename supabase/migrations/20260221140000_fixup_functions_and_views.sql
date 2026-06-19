-- =============================================================================
-- EcomGear DB Fixup — run after pending migrations
-- Fixes: has_project_access function, RLS policies, admin role, views
-- =============================================================================

-- ─── 1. has_project_access function ─────────────────────────────────────────
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
          AND om.role = 'admin'
    )
    OR EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p_project_id
          AND pm.user_id = auth.uid()
    );
END;
$$;

-- ─── 2. RLS for project_agent_skills ─────────────────────────────────────────
ALTER TABLE public.project_agent_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "skills_select" ON public.project_agent_skills;
DROP POLICY IF EXISTS "skills_insert" ON public.project_agent_skills;
DROP POLICY IF EXISTS "skills_update" ON public.project_agent_skills;
DROP POLICY IF EXISTS "skills_delete" ON public.project_agent_skills;

CREATE POLICY "skills_select" ON public.project_agent_skills
  FOR SELECT USING (public.has_project_access(project_id));

CREATE POLICY "skills_insert" ON public.project_agent_skills
  FOR INSERT WITH CHECK (public.has_project_access(project_id));

CREATE POLICY "skills_update" ON public.project_agent_skills
  FOR UPDATE USING (public.has_project_access(project_id));

CREATE POLICY "skills_delete" ON public.project_agent_skills
  FOR DELETE USING (public.has_project_access(project_id));

-- ─── 3. agent_skill_templates admin policies (owner → super_admin) ────────────
DROP POLICY IF EXISTS "templates_admin_update" ON public.agent_skill_templates;
DROP POLICY IF EXISTS "templates_admin_delete" ON public.agent_skill_templates;
DROP POLICY IF EXISTS "templates_admin_insert" ON public.agent_skill_templates;

CREATE POLICY "templates_admin_insert"
  ON public.agent_skill_templates FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role IN ('admin'::public.app_role, 'super_admin'::public.app_role)
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

CREATE POLICY "templates_admin_update"
  ON public.agent_skill_templates FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role IN ('admin'::public.app_role, 'super_admin'::public.app_role)
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

CREATE POLICY "templates_admin_delete"
  ON public.agent_skill_templates FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role IN ('admin'::public.app_role, 'super_admin'::public.app_role)
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

-- ─── 4. Admin user role ───────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_key UNIQUE (user_id);
  EXCEPTION WHEN duplicate_table OR duplicate_object THEN
    NULL; -- constraint already exists
  END;
END $$;

INSERT INTO public.user_roles (user_id, role)
VALUES ('a0000000-0000-0000-0000-000000000001', 'super_admin')
ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin';

-- ─── 5. Admin usage views (adapted to ai_generations schema) ─────────────────
DROP VIEW IF EXISTS public.admin_user_usage_summary CASCADE;
DROP VIEW IF EXISTS public.admin_daily_usage CASCADE;

CREATE OR REPLACE VIEW public.admin_user_usage_summary
WITH (security_invoker = true)
AS
SELECT
  p.id                                                        AS user_id,
  p.email,
  p.full_name,
  p.avatar_url,
  p.created_at                                               AS registered_at,
  COALESCE(gen.total_generations, 0)                         AS total_prompts,
  COALESCE(gen.total_tokens, 0)                              AS total_tokens_used,
  COALESCE(gen.files_generated, 0)                           AS total_files_created,
  COALESCE(gen.files_modified, 0)                            AS total_files_modified,
  gen.last_active_at,
  gen.first_active_at,
  COALESCE(gen.projects_used, 0)                             AS projects_used,
  COALESCE(gen.events_last_7d, 0)                            AS events_last_7d,
  COALESCE(gen.events_last_30d, 0)                           AS events_last_30d,
  COALESCE(gen.prompts_last_7d, 0)                           AS prompts_last_7d,
  COALESCE(SUM(ut.lines_used), 0)                            AS total_lines_used
FROM public.profiles p
LEFT JOIN public.usage_tracking ut ON ut.user_id = p.id
LEFT JOIN (
  SELECT
    user_id,
    COUNT(*)                                                             AS total_generations,
    0::bigint                                                               AS total_tokens,
    0::bigint                                                               AS files_generated,
    0::bigint                                                               AS files_modified,
    MAX(created_at)                                                      AS last_active_at,
    MIN(created_at)                                                      AS first_active_at,
    COUNT(DISTINCT project_id)                                           AS projects_used,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')     AS events_last_7d,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')    AS events_last_30d,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')     AS prompts_last_7d
  FROM public.ai_generations
  GROUP BY user_id
) gen ON gen.user_id = p.id
GROUP BY p.id, p.email, p.full_name, p.avatar_url, p.created_at,
         gen.total_generations, gen.total_tokens, gen.files_generated,
         gen.files_modified, gen.last_active_at, gen.first_active_at,
         gen.projects_used, gen.events_last_7d, gen.events_last_30d, gen.prompts_last_7d;

GRANT SELECT ON public.admin_user_usage_summary TO authenticated;

COMMENT ON VIEW public.admin_user_usage_summary IS
  'Per-user usage aggregation for the admin panel.';

CREATE OR REPLACE VIEW public.admin_daily_usage
WITH (security_invoker = true)
AS
SELECT
  DATE(created_at AT TIME ZONE 'UTC')                        AS day,
  COUNT(*)                                                   AS total_events,
  COUNT(*)                                                   AS prompts,
  COUNT(DISTINCT user_id)                                    AS active_users,
  0::bigint                                                  AS files_created,
  0::bigint                                                  AS tokens_used
FROM public.ai_generations
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY DATE(created_at AT TIME ZONE 'UTC')
ORDER BY day DESC;

GRANT SELECT ON public.admin_daily_usage TO authenticated;

COMMENT ON VIEW public.admin_daily_usage IS
  'Daily usage aggregates for the 90-day activity chart.';
