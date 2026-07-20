-- Google Analytics connector: one connected Google account per user (OAuth,
-- read-only Analytics scope), linked GA4 property per project.
CREATE TABLE IF NOT EXISTS public.google_analytics_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  google_email      TEXT,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  token_expires_at  TIMESTAMPTZ NOT NULL,
  scope             TEXT,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.google_analytics_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_google_analytics_connection" ON public.google_analytics_connections
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_role_google_analytics_connections" ON public.google_analytics_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-project linked GA4 property (property_id + display_name) reuses the
-- existing generic project_settings key/value table (setting_key =
-- 'google_analytics'), same pattern as 'github_repo' / 'seo' /
-- 'header_integrations' -- no schema change needed there.
