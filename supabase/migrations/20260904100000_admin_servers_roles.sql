-- Admin: application server registry + platform role audit trail.

-- ── app_servers ─────────────────────────────────────────────────────────────
-- One row per platform service the api-gateway can probe over HTTP. Health is
-- written by the API (service role) after a server-side probe so the browser
-- never has to reach a node directly.
CREATE TABLE IF NOT EXISTS public.app_servers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  role              text NOT NULL DEFAULT 'other'
                      CHECK (role IN ('api','gen','preview','hosting','tenant_db','functions','web','other')),
  base_url          text NOT NULL,
  health_path       text NOT NULL DEFAULT '/health',
  host              text,
  notes             text,
  enabled           boolean NOT NULL DEFAULT true,
  health_status     text NOT NULL DEFAULT 'unknown'
                      CHECK (health_status IN ('healthy','degraded','unreachable','unknown')),
  health_http       int,
  health_latency_ms int,
  health_detail     jsonb,
  health_last_check timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_servers_updated ON public.app_servers;
CREATE TRIGGER trg_app_servers_updated
  BEFORE UPDATE ON public.app_servers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.app_servers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read app_servers" ON public.app_servers;
CREATE POLICY "admins read app_servers" ON public.app_servers FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin')));

INSERT INTO public.app_servers (name, role, base_url, health_path, host, notes) VALUES
  ('VPS1 API + Web',        'api',       'https://api.ecomgear.dev',      '/health', '156.67.218.75',  'api-gateway (SERVICE_ROLE=api), web client, platform Supabase'),
  ('VPS2 Preview',          'preview',   'https://preview.ecomgear.app',  '/health', '72.62.126.99',   'preview-service: live project previews'),
  ('VPS3 Agent Runner',     'gen',       'https://gen.ecomgear.dev',      '/health', '3.148.126.20',   'api-gateway (SERVICE_ROLE=gen): LLM agent runs'),
  ('VPS4 Hosting',          'hosting',   'https://hosting.ecomgear.app',  '/health', '187.77.157.231', 'hosting-service + Caddy: published sites and custom domains'),
  ('VPS5 Tenant DB API',    'tenant_db', 'https://cloud.ecomgear.app',    '/',       '187.127.108.19', 'PostgREST over tenant Postgres (eCG Cloud databases); also runs tenant-functions-runner (no public health path)')
ON CONFLICT (name) DO NOTHING;

-- ── role_audit ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.role_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id       uuid,
  target_user_id uuid NOT NULL,
  old_role       text,
  new_role       text,
  action         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_role_audit_target ON public.role_audit(target_user_id, created_at DESC);

ALTER TABLE public.role_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read role_audit" ON public.role_audit;
CREATE POLICY "admins read role_audit" ON public.role_audit FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin')));

-- ── app_server_checks ───────────────────────────────────────────────────────
-- One row per probe (manual or the API's background monitor). Uptime and the
-- status strip on the admin Servers page are computed from the last 24h.
CREATE TABLE IF NOT EXISTS public.app_server_checks (
  id          bigserial PRIMARY KEY,
  server_id   uuid NOT NULL REFERENCES public.app_servers(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('healthy','degraded','unreachable')),
  http        int,
  latency_ms  int,
  error       text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_server_checks_server_time ON public.app_server_checks(server_id, checked_at DESC);

ALTER TABLE public.app_server_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read app_server_checks" ON public.app_server_checks;
CREATE POLICY "admins read app_server_checks" ON public.app_server_checks FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin')));
