-- =============================================================================
-- Fix: org invitation acceptance does not grant project_member_access
-- Root causes:
--   1. accept_org_invitation RPC ignores project_ids stored on the invitation
--   2. Frontend AcceptInvite.tsx skips project grants when user is already a member
-- Fix:
--   1. Update accept_org_invitation RPC to also insert project_member_access rows
--   2. Retroactive fix: backfill missing project_member_access rows for all
--      accepted invitations (both org and project) that should have granted access
-- =============================================================================

-- ─── 1. Update accept_org_invitation to handle project_ids ───────────────────
CREATE OR REPLACE FUNCTION public.accept_org_invitation(p_token UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inv         org_invitations%ROWTYPE;
    v_user_email  TEXT;
    v_uid         UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Not authenticated');
    END IF;

    SELECT email INTO v_user_email FROM auth.users WHERE id = v_uid;
    IF v_user_email IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'User not found');
    END IF;

    SELECT * INTO v_inv FROM public.org_invitations WHERE token = p_token;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Invitation not found');
    END IF;

    IF v_inv.status != 'pending' THEN
        IF v_inv.status = 'accepted' THEN
            -- Idempotent: re-grant project access in case it was missed
            IF v_inv.project_ids IS NOT NULL AND jsonb_array_length(v_inv.project_ids) > 0 THEN
                INSERT INTO public.project_member_access (project_id, user_id, granted_by)
                SELECT (elem)::uuid, v_uid, v_inv.invited_by
                FROM jsonb_array_elements_text(v_inv.project_ids) AS elem
                ON CONFLICT (project_id, user_id) DO NOTHING;
            END IF;
            RETURN json_build_object('success', true, 'org_id', v_inv.org_id, 'role', v_inv.role, 'already_member', true);
        END IF;
        RETURN json_build_object('success', false, 'error', 'Invitation is no longer valid');
    END IF;

    IF v_inv.expires_at < NOW() THEN
        UPDATE public.org_invitations SET status = 'expired' WHERE id = v_inv.id;
        RETURN json_build_object('success', false, 'error', 'Invitation has expired');
    END IF;

    IF LOWER(v_inv.email) != LOWER(v_user_email) THEN
        RETURN json_build_object(
            'success', false,
            'error', 'This invitation was sent to ' || v_inv.email || '. Please sign in with that email address.'
        );
    END IF;

    -- Idempotent: already a member   still grant project access
    IF EXISTS (
        SELECT 1 FROM public.org_members
        WHERE org_id = v_inv.org_id AND user_id = v_uid
    ) THEN
        IF v_inv.project_ids IS NOT NULL AND jsonb_array_length(v_inv.project_ids) > 0 THEN
            INSERT INTO public.project_member_access (project_id, user_id, granted_by)
            SELECT (elem)::uuid, v_uid, v_inv.invited_by
            FROM jsonb_array_elements_text(v_inv.project_ids) AS elem
            ON CONFLICT (project_id, user_id) DO NOTHING;
        END IF;
        UPDATE public.org_invitations SET status = 'accepted' WHERE id = v_inv.id;
        RETURN json_build_object('success', true, 'org_id', v_inv.org_id, 'role', v_inv.role, 'already_member', true);
    END IF;

    -- Insert into org_members
    INSERT INTO public.org_members (org_id, user_id, role, joined_at)
    VALUES (v_inv.org_id, v_uid, v_inv.role, NOW());

    -- Grant project-level access for pre-selected projects in the invitation
    IF v_inv.project_ids IS NOT NULL AND jsonb_array_length(v_inv.project_ids) > 0 THEN
        INSERT INTO public.project_member_access (project_id, user_id, granted_by)
        SELECT (elem)::uuid, v_uid, v_inv.invited_by
        FROM jsonb_array_elements_text(v_inv.project_ids) AS elem
        ON CONFLICT (project_id, user_id) DO NOTHING;
    END IF;

    -- Mark invitation accepted
    UPDATE public.org_invitations SET status = 'accepted' WHERE id = v_inv.id;

    RETURN json_build_object('success', true, 'org_id', v_inv.org_id, 'role', v_inv.role);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_org_invitation(UUID) TO authenticated;

-- ─── 2. Retroactive fix: backfill project_member_access for accepted org invitations ──
-- For any org invitation that was accepted and had project_ids, ensure
-- the invitee has corresponding project_member_access rows.
INSERT INTO public.project_member_access (project_id, user_id, granted_by)
SELECT
    (elem)::uuid AS project_id,
    u.id         AS user_id,
    i.invited_by AS granted_by
FROM public.org_invitations i
JOIN auth.users u ON LOWER(u.email) = LOWER(i.email)
CROSS JOIN LATERAL jsonb_array_elements_text(i.project_ids) AS elem
WHERE i.status = 'accepted'
  AND i.project_ids IS NOT NULL
  AND jsonb_array_length(i.project_ids) > 0
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ─── 3. Retroactive fix: backfill project_member_access for accepted project invitations ──
-- The accept_project_invitation RPC should have handled this, but run as a
-- safety net in case any rows were missed.
INSERT INTO public.project_member_access (project_id, user_id, granted_by)
SELECT
    pi.project_id,
    u.id         AS user_id,
    pi.invited_by AS granted_by
FROM public.project_invitations pi
JOIN auth.users u ON LOWER(u.email) = LOWER(pi.email)
WHERE pi.status = 'accepted'
ON CONFLICT (project_id, user_id) DO NOTHING;
