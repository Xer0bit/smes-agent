-- =============================================================================
-- Phase 2: Publish Lines + Referral System
-- Replaces ai_gens-based quota with publish_lines (monthly, not 24h rolling)
-- =============================================================================

-- ── 1. Add publish lines columns to organizations ────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS publish_lines_used    integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS publish_lines_limit   integer  NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS publish_lines_reset_at timestamptz;

-- ── 2. Seed publish_lines_limit per current tier ─────────────────────────────
UPDATE public.organizations
SET
  publish_lines_limit  = CASE plan_tier::text
                           WHEN 'free'    THEN 30
                           WHEN 'pro'     THEN 100
                           WHEN 'agency'  THEN 100
                           ELSE 30
                         END,
  publish_lines_reset_at = date_trunc('month', now()) + interval '1 month';

-- ── 3. Update sync_org_plan_limits() to also set publish_lines_limit ─────────
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  CASE NEW.plan_tier::text
    WHEN 'free' THEN
      NEW.seats_total          := 1;
      NEW.max_projects         := 1;
      NEW.ai_gens_limit        := 4000;
      NEW.publish_lines_limit  := 30;
    WHEN 'pro' THEN
      NEW.seats_total          := 5;
      NEW.max_projects         := 2147483647;
      NEW.ai_gens_limit        := 1000000;
      NEW.publish_lines_limit  := 100;
    WHEN 'agency' THEN
      NEW.seats_total          := 20;
      NEW.max_projects         := 2147483647;
      NEW.ai_gens_limit        := 1000000;
      NEW.publish_lines_limit  := 100;
    -- keep legacy aliases
    WHEN 'starter' THEN
      NEW.seats_total          := 1;
      NEW.max_projects         := 1;
      NEW.ai_gens_limit        := 4000;
      NEW.publish_lines_limit  := 30;
    WHEN 'professional' THEN
      NEW.seats_total          := 5;
      NEW.max_projects         := 2147483647;
      NEW.ai_gens_limit        := 1000000;
      NEW.publish_lines_limit  := 100;
    WHEN 'enterprise' THEN
      NEW.seats_total          := 20;
      NEW.max_projects         := 2147483647;
      NEW.ai_gens_limit        := 1000000;
      NEW.publish_lines_limit  := 100;
    ELSE
      NEW.seats_total          := 1;
      NEW.max_projects         := 1;
      NEW.ai_gens_limit        := 4000;
      NEW.publish_lines_limit  := 30;
  END CASE;
  RETURN NEW;
END;
$$;

-- ── 4. Update get_org_limits() to include publish lines ──────────────────────
CREATE OR REPLACE FUNCTION public.get_org_limits(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row organizations%ROWTYPE;
  v_seats_used integer;
BEGIN
  SELECT * INTO v_row FROM public.organizations WHERE id = p_org_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Auto-reset publish lines if the reset window has passed
  IF v_row.publish_lines_reset_at IS NOT NULL AND now() > v_row.publish_lines_reset_at THEN
    UPDATE public.organizations
    SET publish_lines_used    = 0,
        publish_lines_reset_at = date_trunc('month', now()) + interval '1 month'
    WHERE id = p_org_id;
    v_row.publish_lines_used    := 0;
    v_row.publish_lines_reset_at := date_trunc('month', now()) + interval '1 month';
  END IF;

  SELECT COUNT(*) INTO v_seats_used
  FROM public.org_members
  WHERE org_id = p_org_id;

  RETURN jsonb_build_object(
    'plan_tier',              v_row.plan_tier,
    'status',                 COALESCE(v_row.status, 'active'),
    'seats_total',            v_row.seats_total,
    'seats_used',             v_seats_used,
    'max_projects',           v_row.max_projects,
    'ai_gens_used',           v_row.ai_gens_used,
    'ai_gens_limit',          v_row.ai_gens_limit,
    'ai_gens_reset_at',       v_row.ai_gens_reset_at,
    'publish_lines_used',     v_row.publish_lines_used,
    'publish_lines_limit',    v_row.publish_lines_limit,
    'publish_lines_reset_at', v_row.publish_lines_reset_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_limits(uuid) TO authenticated;

-- ── 5. RPC: increment_publish_lines(p_org_id, p_lines) → bool (within limit) ─
CREATE OR REPLACE FUNCTION public.increment_publish_lines(
  p_org_id uuid,
  p_lines  integer DEFAULT 1
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used  integer;
  v_limit integer;
  v_reset timestamptz;
BEGIN
  SELECT publish_lines_used, publish_lines_limit, publish_lines_reset_at
  INTO v_used, v_limit, v_reset
  FROM public.organizations
  WHERE id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN true; END IF;  -- fail open

  -- Auto-reset on new month
  IF v_reset IS NOT NULL AND now() > v_reset THEN
    v_used  := 0;
    v_reset := date_trunc('month', now()) + interval '1 month';
  END IF;

  IF v_used + p_lines > v_limit THEN RETURN false; END IF;  -- over quota

  UPDATE public.organizations
  SET publish_lines_used    = v_used + p_lines,
      publish_lines_reset_at = COALESCE(v_reset, date_trunc('month', now()) + interval '1 month')
  WHERE id = p_org_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_publish_lines(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_publish_lines(uuid, integer) TO service_role;

-- ── 6. Add bonus_lines to profiles (permanent, never resets) ─────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bonus_publish_lines integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referred_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── 7. Add referral_rewards table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  referee_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lines_earned integer NOT NULL DEFAULT 20,
  awarded_at   timestamptz NOT NULL DEFAULT now(),
  trigger_event text NOT NULL DEFAULT 'first_publish',
  UNIQUE(referrer_id, referee_id)
);

ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can view their own referral rewards"
  ON public.referral_rewards FOR SELECT
  USING (auth.uid() = referrer_id OR auth.uid() = referee_id);

-- Admin bypass
CREATE POLICY "admin full access referral_rewards"
  ON public.referral_rewards FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- ── 8. RPC: award_referral_lines(p_referee_id) ────────────────────────────────
-- Called on first publish by a referred user. Awards 20 bonus lines to referrer.
CREATE OR REPLACE FUNCTION public.award_referral_lines(p_referee_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_id uuid;
  v_lines       integer := 20;
BEGIN
  -- Get referrer
  SELECT referred_by INTO v_referrer_id
  FROM public.profiles
  WHERE id = p_referee_id;

  IF v_referrer_id IS NULL THEN RETURN; END IF;

  -- Idempotent   skip if already rewarded
  IF EXISTS (
    SELECT 1 FROM public.referral_rewards
    WHERE referrer_id = v_referrer_id AND referee_id = p_referee_id
  ) THEN RETURN; END IF;

  -- Record reward
  INSERT INTO public.referral_rewards(referrer_id, referee_id, lines_earned)
  VALUES (v_referrer_id, p_referee_id, v_lines);

  -- Add bonus lines to referrer profile (permanent   these top up the org's monthly quota)
  UPDATE public.profiles
  SET bonus_publish_lines = bonus_publish_lines + v_lines
  WHERE id = v_referrer_id;

  -- Also credit the referrer's active org's publish_lines_limit directly
  UPDATE public.organizations o
  SET publish_lines_limit = publish_lines_limit + v_lines
  WHERE o.id = (
    SELECT org_id FROM public.org_members
    WHERE user_id = v_referrer_id
    ORDER BY created_at ASC
    LIMIT 1
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.award_referral_lines(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.award_referral_lines(uuid) TO service_role;
