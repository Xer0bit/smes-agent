-- =============================================================================
-- Phase 3: Guest Sessions + Share Preview Branding
-- =============================================================================

-- ── 1. Guest Sessions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guest_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint       text NOT NULL UNIQUE,
  projects_created  integer NOT NULL DEFAULT 0,
  last_active_at    timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guest_sessions ENABLE ROW LEVEL SECURITY;

-- Only service_role / admin can read guest sessions (no self-select   anonymous users have no auth.uid)
CREATE POLICY "admin full access guest_sessions"
  ON public.guest_sessions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- Allow service_role insert/select for server-side fingerprint checks
-- (service_role bypasses RLS by default   no policy needed)

-- ── 2. RPC: check_guest_limit(fingerprint) → { can_create bool } ──────────────
CREATE OR REPLACE FUNCTION public.check_guest_limit(p_fingerprint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created integer;
BEGIN
  SELECT projects_created INTO v_created
  FROM public.guest_sessions
  WHERE fingerprint = p_fingerprint;

  IF NOT FOUND THEN
    -- First time we've seen this fingerprint
    INSERT INTO public.guest_sessions(fingerprint) VALUES (p_fingerprint)
    ON CONFLICT (fingerprint) DO NOTHING;
    RETURN jsonb_build_object('can_create', true, 'projects_created', 0);
  END IF;

  -- Max 1 project per guest fingerprint
  RETURN jsonb_build_object(
    'can_create',        v_created < 1,
    'projects_created',  v_created
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_guest_limit(text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_guest_limit(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_guest_limit(text) TO service_role;

-- ── 3. RPC: record_guest_project(fingerprint)   call after guest project created ─
CREATE OR REPLACE FUNCTION public.record_guest_project(p_fingerprint text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.guest_sessions(fingerprint, projects_created)
  VALUES (p_fingerprint, 1)
  ON CONFLICT (fingerprint) DO UPDATE
    SET projects_created = guest_sessions.projects_created + 1,
        last_active_at   = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_guest_project(text) TO anon;
GRANT EXECUTE ON FUNCTION public.record_guest_project(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_guest_project(text) TO service_role;

-- ── 4. Preview Branding table ──────────────────────────────────────────────────
-- branding_type: 'footer' = "Made with SMEsAgent" link at bottom
--                'watermark' = "Geared by eCG" corner badge
--                'none' = no branding (pro/agency)
CREATE TABLE IF NOT EXISTS public.preview_branding (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE CASCADE,
  branding_type  text NOT NULL DEFAULT 'footer' CHECK (branding_type IN ('footer','watermark','none')),
  watermark_text text NOT NULL DEFAULT 'Geared by eCG',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.preview_branding ENABLE ROW LEVEL SECURITY;

-- Project members can read branding settings
CREATE POLICY "project members read preview branding"
  ON public.preview_branding FOR SELECT
  USING (public.has_project_access(project_id));

-- Only project owner/admin can update
CREATE POLICY "project admin manage preview branding"
  ON public.preview_branding FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      LEFT JOIN public.org_members om ON om.org_id = p.organization_id AND om.user_id = auth.uid()
      WHERE p.id = project_id
        AND (p.created_by = auth.uid() OR om.role = 'admin')
    )
  );

-- Admin bypass
CREATE POLICY "admin full access preview_branding"
  ON public.preview_branding FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin','admin'))
  );

-- ── 5. Trigger: auto-set branding on project creation ─────────────────────────
CREATE OR REPLACE FUNCTION public.set_project_branding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_tier text;
BEGIN
  -- Get org tier
  SELECT plan_tier::text INTO v_tier
  FROM public.organizations
  WHERE id = NEW.organization_id;

  INSERT INTO public.preview_branding(project_id, branding_type)
  VALUES (
    NEW.id,
    CASE v_tier
      WHEN 'pro'    THEN 'none'
      WHEN 'agency' THEN 'none'
      WHEN 'professional' THEN 'none'   -- legacy
      WHEN 'enterprise'   THEN 'none'   -- legacy
      WHEN 'free'   THEN 'watermark'
      WHEN 'starter' THEN 'watermark'   -- legacy
      ELSE 'footer'                     -- no org / guest
    END
  )
  ON CONFLICT (project_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_project_branding ON public.projects;
CREATE TRIGGER trg_set_project_branding
  AFTER INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.set_project_branding();

-- ── 6. Backfill branding for all existing projects ───────────────────────────
INSERT INTO public.preview_branding(project_id, branding_type)
SELECT
  p.id,
  CASE COALESCE(o.plan_tier::text, 'free')
    WHEN 'pro'          THEN 'none'
    WHEN 'agency'       THEN 'none'
    WHEN 'professional' THEN 'none'
    WHEN 'enterprise'   THEN 'none'
    WHEN 'free'         THEN 'watermark'
    WHEN 'starter'      THEN 'watermark'
    ELSE 'footer'
  END
FROM public.projects p
LEFT JOIN public.organizations o ON o.id = p.organization_id
ON CONFLICT (project_id) DO NOTHING;
