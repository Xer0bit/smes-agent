-- Migration: Create chat-attachments storage bucket
-- Purpose: Store files uploaded in the agent chat panel (images, documents, etc.)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760, -- 10 MB per file
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
    'application/pdf',
    'text/plain', 'text/csv', 'text/markdown',
    'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Authenticated users can upload to their own folder (path: {user_id}/{project_id}/*)
DO $$ BEGIN
  CREATE POLICY "Users upload own chat attachments"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Users can read their own attachments
DO $$ BEGIN
  CREATE POLICY "Users read own chat attachments"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Users can delete their own attachments
DO $$ BEGIN
  CREATE POLICY "Users delete own chat attachments"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Service role full access
DO $$ BEGIN
  CREATE POLICY "Service role full access on chat-attachments"
  ON storage.objects
  TO service_role
  USING (bucket_id = 'chat-attachments')
  WITH CHECK (bucket_id = 'chat-attachments');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
