-- ─── Eco Per-Request Model (from line-counting to request-based) ──────────────
--
-- Previously: 1 eco = 1 non-empty line of generated code (integer).
-- Now:        1 eco = 1 code-action request, 0.5 eco = 1 general question.
--
-- Changes:
--   • ai_gens_used: INTEGER → NUMERIC(10,1) to support 0.5 increments
--   • increment_ai_gen: p_tokens now NUMERIC instead of INTEGER
--   • Free tier daily limit: 4000 → 50 (per-request, not per-line)

-- 1. Alter column type
ALTER TABLE public.organizations
  ALTER COLUMN ai_gens_used TYPE NUMERIC(10,1) USING ai_gens_used::NUMERIC(10,1);

-- 2. Recreate the two-arg RPC with NUMERIC p_tokens
CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID, p_tokens NUMERIC DEFAULT 1)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  NUMERIC;
  v_used   NUMERIC;
  v_reset  TIMESTAMPTZ;
  v_tokens NUMERIC;
BEGIN
  v_tokens := GREATEST(COALESCE(p_tokens, 0), 0);

  IF v_tokens = 0 THEN
    RETURN TRUE;
  END IF;

  SELECT ai_gens_limit, ai_gens_used, ai_gens_reset_at
    INTO v_limit, v_used, v_reset
    FROM public.organizations
    WHERE id = p_org_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Reset counter when rolling 24-hour window expires.
  IF v_reset IS NOT NULL AND NOW() >= v_reset THEN
    UPDATE public.organizations
      SET ai_gens_used = 0,
          ai_gens_reset_at = NOW() + INTERVAL '24 hours'
      WHERE id = p_org_id;
    v_used := 0;
  ELSIF v_reset IS NULL THEN
    UPDATE public.organizations
      SET ai_gens_reset_at = NOW() + INTERVAL '24 hours'
      WHERE id = p_org_id;
  END IF;

  IF v_used + v_tokens > v_limit THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations
  SET ai_gens_used = ai_gens_used + v_tokens
  WHERE id = p_org_id;

  RETURN TRUE;
END;
$$;

-- 3. Update the one-arg overload to call the new signature
CREATE OR REPLACE FUNCTION public.increment_ai_gen(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.increment_ai_gen(p_org_id, 1::NUMERIC);
$$;

-- 4. Update free-tier daily limit from line-based (4000) to request-based (50)
UPDATE public.organizations
SET ai_gens_limit = 50
WHERE plan_tier = 'free'
  AND ai_gens_limit = 4000;

-- 5. Reset existing line-based counters so users start fresh
-- GUARD: WHERE FALSE makes this a no-op on re-runs.
-- This was a one-time migration to clear old line-counted values.
-- Removing the guard would wipe all user eco on every deploy.
UPDATE public.organizations
SET ai_gens_used = 0
WHERE FALSE;

GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_gen(UUID) TO authenticated;
