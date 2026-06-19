-- =============================================================================
-- Restore table privileges needed by project permanent-delete cleanup.
--
-- PostgREST checks table privileges before row-level policies. Missing grants
-- cause 42501 "permission denied for table ..." even when RLS would allow.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Tables touched by src/services/revisionService.ts permanentlyDeleteProject()
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.published_versions TO authenticated;
GRANT ALL ON TABLE public.published_versions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_settings TO authenticated;
GRANT ALL ON TABLE public.project_settings TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_members TO authenticated;
GRANT ALL ON TABLE public.project_members TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_custom_domains TO authenticated;
GRANT ALL ON TABLE public.project_custom_domains TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_subdomains TO authenticated;
GRANT ALL ON TABLE public.project_subdomains TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_billing TO authenticated;
GRANT ALL ON TABLE public.project_billing TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_add_ons TO authenticated;
GRANT ALL ON TABLE public.project_add_ons TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_generations TO authenticated;
GRANT ALL ON TABLE public.ai_generations TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.file_history TO authenticated;
GRANT ALL ON TABLE public.file_history TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.build_logs TO authenticated;
GRANT ALL ON TABLE public.build_logs TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.preview_sessions TO authenticated;
GRANT ALL ON TABLE public.preview_sessions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_task_logs TO authenticated;
GRANT ALL ON TABLE public.agent_task_logs TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_agents TO authenticated;
GRANT ALL ON TABLE public.ai_agents TO service_role;
