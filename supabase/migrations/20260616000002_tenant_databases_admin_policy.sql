-- Allow super_admin/admin roles to view all tenant databases across all
-- users/orgs, for the admin "Hosted Databases" page. Mirrors the
-- get_my_role() admin-bypass pattern used elsewhere (see
-- 20260219010000_subscription_system.sql).
CREATE POLICY "tenant_db_admin_select" ON tenant_databases
  FOR SELECT USING (public.get_my_role() IN ('admin', 'super_admin'));
