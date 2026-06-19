-- =============================================================================
-- Create missing tables + fix fixup migration for clean schema
-- =============================================================================

-- ─── ai_agents ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_agents (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    project_id              uuid REFERENCES public.projects(id) ON DELETE SET NULL,
    name                    text NOT NULL,
    description             text,
    job_description         text,
    agent_photo_url         text,
    original_prompt         text,
    workflow_data           jsonb,
    status                  text DEFAULT 'idle',
    about                   text,
    current_task            text,
    is_active               boolean DEFAULT true,
    connected_integrations  jsonb,
    created_at              timestamptz DEFAULT NOW(),
    updated_at              timestamptz DEFAULT NOW()
);
ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_agents_owner" ON public.ai_agents;
CREATE POLICY "ai_agents_owner" ON public.ai_agents
    USING (auth.uid() = user_id);

-- ─── subscriptions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id                  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    plan                    text NOT NULL DEFAULT 'free',
    status                  text NOT NULL DEFAULT 'active',
    is_annual               boolean DEFAULT false,
    stripe_subscription_id  text,
    stripe_price_id         text,
    current_period_start    timestamptz,
    current_period_end      timestamptz,
    cancel_at_period_end    boolean DEFAULT false,
    canceled_at             timestamptz,
    trial_start             timestamptz,
    trial_end               timestamptz,
    metadata                jsonb,
    created_at              timestamptz DEFAULT NOW(),
    updated_at              timestamptz DEFAULT NOW()
);
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subscriptions_org_members" ON public.subscriptions;
CREATE POLICY "subscriptions_org_members" ON public.subscriptions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.org_members
            WHERE org_id = subscriptions.org_id AND user_id = auth.uid()
        )
    );

-- ─── published_versions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.published_versions (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    revision_id     uuid NOT NULL REFERENCES public.revisions(id) ON DELETE CASCADE,
    version_tag     text NOT NULL,
    git_tag         text,
    git_commit_hash text,
    deployment_url  text,
    deployed_by     uuid REFERENCES auth.users(id),
    status          text DEFAULT 'pending',
    published_at    timestamptz DEFAULT NOW()
);
ALTER TABLE public.published_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "published_versions_project_access" ON public.published_versions;
CREATE POLICY "published_versions_project_access" ON public.published_versions
    FOR SELECT USING (public.has_project_access(project_id));

-- ─── Re-run fixup views using TEXT comparisons (app_role is a text column here)
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
  COALESCE(gen.files_generated_count, 0)                     AS total_files_created,
  COALESCE(gen.files_modified_count, 0)                      AS total_files_modified,
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
    r.created_by                                                            AS user_id,
    COUNT(*)                                                                AS total_generations,
    0::bigint                                                               AS total_tokens,
    0::bigint                                                               AS files_generated_count,
    0::bigint                                                               AS files_modified_count,
    MAX(r.created_at)                                                       AS last_active_at,
    MIN(r.created_at)                                                       AS first_active_at,
    COUNT(DISTINCT r.project_id)                                            AS projects_used,
    COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '7 days')      AS events_last_7d,
    COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '30 days')     AS events_last_30d,
    COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '7 days')      AS prompts_last_7d
  FROM public.revisions r
  WHERE r.created_by IS NOT NULL
  GROUP BY r.created_by
) gen ON gen.user_id = p.id
GROUP BY p.id, p.email, p.full_name, p.avatar_url, p.created_at,
         gen.total_generations, gen.total_tokens, gen.files_generated_count,
         gen.files_modified_count, gen.last_active_at, gen.first_active_at,
         gen.projects_used, gen.events_last_7d, gen.events_last_30d, gen.prompts_last_7d;

GRANT SELECT ON public.admin_user_usage_summary TO authenticated;

CREATE OR REPLACE VIEW public.admin_daily_usage
WITH (security_invoker = true)
AS
SELECT
  DATE(created_at AT TIME ZONE 'UTC')   AS day,
  COUNT(*)                              AS total_events,
  COUNT(*)                              AS prompts,
  COUNT(DISTINCT created_by)            AS active_users,
  0::bigint                             AS files_created,
  0::bigint                             AS tokens_used
FROM public.revisions
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY DATE(created_at AT TIME ZONE 'UTC')
ORDER BY day DESC;

GRANT SELECT ON public.admin_daily_usage TO authenticated;

-- ─── Re-apply admin_skill_templates policies using TEXT cast ─────────────────
DROP POLICY IF EXISTS "templates_admin_insert" ON public.agent_skill_templates;
DROP POLICY IF EXISTS "templates_admin_update" ON public.agent_skill_templates;
DROP POLICY IF EXISTS "templates_admin_delete" ON public.agent_skill_templates;

CREATE POLICY "templates_admin_insert"
  ON public.agent_skill_templates FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role::text IN ('admin', 'super_admin')
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

CREATE POLICY "templates_admin_update"
  ON public.agent_skill_templates FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role::text IN ('admin', 'super_admin')
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

CREATE POLICY "templates_admin_delete"
  ON public.agent_skill_templates FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role::text IN ('admin', 'super_admin')
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );
