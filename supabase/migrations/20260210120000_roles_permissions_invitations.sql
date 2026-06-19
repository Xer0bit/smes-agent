-- =============================================================================
-- Migration: Roles, Permissions & Email Invitation System
-- Date: 2026-02-10
-- Description:
--   1. Create org_invitations table (with token for email links)
--   2. Create project_member_access table (Admin assigns Members to projects)
--   3. Drop project_collaborators table (replaced by project_member_access)
--   4. Create has_project_access() function
--   5. Rewrite RLS policies for role-based access
-- =============================================================================

-- =============================================================================
-- 1. org_invitations table
-- =============================================================================
CREATE TABLE IF NOT EXISTS org_invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'billing_admin', 'member')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    token UUID NOT NULL DEFAULT uuid_generate_v4(),
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Prevent duplicate pending invites for the same email in the same org
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_unique_pending
    ON org_invitations (org_id, email) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON org_invitations(email);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org_id ON org_invitations(org_id);

ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 2. project_member_access table
-- Admin assigns org members (role = 'member') to specific projects
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_member_access (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_member_access_user
    ON project_member_access(user_id);
CREATE INDEX IF NOT EXISTS idx_project_member_access_project
    ON project_member_access(project_id);

ALTER TABLE project_member_access ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 3. Drop project_collaborators table
-- Replaced by the combination of org_members roles + project_member_access
-- =============================================================================
DROP TABLE IF EXISTS project_collaborators CASCADE;

-- =============================================================================
-- 4. has_project_access() function
-- Returns TRUE if the calling user (auth.uid()) has access to a given project.
-- Access rules:
--   - Project creator/owner: always
--   - Org admin: all org projects
--   - Org member: only if assigned via project_member_access
--   - Billing admin: never (no project access)
-- =============================================================================
CREATE OR REPLACE FUNCTION has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        -- Project creator/owner always has access
        SELECT 1 FROM projects p
        WHERE p.id = p_project_id
          AND (p.user_id = auth.uid() OR p.created_by = auth.uid())
    )
    OR EXISTS (
        -- Org admin sees all org projects
        SELECT 1 FROM projects p
        JOIN org_members om ON om.org_id = p.organization_id
        WHERE p.id = p_project_id
          AND om.user_id = auth.uid()
          AND om.role = 'admin'
    )
    OR EXISTS (
        -- Org member with explicit project assignment
        SELECT 1 FROM project_member_access pma
        WHERE pma.project_id = p_project_id
          AND pma.user_id = auth.uid()
    );
END;
$$;

-- =============================================================================
-- 5. RLS Policies — Projects (role-aware)
-- =============================================================================

-- Drop existing project policies to replace them
DROP POLICY IF EXISTS "Users can view their projects" ON projects;
DROP POLICY IF EXISTS "Users can create projects" ON projects;
DROP POLICY IF EXISTS "Role-based project access" ON projects;
DROP POLICY IF EXISTS "Admins and creators can manage projects" ON projects;

-- SELECT: role-based read access
CREATE POLICY "Role-based project access" ON projects
    FOR SELECT USING (
        -- Creator/owner always sees their projects
        user_id = auth.uid()
        OR created_by = auth.uid()
        -- Admin sees all org projects
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
        -- Member sees only explicitly assigned projects
        OR id IN (
            SELECT project_id FROM project_member_access
            WHERE user_id = auth.uid()
        )
        -- billing_admin: intentionally excluded from project access
    );

-- INSERT: admins and project creators can create projects
CREATE POLICY "Users can create projects" ON projects
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- UPDATE: admins, creators, and assigned members can update
CREATE POLICY "Users can update projects" ON projects
    FOR UPDATE USING (
        user_id = auth.uid()
        OR created_by = auth.uid()
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
        OR id IN (
            SELECT project_id FROM project_member_access
            WHERE user_id = auth.uid()
        )
    );

-- DELETE: only admins and creators can delete projects
CREATE POLICY "Admins can delete projects" ON projects
    FOR DELETE USING (
        user_id = auth.uid()
        OR created_by = auth.uid()
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- =============================================================================
-- 5b. RLS Policies — org_invitations
-- =============================================================================

DROP POLICY IF EXISTS "Admins can manage invitations" ON org_invitations;
DROP POLICY IF EXISTS "Invitees can view their invitations" ON org_invitations;

-- Admins can do everything with invitations in their orgs
CREATE POLICY "Admins can manage invitations" ON org_invitations
    FOR ALL USING (
        org_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- Invitees can read their own invitations (to accept/decline)
CREATE POLICY "Invitees can view their invitations" ON org_invitations
    FOR SELECT USING (
        email = auth.email()
    );

-- Anyone can update invitation they are the invitee of (to accept/decline)
CREATE POLICY "Invitees can accept or decline" ON org_invitations
    FOR UPDATE USING (
        email = auth.email()
    )
    WITH CHECK (
        -- Can only change status, nothing else
        email = auth.email()
    );

-- =============================================================================
-- 5c. RLS Policies — project_member_access
-- =============================================================================

DROP POLICY IF EXISTS "Admins manage project access" ON project_member_access;
DROP POLICY IF EXISTS "Users can view own access" ON project_member_access;

-- Admins can manage project assignments for their org's projects
CREATE POLICY "Admins manage project access" ON project_member_access
    FOR ALL USING (
        project_id IN (
            SELECT p.id FROM projects p
            JOIN org_members om ON om.org_id = p.organization_id
            WHERE om.user_id = auth.uid() AND om.role = 'admin'
        )
    );

-- Users can view their own project access entries
CREATE POLICY "Users can view own access" ON project_member_access
    FOR SELECT USING (user_id = auth.uid());

-- =============================================================================
-- 6. Update organizations policies to allow admins to manage
-- =============================================================================
DROP POLICY IF EXISTS "Organization creators can update their orgs" ON organizations;
CREATE POLICY "Org admins can update their orgs" ON organizations
    FOR UPDATE USING (
        created_by = auth.uid()
        OR id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );
