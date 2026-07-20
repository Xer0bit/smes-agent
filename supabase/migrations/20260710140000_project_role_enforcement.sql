-- Role enforcement for project collaborators.
--
-- Before this migration, neither project_invitations nor project_member_access
-- had a role column at all   the Editor/Viewer/Client dropdown in
-- CollaboratorManager.tsx was purely cosmetic. Every accepted collaborator got
-- identical full access regardless of what was selected, and nothing in the
-- backend distinguished a read-only viewer from a full editor.
--
-- Default 'editor' on both new columns preserves current behavior for every
-- existing row (nobody's access silently changes)   only NEW invitations
-- (which default to 'viewer' in the UI) get the tighter, intended behavior.

ALTER TABLE public.project_invitations
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor'
    CHECK (role IN ('editor', 'viewer', 'client'));

ALTER TABLE public.project_member_access
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor'
    CHECK (role IN ('editor', 'viewer', 'client'));

-- Carry the invited role through on acceptance instead of dropping it.
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

    -- Idempotent: already a member   update their role in case they were
    -- re-invited with a different one.
    IF EXISTS (
        SELECT 1 FROM project_member_access
        WHERE project_id = v_inv.project_id AND user_id = auth.uid()
    ) THEN
        UPDATE project_member_access SET role = v_inv.role
        WHERE project_id = v_inv.project_id AND user_id = auth.uid();
        UPDATE project_invitations SET status = 'accepted' WHERE id = v_inv.id;
        RETURN json_build_object('success', true, 'project_id', v_inv.project_id, 'already_member', true);
    END IF;

    -- Grant project access (trigger will auto-add to org_members)
    INSERT INTO project_member_access (project_id, user_id, granted_by, role)
    VALUES (v_inv.project_id, auth.uid(), v_inv.invited_by, v_inv.role);

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
