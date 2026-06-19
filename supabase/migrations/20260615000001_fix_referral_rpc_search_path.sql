-- Fix: get_or_create_referral_code fails with
--   "function gen_random_bytes(integer) does not exist"
-- because the search_path didn't include the schema where pgcrypto is installed.
-- Adding 'extensions' resolves this for Supabase-hosted databases.

CREATE OR REPLACE FUNCTION public.get_or_create_referral_code(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_code text;
  v_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT r.referral_code
  INTO v_code
  FROM public.referrals r
  WHERE r.referrer_user_id = p_user_id
  ORDER BY r.created_at ASC
  LIMIT 1;

  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  SELECT u.email INTO v_email
  FROM auth.users u
  WHERE u.id = p_user_id;

  INSERT INTO public.referrals (
    referrer_user_id,
    referred_email,
    referral_code,
    bonus_lines,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    p_user_id,
    COALESCE(v_email, 'unknown@example.local'),
    encode(gen_random_bytes(8), 'hex'),
    20,
    now() + interval '30 days',
    now(),
    now()
  )
  RETURNING referral_code INTO v_code;

  RETURN v_code;
END;
$$;
