-- Edge functions: stored per user, isolated by RLS
CREATE TABLE IF NOT EXISTS edge_functions (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  code        TEXT        NOT NULL DEFAULT '',
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name),
  CONSTRAINT name_valid CHECK (name ~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$')
);

ALTER TABLE edge_functions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_edge_functions" ON edge_functions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_role_edge_functions" ON edge_functions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- auto-update updated_at
CREATE OR REPLACE FUNCTION update_edge_functions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER edge_functions_updated_at
  BEFORE UPDATE ON edge_functions
  FOR EACH ROW EXECUTE FUNCTION update_edge_functions_updated_at();

-- invocation log (lightweight   only last 50 per function retained)
CREATE TABLE IF NOT EXISTS edge_function_logs (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  function_id UUID        NOT NULL REFERENCES edge_functions(id) ON DELETE CASCADE,
  params      JSONB,
  result      JSONB,
  logs        TEXT[],
  duration_ms INTEGER,
  error       TEXT,
  invoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE edge_function_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_function_logs" ON edge_function_logs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_role_function_logs" ON edge_function_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
