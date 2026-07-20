-- =============================================================================
-- SECURITY DEFINER RPC: accept_org_invitation(p_token uuid)
-- Verifies email match, adds user to org_members, marks invite accepted.
-- Uses SECURITY DEFINER so the invitee can insert themselves into org_members
-- without needing a direct INSERT RLS policy (mirrors accept_project_invitation).
-- =============================================================================

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
        -- Already accepted   idempotent success
        IF v_inv.status = 'accepted' THEN
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

    -- Idempotent: already a member
    IF EXISTS (
        SELECT 1 FROM public.org_members
        WHERE org_id = v_inv.org_id AND user_id = v_uid
    ) THEN
        UPDATE public.org_invitations SET status = 'accepted' WHERE id = v_inv.id;
        RETURN json_build_object('success', true, 'org_id', v_inv.org_id, 'role', v_inv.role, 'already_member', true);
    END IF;

    -- Insert into org_members
    INSERT INTO public.org_members (org_id, user_id, role, joined_at)
    VALUES (v_inv.org_id, v_uid, v_inv.role, NOW());

    -- Mark invitation accepted
    UPDATE public.org_invitations SET status = 'accepted' WHERE id = v_inv.id;

    RETURN json_build_object('success', true, 'org_id', v_inv.org_id, 'role', v_inv.role);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_org_invitation(UUID) TO authenticated;

-- Also create a decline RPC so invitees can decline without needing UPDATE RLS
CREATE OR REPLACE FUNCTION public.decline_org_invitation(p_token UUID)
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

    SELECT * INTO v_inv FROM public.org_invitations WHERE token = p_token;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Invitation not found');
    END IF;

    IF LOWER(v_inv.email) != LOWER(v_user_email) THEN
        RETURN json_build_object('success', false, 'error', 'Not authorized to decline this invitation');
    END IF;

    UPDATE public.org_invitations SET status = 'declined' WHERE id = v_inv.id;
    RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.decline_org_invitation(UUID) TO authenticated;
