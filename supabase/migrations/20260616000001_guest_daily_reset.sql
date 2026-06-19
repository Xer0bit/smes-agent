-- =============================================================================
-- Guest AI Request Daily Reset
-- Adds requests_reset_date to guest_sessions so the 3-request limit resets
-- each calendar day (UTC) instead of being permanent.
-- =============================================================================

-- ── 1. Add requests_reset_date column ────────────────────────────────────────
ALTER TABLE public.guest_sessions
  ADD COLUMN IF NOT EXISTS requests_reset_date date NOT NULL DEFAULT current_date;

-- ── 2. Replace check_and_increment_guest_ai_request ──────────────────────────
-- Returns TRUE if the request is allowed (under limit), FALSE if at limit.
-- Atomically resets the counter at the start of each new calendar day (UTC),
-- then increments. Single row lock prevents race conditions.
CREATE OR REPLACE FUNCTION public.check_and_increment_guest_ai_request(p_fingerprint text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requests        integer;
  v_reset_date      date;
  v_max_requests    constant integer := 3;
BEGIN
  -- Upsert: create row if not exists, or touch it so the subsequent FOR UPDATE
  -- lock is held from the same statement boundary (prevents first-insert race).
  INSERT INTO public.guest_sessions (fingerprint, ai_requests_used, requests_reset_date)
  VALUES (p_fingerprint, 0, current_date)
  ON CONFLICT (fingerprint) DO UPDATE SET last_active_at = now();

  -- Lock the row
  SELECT ai_requests_used, requests_reset_date
    INTO v_requests, v_reset_date
    FROM public.guest_sessions
   WHERE fingerprint = p_fingerprint
     FOR UPDATE;

  -- Daily reset: if last reset was before today, zero the counter
  IF current_date > v_reset_date THEN
    UPDATE public.guest_sessions
       SET ai_requests_used   = 0,
           requests_reset_date = current_date,
           last_active_at      = now()
     WHERE fingerprint = p_fingerprint;
    v_requests := 0;
  END IF;

  -- Enforce limit
  IF v_requests >= v_max_requests THEN
    RETURN false;
  END IF;

  -- Increment
  UPDATE public.guest_sessions
     SET ai_requests_used = ai_requests_used + 1,
         last_active_at   = now()
   WHERE fingerprint = p_fingerprint;

  RETURN true;
END;
$$;

-- ── 3. Replace get_guest_ai_requests ─────────────────────────────────────────
-- Returns current request count for display in the UI.
-- Applies the same date-reset logic so the UI shows 0 correctly after midnight.
CREATE OR REPLACE FUNCTION public.get_guest_ai_requests(p_fingerprint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requests     integer;
  v_reset_date   date;
  v_max_requests constant integer := 3;
BEGIN
  SELECT ai_requests_used, requests_reset_date
    INTO v_requests, v_reset_date
    FROM public.guest_sessions
   WHERE fingerprint = p_fingerprint;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('requests_used', 0, 'requests_limit', v_max_requests, 'can_request', true);
  END IF;

  -- Apply daily reset for UI accuracy (read-only, no UPDATE here)
  IF current_date > v_reset_date THEN
    v_requests := 0;
  END IF;

  RETURN jsonb_build_object(
    'requests_used',  v_requests,
    'requests_limit', v_max_requests,
    'can_request',    v_requests < v_max_requests
  );
END;
$$;

-- ── 4. Re-apply grants ────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO service_role;
