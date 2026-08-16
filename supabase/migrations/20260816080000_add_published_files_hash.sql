-- Track a content hash of the file set at the moment of the last publish, so
-- the editor can disable "Update"/"Update Production Site" when nothing that
-- would actually change the live site has changed since then.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS published_files_hash TEXT;
