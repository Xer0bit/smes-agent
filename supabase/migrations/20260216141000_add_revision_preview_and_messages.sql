-- Compatibility migration for local schema expected by frontend
-- Adds:
-- 1) revision_preview table + FK relationship to revisions
-- 2) messages table used by editor history API calls

CREATE TABLE IF NOT EXISTS revision_preview (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  revision_id UUID NOT NULL,
  project_id UUID NOT NULL,
  preview_url TEXT,
  cloudflare_url TEXT,
  preview_status TEXT NOT NULL DEFAULT 'pending',
  build_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE revision_preview
  ADD COLUMN IF NOT EXISTS revision_id UUID,
  ADD COLUMN IF NOT EXISTS project_id UUID,
  ADD COLUMN IF NOT EXISTS preview_url TEXT,
  ADD COLUMN IF NOT EXISTS cloudflare_url TEXT,
  ADD COLUMN IF NOT EXISTS preview_status TEXT,
  ADD COLUMN IF NOT EXISTS build_error TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE revision_preview
SET preview_status = 'pending'
WHERE preview_status IS NULL;

ALTER TABLE revision_preview
  ALTER COLUMN preview_status SET DEFAULT 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_preview_revision_id
  ON revision_preview(revision_id);

CREATE INDEX IF NOT EXISTS idx_revision_preview_project_id
  ON revision_preview(project_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'revision_preview_revision_id_fkey'
  ) THEN
    ALTER TABLE revision_preview
      ADD CONSTRAINT revision_preview_revision_id_fkey
      FOREIGN KEY (revision_id)
      REFERENCES revisions(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'revision_preview_project_id_fkey'
  ) THEN
    ALTER TABLE revision_preview
      ADD CONSTRAINT revision_preview_project_id_fkey
      FOREIGN KEY (project_id)
      REFERENCES projects(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

ALTER TABLE revision_preview ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view revision previews" ON revision_preview;
DROP POLICY IF EXISTS "Users can insert revision previews" ON revision_preview;
DROP POLICY IF EXISTS "Users can update revision previews" ON revision_preview;
DROP POLICY IF EXISTS "Users can delete revision previews" ON revision_preview;

CREATE POLICY "Users can view revision previews" ON revision_preview
  FOR SELECT USING (has_project_access(project_id));

CREATE POLICY "Users can insert revision previews" ON revision_preview
  FOR INSERT WITH CHECK (has_project_access(project_id));

CREATE POLICY "Users can update revision previews" ON revision_preview
  FOR UPDATE USING (has_project_access(project_id))
  WITH CHECK (has_project_access(project_id));

CREATE POLICY "Users can delete revision previews" ON revision_preview
  FOR DELETE USING (has_project_access(project_id));


CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS project_id UUID,
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS meta JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE messages
SET role = 'user'
WHERE role IS NULL;

ALTER TABLE messages
  ALTER COLUMN role SET DEFAULT 'user';

CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_project_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_project_id_fkey
      FOREIGN KEY (project_id)
      REFERENCES projects(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_user_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_user_id_fkey
      FOREIGN KEY (user_id)
      REFERENCES auth.users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view project messages" ON messages;
DROP POLICY IF EXISTS "Users can insert project messages" ON messages;
DROP POLICY IF EXISTS "Users can update project messages" ON messages;
DROP POLICY IF EXISTS "Users can delete project messages" ON messages;

CREATE POLICY "Users can view project messages" ON messages
  FOR SELECT USING (has_project_access(project_id));

CREATE POLICY "Users can insert project messages" ON messages
  FOR INSERT WITH CHECK (
    has_project_access(project_id)
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

CREATE POLICY "Users can update project messages" ON messages
  FOR UPDATE USING (has_project_access(project_id))
  WITH CHECK (has_project_access(project_id));

CREATE POLICY "Users can delete project messages" ON messages
  FOR DELETE USING (has_project_access(project_id));
