-- =============================================================================
-- Phase 1b: Tier Rename data migration + triggers
-- Enum values 'pro' and 'agency' were already added in migration 20260404000000
-- =============================================================================

-- ── 2. Migrate existing data ─────────────────────────────────────────────────
--  starter      → free   (downgrade: starter had 3 seats/5 projects, now 1/1)
--  professional → pro    (1:1   10 seats/unlimited projects → 5 seats/unlimited)
--  enterprise   → agency (1:1   unlimited seats → 20 seats/unlimited)
UPDATE public.organizations
SET plan_tier = CASE
  WHEN plan_tier::text = 'starter'      THEN 'free'::plan_tier
  WHEN plan_tier::text = 'professional' THEN 'pro'::plan_tier
  WHEN plan_tier::text = 'enterprise'   THEN 'agency'::plan_tier
  ELSE plan_tier
END
WHERE plan_tier::text IN ('starter', 'professional', 'enterprise');

-- ── 3. Replace sync_org_plan_limits() trigger with new tier config ────────────
CREATE OR REPLACE FUNCTION public.sync_org_plan_limits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  CASE NEW.plan_tier::text
    WHEN 'free' THEN
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 4000;
    WHEN 'pro' THEN
      NEW.seats_total   := 5;
      NEW.max_projects  := 2147483647;   -- unlimited (INT max)
      NEW.ai_gens_limit := 1000000;
    WHEN 'agency' THEN
      NEW.seats_total   := 20;
      NEW.max_projects  := 2147483647;
      NEW.ai_gens_limit := 1000000;
    -- legacy values   treat like their migration target
    WHEN 'starter' THEN
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 4000;
    WHEN 'professional' THEN
      NEW.seats_total   := 5;
      NEW.max_projects  := 2147483647;
      NEW.ai_gens_limit := 1000000;
    WHEN 'enterprise' THEN
      NEW.seats_total   := 20;
      NEW.max_projects  := 2147483647;
      NEW.ai_gens_limit := 1000000;
    ELSE
      NEW.seats_total   := 1;
      NEW.max_projects  := 1;
      NEW.ai_gens_limit := 4000;
  END CASE;
  RETURN NEW;
END;
$$;

-- ── 4. Backfill limits for all orgs with the new values ──────────────────────
UPDATE public.organizations o
SET
  seats_total   = CASE o.plan_tier::text
                    WHEN 'free'    THEN 1
                    WHEN 'pro'     THEN 5
                    WHEN 'agency'  THEN 20
                    ELSE 1
                  END,
  max_projects  = CASE o.plan_tier::text
                    WHEN 'free'    THEN 1
                    WHEN 'pro'     THEN 2147483647
                    WHEN 'agency'  THEN 2147483647
                    ELSE 1
                  END,
  ai_gens_limit = CASE o.plan_tier::text
                    WHEN 'free'    THEN 4000
                    WHEN 'pro'     THEN 1000000
                    WHEN 'agency'  THEN 1000000
                    ELSE 4000
                  END;

-- ── 5. Replace get_org_limits() RPC   update returned tier label ──────────────
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

  SELECT COUNT(*) INTO v_seats_used
  FROM public.org_members
  WHERE org_id = p_org_id;

  RETURN jsonb_build_object(
    'plan_tier',       v_row.plan_tier,
    'status',          COALESCE(v_row.status, 'active'),
    'seats_total',     v_row.seats_total,
    'seats_used',      v_seats_used,
    'max_projects',    v_row.max_projects,
    'ai_gens_used',    v_row.ai_gens_used,
    'ai_gens_limit',   v_row.ai_gens_limit,
    'ai_gens_reset_at', v_row.ai_gens_reset_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_limits(uuid) TO authenticated;

-- ── 6. Update seed org (admin org) to agency tier ────────────────────────────
UPDATE public.organizations
SET plan_tier = 'agency'::plan_tier
WHERE slug = 'SMEsAgent-admin';

COMMENT ON COLUMN public.organizations.plan_tier IS 'Active plan tiers: free | pro | agency. Legacy values starter/professional/enterprise are preserved in enum for backward compatibility but no longer assigned.';
