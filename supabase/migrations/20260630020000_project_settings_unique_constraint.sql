-- Add unique constraint on (project_id, setting_key) so that upsert works correctly.
-- Without this, upsert with onConflict: "project_id,setting_key" throws a postgres error
-- (silently swallowed in the frontend), causing all SEO saves to fail.

-- Deduplicate first: keep only the latest row per (project_id, setting_key) pair
DELETE FROM public.project_settings
WHERE id NOT IN (
  SELECT DISTINCT ON (project_id, setting_key) id
  FROM public.project_settings
  ORDER BY project_id, setting_key, created_at DESC
);

-- Add the unique constraint
ALTER TABLE public.project_settings
  ADD CONSTRAINT project_settings_project_id_setting_key_key
  UNIQUE (project_id, setting_key);
