-- =============================================================================
-- Fix: projects table has 12+ overlapping PERMISSIVE policies accumulated
-- from multiple migrations. Since PERMISSIVE policies are OR'd together,
-- any one passing = row visible → users see projects they shouldn't.
--
-- Culprits:
--   "admin_projects_all"        – get_my_role() IN ('admin','super_admin')
--                                  → platform-admin sees ALL projects
--   "select_own_or_org_projects" – is_org_member() → any org member sees all org projects
--   Multiple duplicate INSERT/UPDATE/DELETE policies with null QUAL (always true)
--
-- Fix: DROP ALL policies on projects, then create ONE clean policy per operation.
-- =============================================================================

-- ─── DROP all existing policies on projects ──────────────────────────────────
DROP POLICY IF EXISTS "Projects select by owner"      ON projects;
DROP POLICY IF EXISTS "Projects insert by owner"      ON projects;
DROP POLICY IF EXISTS "Projects update by owner"      ON projects;
DROP POLICY IF EXISTS "Projects delete by owner"      ON projects;
DROP POLICY IF EXISTS "Role-based project access"     ON projects;
DROP POLICY IF EXISTS "Users can view their projects" ON projects;
DROP POLICY IF EXISTS "Users can create projects"     ON projects;
DROP POLICY IF EXISTS "Users can update projects"     ON projects;
DROP POLICY IF EXISTS "Admins can delete projects"    ON projects;
DROP POLICY IF EXISTS "Admins and creators can manage projects" ON projects;
DROP POLICY IF EXISTS "admin_projects_all"            ON projects;
DROP POLICY IF EXISTS "select_own_or_org_projects"    ON projects;
DROP POLICY IF EXISTS "insert_org_projects"           ON projects;
DROP POLICY IF EXISTS "insert_personal_projects"      ON projects;
DROP POLICY IF EXISTS "projects_select_owner"         ON projects;
DROP POLICY IF EXISTS "projects_insert_owner"         ON projects;
DROP POLICY IF EXISTS "projects_update_owner"         ON projects;
DROP POLICY IF EXISTS "projects_delete_owner"         ON projects;
DROP POLICY IF EXISTS "delete_own_projects"           ON projects;
DROP POLICY IF EXISTS "update_own_projects"           ON projects;

-- ─── Ensure RLS is enabled ───────────────────────────────────────────────────
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- ─── SELECT: users see ONLY their own projects or ones they're assigned to ───
-- A user can see a project if:
--   1. They created/own it (user_id or created_by)
--   2. They are an org-level admin for the project's organization
--   3. They have an explicit assignment in project_member_access
--   4. They are a platform super_admin (get_my_role() = 'super_admin' only)
--
-- Note: regular org 'admin' in org_members is handled by clause 2.
-- get_my_role() returns from user_roles (platform-wide role)   only super_admin
-- should bypass ownership checks, NOT the org-level 'admin' role.
CREATE POLICY "projects_select" ON projects
    FOR SELECT USING (
        -- own project
        user_id = auth.uid()
        OR created_by = auth.uid()
        -- org admin sees all projects in their org
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
        -- explicitly assigned member
        OR id IN (
            SELECT project_id FROM project_member_access
            WHERE user_id = auth.uid()
        )
        -- platform super_admin only (NOT regular 'admin')
        OR get_my_role() = 'super_admin'
    );

-- ─── INSERT: only the owner or an org admin can create projects ──────────────
CREATE POLICY "projects_insert" ON projects
    FOR INSERT WITH CHECK (
        -- personal project: user creates for themselves
        (organization_id IS NULL AND user_id = auth.uid())
        -- org project: creator must be an org admin
        OR (organization_id IS NOT NULL AND organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        ))
        -- platform super_admin
        OR get_my_role() = 'super_admin'
    );

-- ─── UPDATE: owner or org admin can update ───────────────────────────────────
CREATE POLICY "projects_update" ON projects
    FOR UPDATE USING (
        user_id = auth.uid()
        OR created_by = auth.uid()
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
        OR get_my_role() = 'super_admin'
    );

-- ─── DELETE: only owner or org admin can delete ──────────────────────────────
CREATE POLICY "projects_delete" ON projects
    FOR DELETE USING (
        user_id = auth.uid()
        OR created_by = auth.uid()
        OR organization_id IN (
            SELECT org_id FROM org_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
        OR get_my_role() = 'super_admin'
    );
