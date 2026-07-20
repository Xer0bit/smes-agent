-- =============================================================================
-- Phase 4: Agency Features   Client Markup + Demo Booking
-- =============================================================================

-- ── 1. Client Markups (Agency-only) ──────────────────────────────────────────
-- Agency admins can set a per-client markup that gets added to add-on prices
CREATE TABLE IF NOT EXISTS public.client_markups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_user_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  markup_amount   numeric(10,2) NOT NULL DEFAULT 0 CHECK (markup_amount >= 0),
  markup_type     text NOT NULL DEFAULT 'percentage' CHECK (markup_type IN ('fixed','percentage')),
  currency        text NOT NULL DEFAULT 'USD',
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, client_user_id)
);

ALTER TABLE public.client_markups ENABLE ROW LEVEL SECURITY;

-- Only agency admins in the org can manage markups
CREATE POLICY "agency admin manage client markups"
  ON public.client_markups FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      JOIN public.organizations o ON o.id = om.org_id
      WHERE om.org_id = client_markups.org_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND o.plan_tier::text IN ('agency','enterprise')
    )
  );

-- Clients can read their own markup
CREATE POLICY "client read own markup"
  ON public.client_markups FOR SELECT
  USING (auth.uid() = client_user_id);

-- Admin bypass
CREATE POLICY "admin full access client_markups"
  ON public.client_markups FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- ── 2. Demo Requests ──────────────────────────────────────────────────────────
-- Users can request an agency-tier demo. Super-admins process them.
CREATE TABLE IF NOT EXISTS public.demo_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email        text NOT NULL,
  company_name text,
  message      text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','contacted','converted','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  admin_notes  text,
  converted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  converted_at timestamptz
);

ALTER TABLE public.demo_requests ENABLE ROW LEVEL SECURITY;

-- Users can submit and read their own requests
CREATE POLICY "users manage own demo requests"
  ON public.demo_requests FOR ALL
  USING (auth.uid() = user_id);

-- Admins can see and update all
CREATE POLICY "admin full access demo_requests"
  ON public.demo_requests FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- ── 3. RPC: submit_demo_request ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_demo_request(
  p_org_id      uuid,
  p_email       text,
  p_company     text DEFAULT NULL,
  p_message     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.demo_requests(org_id, user_id, email, company_name, message)
  VALUES (p_org_id, auth.uid(), p_email, p_company, p_message)
  RETURNING id INTO v_id;

  -- Could fire a notification here via pg_notify for realtime admin alerts
  PERFORM pg_notify('demo_request', json_build_object('id', v_id, 'email', p_email)::text);

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_demo_request(uuid, text, text, text) TO authenticated;

-- ── 4. Admin RPC: process_demo_request (update status + optionally upgrade org) ─
CREATE OR REPLACE FUNCTION public.process_demo_request(
  p_request_id  uuid,
  p_status      text,  -- 'contacted' | 'converted' | 'rejected'
  p_admin_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  -- Only super_admin/admin can call this
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT org_id INTO v_org_id FROM public.demo_requests WHERE id = p_request_id;

  UPDATE public.demo_requests
  SET status       = p_status,
      admin_notes  = COALESCE(p_admin_notes, admin_notes),
      converted_by  = CASE WHEN p_status = 'converted' THEN auth.uid() ELSE converted_by END,
      converted_at  = CASE WHEN p_status = 'converted' THEN now()       ELSE converted_at END
  WHERE id = p_request_id;

  -- Auto-upgrade org to agency on conversion
  IF p_status = 'converted' AND v_org_id IS NOT NULL THEN
    UPDATE public.organizations
    SET plan_tier = 'agency'::plan_tier, status = 'active'
    WHERE id = v_org_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_demo_request(uuid, text, text) TO authenticated;
