-- =============================================================================
-- Fix admin access to user_roles after schema rebuild.
-- Rebuild recreated tables without anon/authenticated/service_role grants, which
-- caused 42501 "permission denied for table user_roles" before RLS evaluation.
-- =============================================================================

-- Ensure table privileges for API roles
GRANT SELECT ON TABLE public.user_roles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;

-- Ensure write policy also has WITH CHECK so INSERT/UPDATE are valid
DROP POLICY IF EXISTS "user_roles_write" ON public.user_roles;

CREATE POLICY "user_roles_write"
ON public.user_roles
FOR ALL
USING (public.get_my_role() = 'super_admin')
WITH CHECK (public.get_my_role() = 'super_admin');