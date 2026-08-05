-- 2026-08 stability review, Step 6: tenant schemas (server/src/services/
-- database.service.ts, provisioned per-project on the shared tenant Postgres
-- cluster) have no migration/version ledger -- DDL arrives ad hoc via the
-- agent's query_database tool (runQuery(role='service')), with no record of
-- what changed or when. runQuery() already executes DDL/DML transactionally
-- (real BEGIN/COMMIT, see database.service.ts:850-862), so this is NOT a
-- corruption-risk fix -- it's a pure audit trail: an append-only log of DDL
-- that landed, so a broken/unexpected schema state can be investigated
-- ("what ran, when, for which project") instead of starting from nothing.
-- No rollback/versioning semantics are implied or provided here.
CREATE TABLE IF NOT EXISTS tenant_schema_migrations (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  schema_name      TEXT        NOT NULL,
  project_id       UUID        REFERENCES public.projects(id) ON DELETE SET NULL,
  user_id          UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  sql_text         TEXT        NOT NULL,
  statement_count  INTEGER     NOT NULL DEFAULT 1,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_schema_migrations_schema ON tenant_schema_migrations(schema_name, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_schema_migrations_project ON tenant_schema_migrations(project_id, applied_at DESC);

ALTER TABLE tenant_schema_migrations ENABLE ROW LEVEL SECURITY;

-- Written server-side only (service-role key, from database.service.ts's
-- runQuery()) -- no anon/authenticated policy needed. Owners can read their
-- own project's history directly.
CREATE POLICY "service_role_all_tenant_schema_migrations" ON tenant_schema_migrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "owner_read_own_tenant_schema_migrations" ON tenant_schema_migrations
  FOR SELECT TO authenticated
  USING (
    project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.projects p WHERE p.id = tenant_schema_migrations.project_id AND p.user_id = auth.uid()
    )
  );
