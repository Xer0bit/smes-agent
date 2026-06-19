-- =============================================================================
-- Restore admin-access table grants after schema reconstruction.
-- These privileges are required before RLS is evaluated; without them,
-- PostgREST returns 42501 "permission denied for table ...".
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_tracking TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.revisions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_invitations TO authenticated;

GRANT ALL ON TABLE public.profiles TO service_role;
GRANT ALL ON TABLE public.organizations TO service_role;
GRANT ALL ON TABLE public.usage_tracking TO service_role;
GRANT ALL ON TABLE public.org_members TO service_role;
GRANT ALL ON TABLE public.projects TO service_role;
GRANT ALL ON TABLE public.revisions TO service_role;
GRANT ALL ON TABLE public.user_roles TO service_role;
GRANT ALL ON TABLE public.org_invitations TO service_role;
