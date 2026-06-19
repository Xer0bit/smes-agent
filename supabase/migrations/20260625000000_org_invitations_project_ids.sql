-- Add project_ids column to org_invitations so the inviter can pre-select
-- specific projects to share with the collaborator. The array is processed
-- by AcceptInvite when the invite is accepted.
ALTER TABLE public.org_invitations
  ADD COLUMN IF NOT EXISTS project_ids jsonb DEFAULT '[]'::jsonb;
