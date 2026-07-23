-- Workspace-level preferences (language, auto-accept invitations, generation
-- sound). Stored as jsonb, same pattern as the existing security_policy
-- column   no new RLS policy needed, already covered by "Org admins can
-- update their orgs".
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{
    "default_language": "en",
    "auto_accept_invitations": false,
    "generation_sound_enabled": false
  }'::jsonb;
