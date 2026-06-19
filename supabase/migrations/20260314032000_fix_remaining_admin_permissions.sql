-- =============================================================================
-- Fix remaining permission regressions after DB reconstruction.
-- Required for admin pages that read templates and projects with policies that
-- reference project_member_access.
-- =============================================================================

GRANT SELECT ON TABLE public.project_member_access TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_member_access TO authenticated;
GRANT ALL ON TABLE public.project_member_access TO service_role;

GRANT SELECT ON TABLE public.agent_skill_templates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_skill_templates TO authenticated;
GRANT ALL ON TABLE public.agent_skill_templates TO service_role;
