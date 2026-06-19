-- Tighten RLS on tenant_databases:
-- The original "tenant_db_owner_all" (FOR ALL) let authenticated users INSERT,
-- UPDATE, and DELETE their own rows via the Supabase JS client, bypassing the
-- server's provisioning flow. Replace it with SELECT-only for users; all writes
-- must go through the server's service-role key.

DROP POLICY IF EXISTS "tenant_db_owner_all" ON tenant_databases;

CREATE POLICY "tenant_db_owner_select" ON tenant_databases
  FOR SELECT USING (user_id = auth.uid());
