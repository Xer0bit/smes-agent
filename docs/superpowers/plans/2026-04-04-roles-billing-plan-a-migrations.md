# Roles & Billing   Plan A: Database Migrations + Services

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all 6 database migration phases and update TypeScript types + subscription service to match the new free/pro/agency tier system with publish lines, referrals, guest sessions, branding, agency features, and add-on products.

**Architecture:** Six sequential Supabase migrations build on each other   Phase 1 (tier rename) must run first as everything else depends on the `plan_tier` constraint. Types and service files are updated after migrations so TypeScript stays in sync with the DB schema.

**Tech Stack:** PostgreSQL (Supabase), TypeScript, supabase-js v2

---

## File Map

### New Files
- `supabase/migrations/20260404000001_migrate_tiers_free_pro_agency.sql`
- `supabase/migrations/20260404000002_publish_lines_referral.sql`
- `supabase/migrations/20260404000003_guest_sessions_branding.sql`
- `supabase/migrations/20260404000004_agency_features.sql`
- `supabase/migrations/20260404000005_addon_products.sql`
- `supabase/migrations/20260404000006_rls_permissions_update.sql`

### Modified Files
- `src/integrations/supabase/types.ts`   update `PlanTier`, add 15+ new table types
- `src/services/subscriptionService.ts`   replace AI gens with publish lines, update tier config
- `src/hooks/useSubscription.ts`   update `SubscriptionState` for publish lines

---

## Task 1: Phase 1   Tier Migration (free/pro/agency)

**Files:**
- Create: `supabase/migrations/20260404000001_migrate_tiers_free_pro_agency.sql`

- [ ] **Step 1: Create migration file**

```sql
-- =============================================================================
-- Migration: Rename plan tiers to free / pro / agency
-- Replaces: free, starter, professional, enterprise
-- Mapping: free→free, starter→free, professional→pro, enterprise→agency
-- =============================================================================

-- 1. Add temporary column with new constraint
ALTER TABLE organizations
  ADD COLUMN plan_tier_new TEXT NOT NULL DEFAULT 'free'
    CHECK (plan_tier_new IN ('free', 'pro', 'agency'));

-- 2. Populate from old column
UPDATE organizations SET plan_tier_new =
  CASE plan_tier
    WHEN 'free'         THEN 'free'
    WHEN 'starter'      THEN 'free'
    WHEN 'professional' THEN 'pro'
    WHEN 'enterprise'   THEN 'agency'
    ELSE 'free'
  END;

-- 3. Drop old column and rename new
ALTER TABLE organizations DROP COLUMN plan_tier;
ALTER TABLE organizations RENAME COLUMN plan_tier_new TO plan_tier;

-- 4. Replace sync trigger with new tier limits
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  CASE NEW.plan_tier
    WHEN 'free'   THEN NEW.seats_total := 1;  NEW.max_projects := 1;
    WHEN 'pro'    THEN NEW.seats_total := 5;  NEW.max_projects := 999999;
    WHEN 'agency' THEN NEW.seats_total := 20; NEW.max_projects := 999999;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END;
$$;

-- Re-fire trigger to sync existing orgs
UPDATE organizations SET plan_tier = plan_tier;

-- 5. Update get_org_limits to return new tier names (no schema change needed,
--    already returns plan_tier column value directly)

-- 6. Update check_subscription function if it exists
DROP FUNCTION IF EXISTS public.get_plan_price(TEXT);
CREATE OR REPLACE FUNCTION public.get_plan_price(p_tier TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT CASE p_tier
    WHEN 'free'   THEN 0
    WHEN 'pro'    THEN 8
    WHEN 'agency' THEN 25
    ELSE 0
  END;
$$;
GRANT EXECUTE ON FUNCTION public.get_plan_price(TEXT) TO authenticated;
```

- [ ] **Step 2: Apply migration via Supabase CLI**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
supabase db push
```

Expected: Migration applied with no errors. Verify:
```bash
supabase db diff
```
Expected: No pending changes.

- [ ] **Step 3: Verify data integrity**

In Supabase Studio SQL editor or via CLI:
```sql
SELECT DISTINCT plan_tier FROM organizations;
-- Expected: only 'free', 'pro', or 'agency' values
SELECT COUNT(*) FROM organizations WHERE plan_tier NOT IN ('free','pro','agency');
-- Expected: 0
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260404000001_migrate_tiers_free_pro_agency.sql
git commit -m "feat(db): migrate plan tiers to free/pro/agency"
```

---

## Task 2: Phase 2   Publish Lines + Referral System

**Files:**
- Create: `supabase/migrations/20260404000002_publish_lines_referral.sql`

- [ ] **Step 1: Create migration file**

```sql
-- =============================================================================
-- Migration: Replace AI gens with publish lines; add referral system
-- =============================================================================

-- 1. Add publish lines columns to organizations
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS publish_lines_used    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS publish_lines_limit   INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS publish_lines_reset_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days');

-- 2. Set limits per tier
UPDATE organizations SET publish_lines_limit =
  CASE plan_tier
    WHEN 'free'   THEN 30
    WHEN 'pro'    THEN 100
    WHEN 'agency' THEN 100
    ELSE 30
  END;

-- 3. Update sync trigger to also set publish_lines_limit
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  CASE NEW.plan_tier
    WHEN 'free'   THEN NEW.seats_total := 1;  NEW.max_projects := 1;       NEW.publish_lines_limit := 30;
    WHEN 'pro'    THEN NEW.seats_total := 5;  NEW.max_projects := 999999;  NEW.publish_lines_limit := 100;
    WHEN 'agency' THEN NEW.seats_total := 20; NEW.max_projects := 999999;  NEW.publish_lines_limit := 100;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END;
$$;

-- 4. Add referral fields to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bonus_lines   INTEGER NOT NULL DEFAULT 0;

-- Generate referral codes for existing profiles
UPDATE profiles
SET referral_code = UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 8))
WHERE referral_code IS NULL;

-- Ensure new profiles get a code automatically
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 8));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_generate_referral_code ON profiles;
CREATE TRIGGER trg_generate_referral_code
  BEFORE INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.generate_referral_code();

-- 5. referral_rewards table
CREATE TABLE IF NOT EXISTS referral_rewards (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referee_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lines_earned INTEGER NOT NULL DEFAULT 20,
  awarded_at   TIMESTAMPTZ DEFAULT NOW(),
  trigger_event TEXT NOT NULL DEFAULT 'published',
  UNIQUE(referee_id)  -- one reward per referee
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards(referrer_id);

ALTER TABLE referral_rewards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "referral_rewards_select_own"
  ON referral_rewards FOR SELECT
  USING (referrer_id = auth.uid() OR referee_id = auth.uid());

CREATE POLICY "referral_rewards_admin_all"
  ON referral_rewards FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 6. RPC: award_referral_lines   called when a referred user publishes first project
CREATE OR REPLACE FUNCTION public.award_referral_lines(p_referee_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_id UUID;
  v_already_awarded BOOLEAN;
BEGIN
  -- Check if already awarded
  SELECT EXISTS(SELECT 1 FROM referral_rewards WHERE referee_id = p_referee_id)
    INTO v_already_awarded;
  IF v_already_awarded THEN RETURN; END IF;

  -- Get referrer
  SELECT referred_by INTO v_referrer_id FROM profiles WHERE id = p_referee_id;
  IF v_referrer_id IS NULL THEN RETURN; END IF;

  -- Insert reward record
  INSERT INTO referral_rewards (referrer_id, referee_id, lines_earned, trigger_event)
  VALUES (v_referrer_id, p_referee_id, 20, 'published')
  ON CONFLICT (referee_id) DO NOTHING;

  -- Add 20 permanent bonus lines to referrer
  UPDATE profiles SET bonus_lines = bonus_lines + 20 WHERE id = v_referrer_id;
END;
$$;

-- 7. RPC: increment_publish_lines   check & increment publish line counter
CREATE OR REPLACE FUNCTION public.increment_publish_lines(p_org_id UUID, p_lines INTEGER DEFAULT 1)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  INTEGER;
  v_used   INTEGER;
  v_reset  TIMESTAMPTZ;
  v_bonus  INTEGER;
  v_user_id UUID;
BEGIN
  SELECT publish_lines_limit, publish_lines_used, publish_lines_reset_at
    INTO v_limit, v_used, v_reset
    FROM public.organizations WHERE id = p_org_id FOR UPDATE;

  -- Reset counter if past reset date
  IF v_reset IS NOT NULL AND NOW() > v_reset THEN
    UPDATE public.organizations
      SET publish_lines_used = 0, publish_lines_reset_at = NOW() + INTERVAL '30 days'
      WHERE id = p_org_id;
    v_used := 0;
  END IF;

  -- Get caller's bonus lines
  SELECT bonus_lines INTO v_bonus FROM profiles WHERE id = auth.uid();
  v_bonus := COALESCE(v_bonus, 0);

  -- Effective limit = base limit + bonus lines
  IF v_used + p_lines > (v_limit + v_bonus) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations
    SET publish_lines_used = publish_lines_used + p_lines
    WHERE id = p_org_id;
  RETURN TRUE;
END;
$$;

-- 8. Update get_org_limits to include publish lines
CREATE OR REPLACE FUNCTION public.get_org_limits(p_org_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'plan_tier',             plan_tier,
    'status',                status,
    'seats_total',           seats_total,
    'seats_used',            seats_used,
    'max_projects',          max_projects,
    'publish_lines_used',    publish_lines_used,
    'publish_lines_limit',   publish_lines_limit,
    'publish_lines_reset_at', publish_lines_reset_at
  )
  FROM public.organizations
  WHERE id = p_org_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.award_referral_lines(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_publish_lines(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_limits(UUID) TO authenticated;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

Expected: No errors. Verify:
```bash
supabase db diff
```

- [ ] **Step 3: Verify columns exist**

```sql
SELECT publish_lines_used, publish_lines_limit, publish_lines_reset_at
FROM organizations LIMIT 1;
-- Expected: row with publish_lines_limit = 30 or 100 based on tier

SELECT referral_code, bonus_lines FROM profiles LIMIT 3;
-- Expected: 8-char referral codes, bonus_lines = 0
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260404000002_publish_lines_referral.sql
git commit -m "feat(db): add publish lines quota and referral reward system"
```

---

## Task 3: Phase 3   Guest Sessions + Share Preview Branding

**Files:**
- Create: `supabase/migrations/20260404000003_guest_sessions_branding.sql`

- [ ] **Step 1: Create migration file**

```sql
-- =============================================================================
-- Migration: Guest sessions (1 project limit) + Share preview branding
-- =============================================================================

-- 1. guest_sessions table (browser fingerprint → project creation tracking)
CREATE TABLE IF NOT EXISTS guest_sessions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fingerprint      TEXT NOT NULL UNIQUE,
  projects_created INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_active_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_fingerprint ON guest_sessions(fingerprint);

-- No RLS on guest_sessions   accessed via service role only
-- (guests are not authenticated, so auth.uid() = NULL)

-- 2. RPC: check_and_increment_guest_project
--    Returns TRUE if guest can create a project (< 1 created), increments counter
CREATE OR REPLACE FUNCTION public.check_and_increment_guest_project(p_fingerprint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created INTEGER;
BEGIN
  -- Upsert guest session
  INSERT INTO guest_sessions (fingerprint, projects_created, last_active_at)
  VALUES (p_fingerprint, 0, NOW())
  ON CONFLICT (fingerprint) DO UPDATE SET last_active_at = NOW()
  RETURNING projects_created INTO v_created;

  IF v_created IS NULL THEN
    SELECT projects_created INTO v_created FROM guest_sessions WHERE fingerprint = p_fingerprint;
  END IF;

  IF v_created >= 1 THEN
    RETURN FALSE;
  END IF;

  UPDATE guest_sessions SET projects_created = projects_created + 1
  WHERE fingerprint = p_fingerprint;
  RETURN TRUE;
END;
$$;

-- 3. preview_branding table
CREATE TABLE IF NOT EXISTS preview_branding (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id     UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  branding_type  TEXT NOT NULL DEFAULT 'footer'
    CHECK (branding_type IN ('footer', 'watermark', 'none')),
  watermark_text TEXT NOT NULL DEFAULT 'Geared by eCG',
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preview_branding_project ON preview_branding(project_id);

ALTER TABLE preview_branding ENABLE ROW LEVEL SECURITY;

-- Anyone can read branding (needed for public share links)
CREATE POLICY "preview_branding_select_public"
  ON preview_branding FOR SELECT USING (TRUE);

-- Only project members can update branding
CREATE POLICY "preview_branding_update_members"
  ON preview_branding FOR ALL
  USING (public.has_project_access(project_id));

CREATE POLICY "preview_branding_admin_all"
  ON preview_branding FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 4. Auto-set branding on project creation based on org tier
CREATE OR REPLACE FUNCTION public.set_default_preview_branding()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tier TEXT;
BEGIN
  -- Get org tier (NULL org_id = personal project = treat as free)
  IF NEW.organization_id IS NOT NULL THEN
    SELECT plan_tier INTO v_tier FROM organizations WHERE id = NEW.organization_id;
  END IF;
  v_tier := COALESCE(v_tier, 'free');

  INSERT INTO preview_branding (project_id, branding_type, watermark_text)
  VALUES (
    NEW.id,
    CASE v_tier
      WHEN 'pro'    THEN 'none'
      WHEN 'agency' THEN 'none'
      ELSE 'footer'   -- free or no org = footer branding
    END,
    'Geared by eCG'
  )
  ON CONFLICT (project_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_default_preview_branding ON projects;
CREATE TRIGGER trg_set_default_preview_branding
  AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION public.set_default_preview_branding();

-- Backfill existing projects
INSERT INTO preview_branding (project_id, branding_type, watermark_text)
SELECT
  p.id,
  CASE COALESCE(o.plan_tier, 'free')
    WHEN 'pro'    THEN 'none'
    WHEN 'agency' THEN 'none'
    ELSE 'footer'
  END,
  'Geared by eCG'
FROM projects p
LEFT JOIN organizations o ON o.id = p.organization_id
ON CONFLICT (project_id) DO NOTHING;

-- 5. first_time_test_run: track 90-day cached preview access tokens
CREATE TABLE IF NOT EXISTS preview_access_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token       UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  fingerprint TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days'),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_preview_tokens_token   ON preview_access_tokens(token);
CREATE INDEX IF NOT EXISTS idx_preview_tokens_project ON preview_access_tokens(project_id);

-- RPC: get_or_create_preview_token   idempotent, returns existing token if valid
CREATE OR REPLACE FUNCTION public.get_or_create_preview_token(
  p_project_id UUID,
  p_fingerprint TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token UUID;
BEGIN
  -- Look for existing non-expired token for this fingerprint + project
  SELECT token INTO v_token
  FROM preview_access_tokens
  WHERE project_id = p_project_id
    AND fingerprint = p_fingerprint
    AND expires_at > NOW()
  LIMIT 1;

  IF v_token IS NOT NULL THEN
    UPDATE preview_access_tokens SET last_used_at = NOW() WHERE token = v_token;
    RETURN v_token;
  END IF;

  -- Create new token
  INSERT INTO preview_access_tokens (project_id, fingerprint)
  VALUES (p_project_id, p_fingerprint)
  RETURNING token INTO v_token;

  RETURN v_token;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_project(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_preview_token(UUID, TEXT) TO anon, authenticated;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

- [ ] **Step 3: Verify**

```sql
SELECT COUNT(*) FROM preview_branding;
-- Expected: equals count of existing projects

SELECT branding_type, COUNT(*) FROM preview_branding GROUP BY branding_type;
-- Expected: all existing projects show 'footer' (assuming all are on free tier)
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260404000003_guest_sessions_branding.sql
git commit -m "feat(db): add guest sessions, preview branding, and 90-day access tokens"
```

---

## Task 4: Phase 4   Agency Features

**Files:**
- Create: `supabase/migrations/20260404000004_agency_features.sql`

- [ ] **Step 1: Create migration file**

```sql
-- =============================================================================
-- Migration: Agency features   client markup pricing + demo requests
-- =============================================================================

-- 1. client_markups   per-client pricing set by agency admins
CREATE TABLE IF NOT EXISTS client_markups (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  markup_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  markup_type    TEXT NOT NULL DEFAULT 'fixed'
    CHECK (markup_type IN ('fixed', 'percentage')),
  currency       TEXT NOT NULL DEFAULT 'USD',
  created_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, client_user_id)
);

CREATE INDEX IF NOT EXISTS idx_client_markups_org    ON client_markups(org_id);
CREATE INDEX IF NOT EXISTS idx_client_markups_client ON client_markups(client_user_id);

ALTER TABLE client_markups ENABLE ROW LEVEL SECURITY;

-- Agency admins can manage markups for their org
CREATE POLICY "client_markups_agency_admin"
  ON client_markups FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
    AND org_id IN (
      SELECT id FROM organizations WHERE plan_tier = 'agency'
    )
  );

CREATE POLICY "client_markups_admin_all"
  ON client_markups FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 2. demo_requests   upgrade-to-agency request flow
CREATE TABLE IF NOT EXISTS demo_requests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID REFERENCES organizations(id) ON DELETE SET NULL,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  company_name TEXT NOT NULL,
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'contacted', 'converted', 'rejected')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  admin_notes  TEXT,
  converted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  converted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_demo_requests_status  ON demo_requests(status);
CREATE INDEX IF NOT EXISTS idx_demo_requests_user_id ON demo_requests(user_id);

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;

-- Users can insert and view their own requests
CREATE POLICY "demo_requests_own"
  ON demo_requests FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "demo_requests_insert"
  ON demo_requests FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Admins can manage all demo requests
CREATE POLICY "demo_requests_admin_all"
  ON demo_requests FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 3. RPC: submit_demo_request
CREATE OR REPLACE FUNCTION public.submit_demo_request(
  p_email        TEXT,
  p_company_name TEXT,
  p_message      TEXT DEFAULT NULL,
  p_org_id       UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id UUID;
BEGIN
  INSERT INTO demo_requests (user_id, org_id, email, company_name, message)
  VALUES (auth.uid(), p_org_id, p_email, p_company_name, p_message)
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$;

-- 4. RPC: convert_demo_to_agency   super_admin upgrades org to agency
CREATE OR REPLACE FUNCTION public.convert_demo_to_agency(
  p_request_id UUID,
  p_org_id     UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_my_role() NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  UPDATE organizations SET plan_tier = 'agency' WHERE id = p_org_id;

  UPDATE demo_requests
  SET status = 'converted', converted_by = auth.uid(), converted_at = NOW()
  WHERE id = p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_demo_request(TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_demo_to_agency(UUID, UUID) TO authenticated;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

- [ ] **Step 3: Verify**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('client_markups', 'demo_requests');
-- Expected: both rows returned
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260404000004_agency_features.sql
git commit -m "feat(db): add agency client markup pricing and demo request flow"
```

---

## Task 5: Phase 5   Add-on Products

**Files:**
- Create: `supabase/migrations/20260404000005_addon_products.sql`

- [ ] **Step 1: Create migration file**

```sql
-- =============================================================================
-- Migration: Add-on products   Auto Pilot, eComGear Cloud, Integration Apps,
--            Ali Cloud hosting, Add-on subscriptions
-- =============================================================================

-- 1. auto_pilot_configs
CREATE TABLE IF NOT EXISTS auto_pilot_configs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  schedule    TEXT NOT NULL DEFAULT 'daily'
    CHECK (schedule IN ('daily', 'weekly')),
  prompt      TEXT NOT NULL DEFAULT 'Review this project for issues and improvements. Fix any bugs found.',
  status      TEXT NOT NULL DEFAULT 'paused'
    CHECK (status IN ('active', 'paused', 'error')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auto_pilot_next_run ON auto_pilot_configs(next_run_at)
  WHERE enabled = TRUE AND status = 'active';

ALTER TABLE auto_pilot_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auto_pilot_project_access"
  ON auto_pilot_configs FOR ALL
  USING (public.has_project_access(project_id));

CREATE POLICY "auto_pilot_admin_all"
  ON auto_pilot_configs FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 2. ecomgear_cloud_configs
CREATE TABLE IF NOT EXISTS ecomgear_cloud_configs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id          UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  storage_bucket      TEXT,
  cdn_url             TEXT,
  storage_used_bytes  BIGINT NOT NULL DEFAULT 0,
  storage_limit_bytes BIGINT NOT NULL DEFAULT 1073741824, -- 1 GB default
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ecomgear_cloud_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ecomgear_cloud_project_access"
  ON ecomgear_cloud_configs FOR ALL
  USING (public.has_project_access(project_id));

CREATE POLICY "ecomgear_cloud_admin_all"
  ON ecomgear_cloud_configs FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 3. integration_apps (catalog)
CREATE TABLE IF NOT EXISTS integration_apps (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon_url    TEXT,
  category    TEXT NOT NULL DEFAULT 'ecommerce'
    CHECK (category IN ('ecommerce', 'payment', 'marketing', 'analytics', 'shipping', 'other')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed integration catalog
INSERT INTO integration_apps (name, slug, description, category) VALUES
  ('Shopify',    'shopify',    'Connect your Shopify store catalog and sync products', 'ecommerce'),
  ('WooCommerce','woocommerce','Integrate with WooCommerce for product management',    'ecommerce'),
  ('Stripe',     'stripe',     'Accept payments with Stripe checkout',                 'payment'),
  ('PayPal',     'paypal',     'Add PayPal payment options to your store',             'payment'),
  ('Mailchimp',  'mailchimp',  'Sync customer lists and automate email campaigns',     'marketing'),
  ('Google Analytics','google-analytics','Track visitors and conversions',            'analytics'),
  ('FedEx',      'fedex',      'Real-time FedEx shipping rates and tracking',          'shipping'),
  ('DHL',        'dhl',        'DHL international shipping integration',               'shipping')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE integration_apps ENABLE ROW LEVEL SECURITY;

-- Everyone can read the catalog
CREATE POLICY "integration_apps_read_all"
  ON integration_apps FOR SELECT USING (TRUE);

-- Only admins can manage the catalog
CREATE POLICY "integration_apps_admin_all"
  ON integration_apps FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 4. project_integrations (per-project installs)
CREATE TABLE IF NOT EXISTS project_integrations (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  integration_app_id UUID NOT NULL REFERENCES integration_apps(id) ON DELETE CASCADE,
  config             JSONB NOT NULL DEFAULT '{}',
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  installed_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  installed_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, integration_app_id)
);

CREATE INDEX IF NOT EXISTS idx_project_integrations_project ON project_integrations(project_id);

ALTER TABLE project_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_integrations_access"
  ON project_integrations FOR ALL
  USING (public.has_project_access(project_id));

CREATE POLICY "project_integrations_admin_all"
  ON project_integrations FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 5. ali_cloud_configs
CREATE TABLE IF NOT EXISTS ali_cloud_configs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id       UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  region           TEXT NOT NULL DEFAULT 'cn-hangzhou',
  instance_id      TEXT,
  endpoint_url     TEXT,
  migration_status TEXT NOT NULL DEFAULT 'none'
    CHECK (migration_status IN ('none','pending','migrating','complete','failed')),
  migrated_at      TIMESTAMPTZ,
  requested_at     TIMESTAMPTZ DEFAULT NOW(),
  admin_notes      TEXT
);

ALTER TABLE ali_cloud_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ali_cloud_project_access"
  ON ali_cloud_configs FOR ALL
  USING (public.has_project_access(project_id));

CREATE POLICY "ali_cloud_admin_all"
  ON ali_cloud_configs FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 6. addon_subscriptions
CREATE TABLE IF NOT EXISTS addon_subscriptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id            UUID REFERENCES projects(id) ON DELETE CASCADE,
  addon_type            TEXT NOT NULL
    CHECK (addon_type IN ('auto_pilot','ecomgear_cloud','integration_app','ali_cloud')),
  price_usd             NUMERIC(10,2) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','cancelled','pending')),
  stripe_subscription_id TEXT,
  activated_at          TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at          TIMESTAMPTZ,
  UNIQUE(org_id, project_id, addon_type)
);

CREATE INDEX IF NOT EXISTS idx_addon_subscriptions_org    ON addon_subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_addon_subscriptions_status ON addon_subscriptions(status);

ALTER TABLE addon_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "addon_subscriptions_org_admin"
  ON addon_subscriptions FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('admin','billing_admin')
    )
  );

CREATE POLICY "addon_subscriptions_admin_all"
  ON addon_subscriptions FOR ALL
  USING (public.get_my_role() IN ('admin','super_admin'));

-- 7. RPC: check_addon_access
CREATE OR REPLACE FUNCTION public.check_addon_access(p_org_id UUID, p_addon_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM addon_subscriptions
    WHERE org_id = p_org_id
      AND addon_type = p_addon_type
      AND status = 'active'
  );
$$;

-- 8. RPC: get_due_auto_pilot_projects   for cron runner
CREATE OR REPLACE FUNCTION public.get_due_auto_pilot_projects()
RETURNS TABLE(project_id UUID, app_path TEXT, prompt TEXT, config_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    apc.project_id,
    p.name AS app_path,
    apc.prompt,
    apc.id AS config_id
  FROM auto_pilot_configs apc
  JOIN projects p ON p.id = apc.project_id
  WHERE apc.enabled = TRUE
    AND apc.status = 'active'
    AND (apc.next_run_at IS NULL OR apc.next_run_at <= NOW())
  ORDER BY apc.next_run_at ASC NULLS FIRST
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.check_addon_access(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_due_auto_pilot_projects() TO service_role;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

- [ ] **Step 3: Verify integration catalog**

```sql
SELECT name, slug, category FROM integration_apps ORDER BY category;
-- Expected: 8 rows (Shopify, WooCommerce, Stripe, PayPal, Mailchimp, Google Analytics, FedEx, DHL)
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260404000005_addon_products.sql
git commit -m "feat(db): add Auto Pilot, eComGear Cloud, Integration Apps, Ali Cloud, addon_subscriptions"
```

---

## Task 6: Phase 6   RLS + Permission Updates

**Files:**
- Create: `supabase/migrations/20260404000006_rls_permissions_update.sql`

- [ ] **Step 1: Create migration file**

```sql
-- =============================================================================
-- Migration: Update all RLS policies to use pro/agency tier names
--            Update has_project_access for public share links
-- =============================================================================

-- 1. Update has_project_access to allow public preview token access
CREATE OR REPLACE FUNCTION public.has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = p_project_id
      AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
  )
  OR EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members om ON om.org_id = p.organization_id
    WHERE p.id = p_project_id
      AND om.user_id = auth.uid()
      AND om.role = 'admin'
  )
  OR EXISTS (
    SELECT 1 FROM project_member_access pma
    WHERE pma.project_id = p_project_id
      AND pma.user_id = auth.uid()
  );
END;
$$;

-- 2. has_public_preview_access   validates 90-day token
CREATE OR REPLACE FUNCTION public.has_public_preview_access(p_project_id UUID, p_token UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM preview_access_tokens
    WHERE project_id = p_project_id
      AND token = p_token
      AND expires_at > NOW()
  );
$$;

-- 3. Update admin_orgs_all to use new plan_tier check (no change needed   uses get_my_role not tier)
-- But update any hardcoded tier references in existing policies:

-- Fix any CHECK constraints that reference old tier names (belt-and-suspenders)
-- The organizations.plan_tier column was already migrated in Phase 1,
-- but we add a belt-and-suspenders validation function:
CREATE OR REPLACE FUNCTION public.is_valid_plan_tier(p_tier TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_tier IN ('free', 'pro', 'agency');
$$;

-- 4. Add RLS for the new tables created in phases 2-5 that need service_role bypass
-- (service_role bypasses RLS by default in Supabase, but explicit policies help with auditing)

-- guest_sessions: accessible by service_role + anon for check_and_increment_guest_project RPC
GRANT SELECT, INSERT, UPDATE ON guest_sessions TO service_role;

-- preview_access_tokens: service_role can manage
GRANT SELECT, INSERT, UPDATE ON preview_access_tokens TO service_role;

-- auto_pilot_configs: service_role can update last_run_at / next_run_at
GRANT SELECT, UPDATE ON auto_pilot_configs TO service_role;

-- 5. Ensure all new tables have proper anon/authenticated grants
GRANT SELECT ON integration_apps TO anon, authenticated;
GRANT SELECT ON preview_branding TO anon, authenticated;

-- 6. Update sync_org_plan_limits to also handle publish_lines on existing agencies/pros
-- (ensures backfill if trigger was missed)
UPDATE organizations
SET publish_lines_limit =
  CASE plan_tier
    WHEN 'free'   THEN 30
    WHEN 'pro'    THEN 100
    WHEN 'agency' THEN 100
    ELSE 30
  END
WHERE publish_lines_limit NOT IN (30, 100);

GRANT EXECUTE ON FUNCTION public.has_public_preview_access(UUID, UUID) TO anon, authenticated;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

- [ ] **Step 3: Confirm full migration set applied**

```bash
supabase migration list
```

Expected: All 6 new migrations listed as applied (20260404000001 through 20260404000006).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260404000006_rls_permissions_update.sql
git commit -m "feat(db): update RLS policies for new tiers and public preview access"
```

---

## Task 7: Update TypeScript Types

**Files:**
- Modify: `src/integrations/supabase/types.ts`

- [ ] **Step 1: Update PlanTier and add new types**

In `src/integrations/supabase/types.ts`, make these changes:

Replace line 18:
```typescript
export type PlanTier = 'free' | 'starter' | 'professional' | 'enterprise'
```
With:
```typescript
export type PlanTier = 'free' | 'pro' | 'agency'
```

After line 31 (`export type DomainStatus = ...`), add:
```typescript
export type BrandingType = 'footer' | 'watermark' | 'none'
export type AutoPilotSchedule = 'daily' | 'weekly'
export type AutoPilotStatus = 'active' | 'paused' | 'error'
export type MarkupType = 'fixed' | 'percentage'
export type DemoRequestStatus = 'pending' | 'contacted' | 'converted' | 'rejected'
export type AliCloudMigrationStatus = 'none' | 'pending' | 'migrating' | 'complete' | 'failed'
export type IntegrationCategory = 'ecommerce' | 'payment' | 'marketing' | 'analytics' | 'shipping' | 'other'
export type AddonType = 'auto_pilot' | 'ecomgear_cloud' | 'integration_app' | 'ali_cloud'
export type AddonStatus = 'active' | 'cancelled' | 'pending'
```

Then in the `Database` Tables section, after the last existing table definition, add these table row types (before the closing `}` of `Tables`):

```typescript
      referral_rewards: {
        Row: {
          id: string
          referrer_id: string
          referee_id: string
          lines_earned: number
          awarded_at: string
          trigger_event: string
        }
        Insert: {
          id?: string
          referrer_id: string
          referee_id: string
          lines_earned?: number
          awarded_at?: string
          trigger_event?: string
        }
        Update: {
          lines_earned?: number
        }
      }
      guest_sessions: {
        Row: {
          id: string
          fingerprint: string
          projects_created: number
          created_at: string
          last_active_at: string
        }
        Insert: {
          id?: string
          fingerprint: string
          projects_created?: number
          created_at?: string
          last_active_at?: string
        }
        Update: {
          projects_created?: number
          last_active_at?: string
        }
      }
      preview_branding: {
        Row: {
          id: string
          project_id: string
          branding_type: BrandingType
          watermark_text: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          branding_type?: BrandingType
          watermark_text?: string
          updated_at?: string
        }
        Update: {
          branding_type?: BrandingType
          watermark_text?: string
          updated_at?: string
        }
      }
      preview_access_tokens: {
        Row: {
          id: string
          project_id: string
          token: string
          fingerprint: string | null
          created_at: string
          expires_at: string
          last_used_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          token?: string
          fingerprint?: string | null
          created_at?: string
          expires_at?: string
          last_used_at?: string | null
        }
        Update: {
          last_used_at?: string | null
        }
      }
      client_markups: {
        Row: {
          id: string
          org_id: string
          client_user_id: string
          markup_amount: number
          markup_type: MarkupType
          currency: string
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          client_user_id: string
          markup_amount: number
          markup_type?: MarkupType
          currency?: string
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          markup_amount?: number
          markup_type?: MarkupType
          currency?: string
          updated_at?: string
        }
      }
      demo_requests: {
        Row: {
          id: string
          org_id: string | null
          user_id: string
          email: string
          company_name: string
          message: string | null
          status: DemoRequestStatus
          requested_at: string
          admin_notes: string | null
          converted_by: string | null
          converted_at: string | null
        }
        Insert: {
          id?: string
          org_id?: string | null
          user_id: string
          email: string
          company_name: string
          message?: string | null
          status?: DemoRequestStatus
          requested_at?: string
          admin_notes?: string | null
          converted_by?: string | null
          converted_at?: string | null
        }
        Update: {
          status?: DemoRequestStatus
          admin_notes?: string | null
          converted_by?: string | null
          converted_at?: string | null
        }
      }
      auto_pilot_configs: {
        Row: {
          id: string
          project_id: string
          enabled: boolean
          schedule: AutoPilotSchedule
          prompt: string
          status: AutoPilotStatus
          last_run_at: string | null
          next_run_at: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          enabled?: boolean
          schedule?: AutoPilotSchedule
          prompt?: string
          status?: AutoPilotStatus
          last_run_at?: string | null
          next_run_at?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          schedule?: AutoPilotSchedule
          prompt?: string
          status?: AutoPilotStatus
          last_run_at?: string | null
          next_run_at?: string | null
          updated_at?: string
        }
      }
      ecomgear_cloud_configs: {
        Row: {
          id: string
          project_id: string
          enabled: boolean
          storage_bucket: string | null
          cdn_url: string | null
          storage_used_bytes: number
          storage_limit_bytes: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          enabled?: boolean
          storage_bucket?: string | null
          cdn_url?: string | null
          storage_used_bytes?: number
          storage_limit_bytes?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          storage_bucket?: string | null
          cdn_url?: string | null
          storage_used_bytes?: number
          updated_at?: string
        }
      }
      integration_apps: {
        Row: {
          id: string
          name: string
          slug: string
          description: string
          icon_url: string | null
          category: IntegrationCategory
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          description?: string
          icon_url?: string | null
          category?: IntegrationCategory
          is_active?: boolean
          created_at?: string
        }
        Update: {
          description?: string
          icon_url?: string | null
          category?: IntegrationCategory
          is_active?: boolean
        }
      }
      project_integrations: {
        Row: {
          id: string
          project_id: string
          integration_app_id: string
          config: Record<string, unknown>
          enabled: boolean
          installed_by: string | null
          installed_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          integration_app_id: string
          config?: Record<string, unknown>
          enabled?: boolean
          installed_by?: string | null
          installed_at?: string
          updated_at?: string
        }
        Update: {
          config?: Record<string, unknown>
          enabled?: boolean
          updated_at?: string
        }
      }
      ali_cloud_configs: {
        Row: {
          id: string
          project_id: string
          region: string
          instance_id: string | null
          endpoint_url: string | null
          migration_status: AliCloudMigrationStatus
          migrated_at: string | null
          requested_at: string
          admin_notes: string | null
        }
        Insert: {
          id?: string
          project_id: string
          region?: string
          instance_id?: string | null
          endpoint_url?: string | null
          migration_status?: AliCloudMigrationStatus
          migrated_at?: string | null
          requested_at?: string
          admin_notes?: string | null
        }
        Update: {
          region?: string
          instance_id?: string | null
          endpoint_url?: string | null
          migration_status?: AliCloudMigrationStatus
          migrated_at?: string | null
          admin_notes?: string | null
        }
      }
      addon_subscriptions: {
        Row: {
          id: string
          org_id: string
          project_id: string | null
          addon_type: AddonType
          price_usd: number
          status: AddonStatus
          stripe_subscription_id: string | null
          activated_at: string
          cancelled_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          project_id?: string | null
          addon_type: AddonType
          price_usd?: number
          status?: AddonStatus
          stripe_subscription_id?: string | null
          activated_at?: string
          cancelled_at?: string | null
        }
        Update: {
          price_usd?: number
          status?: AddonStatus
          stripe_subscription_id?: string | null
          cancelled_at?: string | null
        }
      }
```

Also update `profiles` Row/Insert/Update to include the new referral columns. Find the `profiles` Row type and add these fields:

```typescript
          referral_code: string | null
          referred_by: string | null
          bonus_lines: number
```

Add matching `Insert` and `Update` entries for profiles:
```typescript
          // Insert:
          referral_code?: string | null
          referred_by?: string | null
          bonus_lines?: number
          // Update:
          referral_code?: string | null
          referred_by?: string | null
          bonus_lines?: number
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
npx tsc --noEmit 2>&1 | head -40
```

Expected: No errors related to PlanTier, new table types, or referral fields. Fix any type errors that appear.

- [ ] **Step 3: Commit**

```bash
git add src/integrations/supabase/types.ts
git commit -m "feat(types): update PlanTier to free/pro/agency, add 12 new table types"
```

---

## Task 8: Update Subscription Service

**Files:**
- Modify: `src/services/subscriptionService.ts`

- [ ] **Step 1: Rewrite subscriptionService.ts**

Replace the entire file content with:

```typescript
/**
 * Subscription service   reads plan limits, checks quotas, tracks usage.
 * All reads go through SECURITY DEFINER RPCs (bypasses RLS recursion issues).
 */

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { PlanTier, AddonType } from '@/integrations/supabase/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrgLimits {
  plan_tier: PlanTier;
  status: 'active' | 'suspended' | 'cancelled';
  seats_total: number;
  seats_used: number;
  max_projects: number;
  publish_lines_used: number;
  publish_lines_limit: number;
  publish_lines_reset_at: string | null;
}

export const TIER_LABELS: Record<PlanTier, string> = {
  free:   'Free',
  pro:    'Pro',
  agency: 'Agency',
};

export const TIER_PRICES: Record<PlanTier, number> = {
  free:   0,
  pro:    8,
  agency: 25,
};

export const TIER_LIMITS: Record<PlanTier, Pick<OrgLimits, 'seats_total' | 'max_projects' | 'publish_lines_limit'>> = {
  free:   { seats_total: 1,  max_projects: 1,       publish_lines_limit: 30  },
  pro:    { seats_total: 5,  max_projects: 999999,  publish_lines_limit: 100 },
  agency: { seats_total: 20, max_projects: 999999,  publish_lines_limit: 100 },
};

export const TIER_FEATURES: Record<PlanTier, Record<string, boolean>> = {
  free:   {
    custom_domains: false,
    remove_branding: false,
    invite_editors: false,
    invite_clients: false,
    ai_agent: false,
    hosting: false,
    ali_cloud: false,
    ecomgear_cloud: false,
    integration_app: false,
    auto_pilot: false,
  },
  pro:    {
    custom_domains: true,
    remove_branding: true,
    invite_editors: true,
    invite_clients: false,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: true,
  },
  agency: {
    custom_domains: true,
    remove_branding: true,
    invite_editors: true,
    invite_clients: true,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: true,
  },
};

// ── API ──────────────────────────────────────────────────────────────────────

export async function fetchOrgLimits(orgId: string): Promise<OrgLimits | null> {
  const { data, error } = await supabase.rpc('get_org_limits', { p_org_id: orgId });
  if (error) {
    console.warn('fetchOrgLimits error:', error.message);
    return null;
  }
  return data as OrgLimits;
}

export async function countOrgProjects(orgId: string): Promise<number> {
  const { data, error } = await supabase.rpc('count_org_projects', { p_org_id: orgId });
  if (error) return 0;
  return (data as number) || 0;
}

export async function canCreateProject(orgId: string | null): Promise<{
  allowed: boolean;
  reason?: string;
  upgradeNeeded?: PlanTier;
}> {
  if (!orgId) return { allowed: true };

  const [limits, projectCount] = await Promise.all([
    fetchOrgLimits(orgId),
    countOrgProjects(orgId),
  ]);

  if (!limits) return { allowed: true };

  if (limits.status !== 'active') {
    return { allowed: false, reason: `Organization is ${limits.status}. Contact support.` };
  }

  if (projectCount >= limits.max_projects) {
    const next = nextTier(limits.plan_tier);
    return {
      allowed: false,
      reason: `You've reached the ${limits.max_projects} project limit on the ${TIER_LABELS[limits.plan_tier]} plan.`,
      upgradeNeeded: next,
    };
  }

  return { allowed: true };
}

export async function canInviteMember(orgId: string): Promise<{
  allowed: boolean;
  reason?: string;
  upgradeNeeded?: PlanTier;
}> {
  const limits = await fetchOrgLimits(orgId);
  if (!limits) return { allowed: true };

  if (limits.seats_used >= limits.seats_total) {
    const next = nextTier(limits.plan_tier);
    return {
      allowed: false,
      reason: `You've used all ${limits.seats_total} seats on the ${TIER_LABELS[limits.plan_tier]} plan.`,
      upgradeNeeded: next,
    };
  }
  return { allowed: true };
}

/**
 * Check and increment publish lines counter.
 * Returns false if org is over their monthly limit (base + bonus lines).
 */
export async function checkAndIncrementPublishLines(
  orgId: string | null,
  lines: number = 1
): Promise<boolean> {
  if (!orgId) return true;

  const { data, error } = await supabase.rpc('increment_publish_lines', {
    p_org_id: orgId,
    p_lines: lines,
  });

  if (error) {
    console.warn('increment_publish_lines error:', error.message);
    return true; // fail open
  }
  return data as boolean;
}

/**
 * Check if an org has an active add-on subscription.
 */
export async function checkAddonAccess(orgId: string, addonType: AddonType): Promise<boolean> {
  const { data, error } = await supabase.rpc('check_addon_access', {
    p_org_id: orgId,
    p_addon_type: addonType,
  });
  if (error) return false;
  return data as boolean;
}

export function trackUsage(
  userId: string,
  action: string,
  opts: { orgId?: string | null; projectId?: string | null; metadata?: Record<string, unknown> } = {}
): void {
  supabase
    .from('usage_tracking')
    .insert({
      user_id: userId,
      org_id: opts.orgId ?? null,
      project_id: opts.projectId ?? null,
      action,
      metadata: opts.metadata ?? {},
    })
    .then(({ error }) => {
      if (error) console.warn('trackUsage error:', error.message);
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nextTier(current: PlanTier): PlanTier {
  const order: PlanTier[] = ['free', 'pro', 'agency'];
  const idx = order.indexOf(current);
  return order[Math.min(idx + 1, order.length - 1)];
}

export function showLimitToast(reason: string, upgradeNeeded?: PlanTier): false {
  toast.error(reason, {
    description: upgradeNeeded
      ? `Upgrade to ${TIER_LABELS[upgradeNeeded]} to continue.`
      : undefined,
    duration: 6000,
    action: upgradeNeeded
      ? {
          label: 'Upgrade',
          onClick: () => {
            window.location.href = '/dashboard/settings?section=workspace-subscription';
          },
        }
      : undefined,
  });
  return false;
}
```

- [ ] **Step 2: Check for usages of old function names**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
grep -r "checkAndIncrementAIGen\|ai_gens_used\|ai_gens_limit\|TIER_LIMITS\.\(starter\|professional\|enterprise\)" src/ --include="*.ts" --include="*.tsx" -l
```

For each file found, replace:
- `checkAndIncrementAIGen` → `checkAndIncrementPublishLines`
- `ai_gens_used` → `publish_lines_used`
- `ai_gens_limit` → `publish_lines_limit`
- `ai_gens_reset_at` → `publish_lines_reset_at`
- Tier names `'starter'`, `'professional'`, `'enterprise'` → `'free'`, `'pro'`, `'agency'` respectively

- [ ] **Step 3: Update useSubscription.ts**

Open `src/hooks/useSubscription.ts` and update the `SubscriptionState` interface and any references to old field names:

Replace any occurrence of:
```typescript
ai_gens_used
ai_gens_limit
ai_gens_reset_at
aiGenPercent
```
With:
```typescript
publish_lines_used
publish_lines_limit
publish_lines_reset_at
publishLinesPercent
```

Also update the `aiGenPercent` computed property to:
```typescript
const publishLinesPercent = limits
  ? Math.round((limits.publish_lines_used / (limits.publish_lines_limit)) * 100)
  : 0;
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: No errors. Fix any remaining references to old tier names or field names.

- [ ] **Step 5: Commit**

```bash
git add src/services/subscriptionService.ts src/hooks/useSubscription.ts
git commit -m "feat(services): replace AI gen quota with publish lines, update to free/pro/agency tiers"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Run full migration list**

```bash
supabase migration list
```

Expected: 6 new migrations (20260404000001–20260404000006) all showing as applied.

- [ ] **Step 2: TypeScript clean build**

```bash
npx tsc --noEmit 2>&1 | wc -l
```

Expected: 0 lines (no errors). If errors exist, fix them before continuing to Plan B.

- [ ] **Step 3: Final commit**

```bash
git add -A
git status
# Verify only intended files are staged
git commit -m "feat: complete Plan A   tier migration, publish lines, referral, guest sessions, agency features, add-on products"
```

---

## Summary of What Was Built

| Phase | What it does |
|-------|-------------|
| Migration 1 | Renames tiers to free/pro/agency, sets new seat/project limits |
| Migration 2 | Adds publish lines quota (30/100 per month), referral codes, bonus_lines, referral_rewards table, award_referral_lines RPC |
| Migration 3 | Guest sessions (1-project limit by fingerprint), preview_branding per project, 90-day preview access tokens |
| Migration 4 | client_markups (Agency per-client pricing), demo_requests table, submit/convert RPCs |
| Migration 5 | auto_pilot_configs, ecomgear_cloud_configs, integration_apps catalog (8 apps), project_integrations, ali_cloud_configs, addon_subscriptions |
| Migration 6 | RLS tightening, public preview access function, grant cleanup |
| types.ts | PlanTier updated, 12 new table types added |
| subscriptionService.ts | AI gens replaced with publish lines, TIER_FEATURES updated for new tiers |
