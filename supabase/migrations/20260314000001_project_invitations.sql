-- =============================================================================
-- project_invitations: per-project email invitations
-- Owners invite collaborators by email; invitees must accept and may need to
-- create an account first. On acceptance, a project_member_access row is added.
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_invitations (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email       TEXT        NOT NULL,
    invited_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    token       UUID        NOT NULL DEFAULT uuid_generate_v4(),
    status      TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- One pending invite per email per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_invitations_pending
    ON project_invitations(project_id, email)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_project_invitations_token  ON project_invitations(token);
CREATE INDEX IF NOT EXISTS idx_project_invitations_email  ON project_invitations(email);
CREATE INDEX IF NOT EXISTS idx_project_invitations_proj   ON project_invitations(project_id);

ALTER TABLE project_invitations ENABLE ROW LEVEL SECURITY;

-- Project owner can read/insert/update/delete invitations for their own projects
CREATE POLICY "project_owner_manage_invitations"
    ON project_invitations FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = project_invitations.project_id
              AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = project_invitations.project_id
              AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
        )
    );

-- Authenticated users can read any invitation (needed for the accept-invite page)
CREATE POLICY "authenticated_read_invitations"
    ON project_invitations FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- =============================================================================
-- Allow project owner/creator to manage project_member_access for their projects
-- (extends existing "Admins manage project access" policy)
-- =============================================================================
DROP POLICY IF EXISTS "project_owner_manage_member_access" ON project_member_access;

CREATE POLICY "project_owner_manage_member_access"
    ON project_member_access FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = project_member_access.project_id
              AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = project_member_access.project_id
              AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
        )
    );

-- =============================================================================
-- SECURITY DEFINER RPC: accept_project_invitation(token)
-- Verifies email match, adds user to project_member_access, marks invite accepted.
-- =============================================================================
CREATE OR REPLACE FUNCTION accept_project_invitation(p_token UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inv       project_invitations%ROWTYPE;
    v_user_email TEXT;
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

    INSERT INTO project_member_access (project_id, user_id, granted_by)
    VALUES (v_inv.project_id, auth.uid(), v_inv.invited_by);

    UPDATE project_invitations SET status = 'accepted' WHERE id = v_inv.id;

    RETURN json_build_object('success', true, 'project_id', v_inv.project_id);
END;
$$;

GRANT EXECUTE ON FUNCTION accept_project_invitation(UUID) TO authenticated;
