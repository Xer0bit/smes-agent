-- Add attachments jsonb column to messages so images/files survive reload.
-- Each message can carry an array of {name, size, type, url, category} objects
-- pointing at permanent Supabase Storage URLs (project-assets bucket).
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT NULL;
