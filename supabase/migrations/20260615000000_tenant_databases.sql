-- Tracks provisioned tenant database schemas on the VPS5 tenant DB server.
-- No passwords or JWT secrets are stored here — they are derived on-demand.
CREATE TABLE IF NOT EXISTS tenant_databases (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id  UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  schema_name      TEXT        NOT NULL UNIQUE,
  status           TEXT        NOT NULL DEFAULT 'provisioning'
                               CHECK (status IN ('provisioning', 'active', 'error', 'deprovisioning', 'deprovisioned')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_databases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_db_owner_all" ON tenant_databases
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "tenant_db_org_view" ON tenant_databases
  FOR SELECT USING (
    organization_id IS NOT NULL AND
    organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION set_tenant_db_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER tenant_db_updated_at
  BEFORE UPDATE ON tenant_databases
  FOR EACH ROW EXECUTE FUNCTION set_tenant_db_updated_at();

CREATE INDEX IF NOT EXISTS tenant_databases_user_id_idx ON tenant_databases (user_id);
CREATE INDEX IF NOT EXISTS tenant_databases_org_id_idx  ON tenant_databases (organization_id);
