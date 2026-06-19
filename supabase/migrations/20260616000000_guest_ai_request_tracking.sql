-- =============================================================================
-- Guest AI Request Tracking — Gemini-only, max 3 requests before login required
-- =============================================================================

-- ── 1. Add ai_requests_used column to guest_sessions ──────────────────────────
ALTER TABLE public.guest_sessions
  ADD COLUMN IF NOT EXISTS ai_requests_used integer NOT NULL DEFAULT 0;

-- ── 2. RPC: check_and_increment_guest_ai_request(fingerprint) → bool ─────────
-- Returns TRUE if the request is allowed (under limit), FALSE if at limit.
-- Atomically increments the counter.
CREATE OR REPLACE FUNCTION public.check_and_increment_guest_ai_request(p_fingerprint text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requests integer;
  v_max_requests constant integer := 3;
BEGIN
  -- Upsert: create row if not exists, then lock it
  INSERT INTO public.guest_sessions (fingerprint, ai_requests_used)
  VALUES (p_fingerprint, 0)
  ON CONFLICT (fingerprint) DO NOTHING;

  SELECT ai_requests_used INTO v_requests
  FROM public.guest_sessions
  WHERE fingerprint = p_fingerprint
  FOR UPDATE;

  IF v_requests >= v_max_requests THEN
    RETURN false;
  END IF;

  UPDATE public.guest_sessions
  SET ai_requests_used = ai_requests_used + 1,
      last_active_at = now()
  WHERE fingerprint = p_fingerprint;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_guest_ai_request(text) TO service_role;

-- ── 3. RPC: get_guest_ai_requests(fingerprint) → jsonb ───────────────────────
-- Returns current request count for display in the UI.
CREATE OR REPLACE FUNCTION public.get_guest_ai_requests(p_fingerprint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requests integer;
BEGIN
  SELECT ai_requests_used INTO v_requests
  FROM public.guest_sessions
  WHERE fingerprint = p_fingerprint;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('requests_used', 0, 'requests_limit', 3, 'can_request', true);
  END IF;

  RETURN jsonb_build_object(
    'requests_used',  v_requests,
    'requests_limit', 3,
    'can_request',    v_requests < 3
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guest_ai_requests(text) TO service_role;

-- ── 4. Allow anon to read own guest_sessions (by fingerprint) ─────────────────
-- The anon role needs to call RPCs (already granted above) and also select for
-- the frontend hook. The SECURITY DEFINER RPCs bypass RLS, so no extra policy needed.

-- ── 5. RLS policy for anon insert (guest self-registration) ──────────────────
CREATE POLICY "anon insert guest_sessions"
  ON public.guest_sessions FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "anon select guest_sessions"
  ON public.guest_sessions FOR SELECT
  TO anon
  USING (true);
