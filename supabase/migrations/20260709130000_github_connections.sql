-- GitHub connector: one connected GitHub account per user, linked repo/branch per project.
CREATE TABLE IF NOT EXISTS public.github_connections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login   TEXT NOT NULL,
  avatar_url     TEXT,
  access_token   TEXT NOT NULL,
  scope          TEXT,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.github_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_github_connection" ON public.github_connections
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_role_github_connections" ON public.github_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-project linked repo (owner/repo full_name + branch) reuses the existing
-- generic project_settings key/value table (setting_key = 'github_repo'),
-- same pattern as 'seo' and 'header_integrations' — no schema change needed there.
