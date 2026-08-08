-- =============================================================================
-- CRITICAL SECURITY FIX: enable Row-Level Security on public.profiles
--
-- profiles has never had RLS enabled in any tracked migration, while
-- 20260314033000_fix_runtime_table_permissions.sql:33-34 already grants
-- SELECT to `anon` and SELECT/INSERT/UPDATE/DELETE to `authenticated` on the
-- table. Combined with the frontend querying Supabase directly with the
-- anon/publishable key (src/integrations/supabase/client.ts), this table has
-- been effectively world-readable and cross-user-writable.
--
-- Live production RLS state was not confirmed via direct DB query this pass
-- (no SSH credentials available, production creds intentionally not pasted
-- into the assistant session). Proceeding on "absent from every tracked
-- migration" as sufficient evidence -- this migration is idempotent/safe
-- regardless of current live state (DROP POLICY IF EXISTS + re-CREATE, and
-- ENABLE ROW LEVEL SECURITY on an already-enabled table is a no-op).
--
-- Post-deploy sanity check (run manually against production):
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'profiles';
--   Expect `f` before this migration runs, `t` after.
--
-- Six real access patterns were audited across the whole frontend/backend
-- (every .from('profiles') call site) before writing these policies -- see
-- the security discovery report for full file:line citations. Each policy
-- below is scoped to the narrowest need found, not a default-broad grant.
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ── 1. Own row -- read + update ─────────────────────────────────────────────
-- Covers UsageContext.tsx:47, Billing.tsx:53, dashboard/Settings.tsx:88,103,
-- hooks/useReferral.ts:41. INSERT is handled by the handle_new_user trigger
-- (SECURITY DEFINER, bypasses RLS) or the service-role server -- no client
-- INSERT policy needed. No DELETE policy -- users never delete their own row.
DROP POLICY IF EXISTS "profiles_own_row_select" ON public.profiles;
CREATE POLICY "profiles_own_row_select"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_own_row_update" ON public.profiles;
CREATE POLICY "profiles_own_row_update"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- ── 2. Admin -- reactivate the existing, already-correctly-scoped policies ──
-- from 20260219010000_subscription_system.sql:166-178. Not a rewrite: same
-- USING clauses, just re-asserted so this migration is self-contained and
-- doesn't depend on migration ordering. Covers src/pages/admin/*.tsx, which
-- use @/integrations/supabase/adminClient -- confirmed same anon key, only a
-- different localStorage session key, no elevated privilege. RLS is their
-- only access control too.
DROP POLICY IF EXISTS "admin_profiles_select" ON public.profiles;
CREATE POLICY "admin_profiles_select"
    ON public.profiles FOR SELECT
    USING (id = auth.uid() OR public.get_my_role() IN ('admin', 'super_admin'));

DROP POLICY IF EXISTS "admin_profiles_update" ON public.profiles;
CREATE POLICY "admin_profiles_update"
    ON public.profiles FOR UPDATE
    USING (id = auth.uid() OR public.get_my_role() IN ('admin', 'super_admin'));

DROP POLICY IF EXISTS "admin_profiles_all" ON public.profiles;
CREATE POLICY "admin_profiles_all"
    ON public.profiles FOR ALL
    USING (public.get_my_role() IN ('admin', 'super_admin'));

-- ── 3. Org member visibility -- read-only ───────────────────────────────────
-- Covers src/components/ProjectMemberAccess.tsx:55 (id, email, full_name).
-- Two users who share ANY org_members row (same org_id) can see each other's
-- profile row. Postgres RLS is row-level, not column-level -- the consumer
-- code only ever selects id/email/full_name/avatar_url, and no org-mate
-- visibility consumer reads phone/account_status/is_mfa_enabled/region, so a
-- full-row grant is an accepted scoping tradeoff for this pattern, not a new
-- leak of those more sensitive columns to product logic that never asked for
-- them. Noted explicitly rather than silently broadened.
DROP POLICY IF EXISTS "profiles_org_member_select" ON public.profiles;
CREATE POLICY "profiles_org_member_select"
    ON public.profiles FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.org_members om1
            JOIN public.org_members om2 ON om1.org_id = om2.org_id
            WHERE om1.user_id = auth.uid()
              AND om2.user_id = profiles.id
        )
    );

-- ── 4. Project collaborator visibility -- read-only ─────────────────────────
-- Covers src/components/referral/settings/CollaboratorManager.tsx:132,165.
-- A user can see another profile if: (a) both have a project_member_access
-- row on the same project, or (b) one owns the project (projects.user_id or
-- created_by) and the other has project_member_access on it (either
-- direction).
DROP POLICY IF EXISTS "profiles_project_collaborator_select" ON public.profiles;
CREATE POLICY "profiles_project_collaborator_select"
    ON public.profiles FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.project_member_access pma1
            JOIN public.project_member_access pma2 ON pma1.project_id = pma2.project_id
            WHERE pma1.user_id = auth.uid()
              AND pma2.user_id = profiles.id
        )
        OR EXISTS (
            SELECT 1
            FROM public.projects p
            JOIN public.project_member_access pma ON pma.project_id = p.id
            WHERE (p.user_id = auth.uid() OR p.created_by = auth.uid())
              AND pma.user_id = profiles.id
        )
        OR EXISTS (
            SELECT 1
            FROM public.projects p
            JOIN public.project_member_access pma ON pma.project_id = p.id
            WHERE (p.user_id = profiles.id OR p.created_by = profiles.id)
              AND pma.user_id = auth.uid()
        )
    );

-- ── 5. Invite-by-email existence lookup ─────────────────────────────────────
-- Covers src/pages/dashboard/WorkspaceSettings.tsx (org invite flow). This is
-- an existence/id check, NOT a general read -- a SELECT-by-email policy would
-- reopen email enumeration against the whole user base (any authenticated
-- user could probe arbitrary emails). A SECURITY DEFINER function returning
-- only `id` keeps the same product behavior (check before inviting) without
-- exposing profile contents.
CREATE OR REPLACE FUNCTION public.lookup_user_by_email(p_email text)
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.profiles WHERE email = p_email;
$$;

REVOKE ALL ON FUNCTION public.lookup_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_user_by_email(text) TO authenticated;

-- ── 6. Accept-invite inviter-name lookup ────────────────────────────────────
-- Covers src/pages/AcceptProjectInvite.tsx:96-104. Scoped to a real, existing
-- project_invitations row (joined on invited_by = profiles.id), keyed by the
-- invitation's own id -- NOT by an arbitrary user id. The invitee does not
-- gain a standing ability to read arbitrary profiles just because one invite
-- exists; the function only resolves a name for the specific invite being
-- viewed. project_invitations already has an "authenticated_read_invitations"
-- policy (20260314000001_project_invitations.sql) letting any authenticated
-- user read the invitation row itself, so this doesn't broaden anything --
-- it just lets the inviter's display name resolve without a direct
-- table-level profiles read.
CREATE OR REPLACE FUNCTION public.get_inviter_display_name(p_invite_id uuid)
RETURNS TABLE(full_name text, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT p.full_name, p.email
    FROM public.profiles p
    JOIN public.project_invitations pi ON pi.invited_by = p.id
    WHERE pi.id = p_invite_id;
$$;

REVOKE ALL ON FUNCTION public.get_inviter_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_inviter_display_name(uuid) TO authenticated;
