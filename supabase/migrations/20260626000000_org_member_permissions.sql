-- Per-member module-level permission overrides within an org.
-- Defaults are intentionally restrictive for 'member' role.
CREATE TABLE IF NOT EXISTS public.org_member_permissions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  can_create_project  BOOLEAN NOT NULL DEFAULT true,
  can_delete_project  BOOLEAN NOT NULL DEFAULT false,
  can_manage_billing  BOOLEAN NOT NULL DEFAULT false,
  can_invite_members  BOOLEAN NOT NULL DEFAULT false,
  can_manage_members  BOOLEAN NOT NULL DEFAULT false,
  can_view_analytics  BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES auth.users(id),
  UNIQUE(org_id, user_id)
);

ALTER TABLE public.org_member_permissions ENABLE ROW LEVEL SECURITY;

-- Admins and org creators can manage all permissions
CREATE POLICY "Admins manage permissions" ON public.org_member_permissions
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid() AND role IN ('admin', 'billing_admin')
    )
    OR org_id IN (
      SELECT id FROM public.organizations WHERE created_by = auth.uid()
    )
  );

-- Members can read their own row
CREATE POLICY "Members read own permissions" ON public.org_member_permissions
  FOR SELECT USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_org_member_perms_user ON public.org_member_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_org_member_perms_org  ON public.org_member_permissions(org_id);
