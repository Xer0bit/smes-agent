-- =============================================================================
-- Phase 5: Add-on Products
-- Auto Pilot Mode, eComGear Cloud, Integration App Marketplace,
-- Ali Cloud Hosting Migration, Add-on Subscriptions
-- =============================================================================

-- ── 1. Auto Pilot Mode ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auto_pilot_configs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  schedule     text,           -- cron expression e.g. '0 9 * * 1' (Mon 9am)
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  prompt       text,           -- the instruction the agent runs each time
  status       text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','completed','failed','paused')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.auto_pilot_configs ENABLE ROW LEVEL SECURITY;

-- ── 2. eComGear Cloud ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ecomgear_cloud_configs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  storage_bucket       text,
  cdn_url              text,
  storage_used_bytes   bigint NOT NULL DEFAULT 0,
  storage_limit_bytes  bigint NOT NULL DEFAULT 1073741824,  -- 1 GB default
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ecomgear_cloud_configs ENABLE ROW LEVEL SECURITY;

-- ── 3. Integration App Catalog ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_apps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  slug         text NOT NULL UNIQUE,
  description  text,
  icon_url     text,
  category     text NOT NULL DEFAULT 'other',  -- 'ecommerce','payment','analytics','marketing','other'
  app_url      text,
  config_schema jsonb,   -- JSON schema for required config keys
  available_tiers text[] NOT NULL DEFAULT ARRAY['pro','agency'],  -- which tiers can install
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.integration_apps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can read enabled integration apps"
  ON public.integration_apps FOR SELECT
  USING (enabled = true);

CREATE POLICY "admin full access integration_apps"
  ON public.integration_apps FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- Seed catalog
INSERT INTO public.integration_apps(name, slug, description, category, available_tiers) VALUES
  ('Shopify',          'shopify',          'Sync products and orders from Shopify',           'ecommerce',  ARRAY['pro','agency']),
  ('WooCommerce',      'woocommerce',      'Sync with WooCommerce store data',                'ecommerce',  ARRAY['pro','agency']),
  ('Stripe',           'stripe',           'Accept payments via Stripe',                      'payment',    ARRAY['pro','agency']),
  ('PayPal',           'paypal',           'Accept payments via PayPal',                      'payment',    ARRAY['pro','agency']),
  ('Google Analytics', 'google-analytics', 'Track visitor analytics via Google Analytics 4',  'analytics',  ARRAY['pro','agency']),
  ('Mailchimp',        'mailchimp',        'Sync subscribers to Mailchimp',                   'marketing',  ARRAY['pro','agency']),
  ('Klaviyo',          'klaviyo',          'Email marketing via Klaviyo',                     'marketing',  ARRAY['agency']),
  ('Meta Pixel',       'meta-pixel',       'Facebook/Instagram ad conversion tracking',        'marketing',  ARRAY['pro','agency']),
  ('Zapier',           'zapier',           'Connect to 5000+ apps via Zapier',                'other',      ARRAY['agency'])
ON CONFLICT (slug) DO NOTHING;

-- ── 4. Project Integrations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  integration_app_id  uuid NOT NULL REFERENCES public.integration_apps(id) ON DELETE CASCADE,
  config              jsonb NOT NULL DEFAULT '{}',  -- encrypted at app layer before storage
  enabled             boolean NOT NULL DEFAULT true,
  installed_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  installed_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, integration_app_id)
);

ALTER TABLE public.project_integrations ENABLE ROW LEVEL SECURITY;

-- ── 5. Ali Cloud Migration ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ali_cloud_configs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE CASCADE,
  region             text NOT NULL DEFAULT 'cn-hangzhou',
  instance_id        text,
  endpoint_url       text,
  migration_status   text NOT NULL DEFAULT 'requested' CHECK (migration_status IN ('requested','provisioning','active','failed','cancelled')),
  migrated_at        timestamptz,
  admin_notes        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ali_cloud_configs ENABLE ROW LEVEL SECURITY;

-- ── 6. Add-on Subscriptions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.addon_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id            uuid REFERENCES public.projects(id) ON DELETE CASCADE,  -- nullable (org-level add-ons have no project)
  addon_type            text NOT NULL CHECK (addon_type IN ('auto_pilot','ecomgear_cloud','ali_cloud','integration')),
  price_usd             numeric(10,2) NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','past_due')),
  stripe_subscription_id text,
  activated_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_at          timestamptz,
  UNIQUE(org_id, project_id, addon_type)
);

ALTER TABLE public.addon_subscriptions ENABLE ROW LEVEL SECURITY;

-- ── 7. RLS policies — project members access their own add-on records ─────────
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['auto_pilot_configs','ecomgear_cloud_configs','project_integrations','ali_cloud_configs']
  LOOP
    EXECUTE format(
      'CREATE POLICY "project member access %1$s" ON public.%1$s FOR ALL
       USING (public.has_project_access(project_id))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "admin full access %1$s" ON public.%1$s FOR ALL
       USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN (''super_admin'',''admin'')))',
      tbl
    );
  END LOOP;
END $$;

-- Addon subscriptions — org admin access
CREATE POLICY "org admin access addon_subscriptions"
  ON public.addon_subscriptions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = addon_subscriptions.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('admin','billing_admin')
    )
  );

CREATE POLICY "admin full access addon_subscriptions"
  ON public.addon_subscriptions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- ── 8. Helper: check_addon_access(org_id, addon_type) → bool ──────────────────
-- Returns true if the org has an active subscription for the given addon.
CREATE OR REPLACE FUNCTION public.check_addon_access(
  p_org_id    uuid,
  p_addon_type text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.addon_subscriptions
    WHERE org_id     = p_org_id
      AND addon_type = p_addon_type
      AND status     = 'active'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_addon_access(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_addon_access(uuid, text) TO service_role;
