-- Add file_count column to revisions table
-- The revision service stores count after moving files to storage and clearing JSONB

ALTER TABLE public.revisions
  ADD COLUMN IF NOT EXISTS file_count integer;

COMMENT ON COLUMN public.revisions.file_count IS 'Number of files in this revision (stored after files are moved from JSONB to storage)';
