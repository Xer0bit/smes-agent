-- Add summary column to revisions table
-- The revision service auto-generates a summary from the list of changed files

ALTER TABLE public.revisions
  ADD COLUMN IF NOT EXISTS summary text;

COMMENT ON COLUMN public.revisions.summary IS 'Human-readable summary of the files changed in this revision, e.g. "Updated 3 files: App.tsx, index.css, vite.config.ts"';
