-- =============================================================================
-- Restore runtime table privileges required by app/editor flows.
-- These grants are required in addition to RLS policies because Postgres checks
-- table privileges before evaluating row-level policies.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT ON TABLE public.project_chat_history TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_chat_history TO authenticated;
GRANT ALL ON TABLE public.project_chat_history TO service_role;

GRANT SELECT ON TABLE public.revision_preview TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.revision_preview TO authenticated;
GRANT ALL ON TABLE public.revision_preview TO service_role;

GRANT SELECT ON TABLE public.messages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;

GRANT SELECT ON TABLE public.revisions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.revisions TO authenticated;
GRANT ALL ON TABLE public.revisions TO service_role;

GRANT SELECT ON TABLE public.projects TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;

GRANT SELECT ON TABLE public.organizations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organizations TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;

GRANT SELECT ON TABLE public.profiles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

GRANT SELECT ON TABLE public.usage_tracking TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_tracking TO authenticated;
GRANT ALL ON TABLE public.usage_tracking TO service_role;

GRANT SELECT ON TABLE public.project_member_access TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_member_access TO authenticated;
GRANT ALL ON TABLE public.project_member_access TO service_role;

GRANT SELECT ON TABLE public.agent_skill_templates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_skill_templates TO authenticated;
GRANT ALL ON TABLE public.agent_skill_templates TO service_role;
