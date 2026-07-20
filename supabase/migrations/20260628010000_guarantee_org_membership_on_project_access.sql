-- =============================================================================
-- Guarantee: anyone with project_member_access is also an org_member.
--
-- Problem: multiple code paths grant project access (project invites,
-- org invites, Team Access page, admin grants) but only some of them
-- also add the user to org_members. This means collaborators can have
-- project access but not appear in the org, and vice-versa.
--
-- Fix:
--   1. UNIQUE constraint on org_members(org_id, user_id)   enables safe
--      ON CONFLICT upserts and prevents duplicates.
--   2. TRIGGER on project_member_access INSERT/UPDATE   whenever a project
--      access row is created, auto-add the user to the org as 'member'
--      if not already present.
--   3. Update accept_project_invitation RPC   also adds user to org_members
--      so the guarantee holds even before the trigger fires.
--   4. Retroactive fix   backfill org_members for existing project_member_access
--      rows that are missing an org membership.
-- =============================================================================

-- ─── 1. Add unique constraint to org_members ─────────────────────────────────
-- Clean up any duplicate rows first (keep the earliest joined_at).
DELETE FROM public.org_members a
USING public.org_members b
WHERE a.org_id = b.org_id
  AND a.user_id = b.user_id
  AND a.id > b.id;

ALTER TABLE public.org_members
  DROP CONSTRAINT IF EXISTS org_members_org_id_user_id_unique;

ALTER TABLE public.org_members
  ADD CONSTRAINT org_members_org_id_user_id_unique UNIQUE (org_id, user_id);

-- ─── 2. Trigger function: sync project member → org member ───────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_project_access_to_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id UUID;
BEGIN
    -- Look up the org for this project
    SELECT organization_id INTO v_org_id
    FROM public.projects
    WHERE id = NEW.project_id;

    -- If the project belongs to an org, ensure the user is a member
    IF v_org_id IS NOT NULL THEN
        INSERT INTO public.org_members (org_id, user_id, role, joined_at)
        VALUES (v_org_id, NEW.user_id, 'member', NOW())
        ON CONFLICT (org_id, user_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- Drop old trigger if it exists, then recreate
DROP TRIGGER IF EXISTS trg_sync_project_access_to_org ON public.project_member_access;

CREATE TRIGGER trg_sync_project_access_to_org
    AFTER INSERT OR UPDATE ON public.project_member_access
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_sync_project_access_to_org();

-- ─── 3. Update accept_project_invitation to also add user to org_members ─────
CREATE OR REPLACE FUNCTION public.accept_project_invitation(p_token UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inv         project_invitations%ROWTYPE;
    v_user_email  TEXT;
    v_org_id      UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Not authenticated');
    END IF;

    SELECT email INTO v_user_email FROM auth.users WHERE id = auth.uid();
    IF v_user_email IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'User not found');
    END IF;

    SELECT * INTO v_inv FROM project_invitations WHERE token = p_token;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Invitation not found');
    END IF;

    IF v_inv.status != 'pending' THEN
        RETURN json_build_object('success', false, 'error', 'Invitation is no longer valid');
    END IF;

    IF v_inv.expires_at < NOW() THEN
        UPDATE project_invitations SET status = 'expired' WHERE id = v_inv.id;
        RETURN json_build_object('success', false, 'error', 'Invitation has expired');
    END IF;

    IF LOWER(v_inv.email) != LOWER(v_user_email) THEN
        RETURN json_build_object(
            'success', false,
            'error', 'This invitation was sent to ' || v_inv.email || '. Please sign in with that email address.'
        );
    END IF;

    -- Idempotent: already a member
    IF EXISTS (
        SELECT 1 FROM project_member_access
        WHERE project_id = v_inv.project_id AND user_id = auth.uid()
    ) THEN
        UPDATE project_invitations SET status = 'accepted' WHERE id = v_inv.id;
        RETURN json_build_object('success', true, 'project_id', v_inv.project_id, 'already_member', true);
    END IF;

    -- Grant project access (trigger will auto-add to org_members)
    INSERT INTO project_member_access (project_id, user_id, granted_by)
    VALUES (v_inv.project_id, auth.uid(), v_inv.invited_by);

    -- Also explicitly add to org_members in case trigger hasn't fired yet
    SELECT organization_id INTO v_org_id FROM projects WHERE id = v_inv.project_id;
    IF v_org_id IS NOT NULL THEN
        INSERT INTO public.org_members (org_id, user_id, role, joined_at)
        VALUES (v_org_id, auth.uid(), 'member', NOW())
        ON CONFLICT (org_id, user_id) DO NOTHING;
    END IF;

    UPDATE project_invitations SET status = 'accepted' WHERE id = v_inv.id;

    RETURN json_build_object('success', true, 'project_id', v_inv.project_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_project_invitation(UUID) TO authenticated;

-- ─── 4. Retroactive fix: backfill org_members for existing project_member_access ─
-- For every project_member_access row where the project belongs to an org
-- but the user is not yet in org_members, insert them now.
INSERT INTO public.org_members (org_id, user_id, role, joined_at)
SELECT
    p.organization_id,
    pma.user_id,
    'member',
    NOW()
FROM public.project_member_access pma
JOIN public.projects p ON p.id = pma.project_id
WHERE p.organization_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = p.organization_id
        AND om.user_id = pma.user_id
  )
ON CONFLICT (org_id, user_id) DO NOTHING;
