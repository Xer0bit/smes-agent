-- Migration: Create user-projects-free storage bucket
-- Purpose: Initialize the storage bucket required for storing project files

-- Insert the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'user-projects-free',
  'user-projects-free',
  false, -- Private bucket, access controlled via RLS
  10485760, -- 10MB limit per file (adjust as needed)
  ARRAY['text/*', 'application/json', 'image/*', 'application/javascript', 'application/typescript'] -- Allow common code/asset types
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Enable RLS on objects (Usually enabled by default, skipping to avoid permission issues)
-- ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Policy: Users can upload files to their own project folders
-- We assume the path structure is: projects/{project_id}/files/{filename}
-- And we verify project ownership via the projects table
CREATE POLICY "Users can upload to their own project folders"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user-projects-free' AND
  (storage.foldername(name))[1] = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = (storage.foldername(name))[2]::uuid
    AND user_id = auth.uid()
  )
);

-- Policy: Users can update files in their own project folders
CREATE POLICY "Users can update their own project files"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user-projects-free' AND
  (storage.foldername(name))[1] = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = (storage.foldername(name))[2]::uuid
    AND user_id = auth.uid()
  )
);

-- Policy: Users can delete files in their own project folders
CREATE POLICY "Users can delete their own project files"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'user-projects-free' AND
  (storage.foldername(name))[1] = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = (storage.foldername(name))[2]::uuid
    AND user_id = auth.uid()
  )
);

-- Policy: Users can read files in their own project folders
CREATE POLICY "Users can read their own project files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'user-projects-free' AND
  (storage.foldername(name))[1] = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = (storage.foldername(name))[2]::uuid
    AND user_id = auth.uid()
  )
);

-- Allow service role full access
CREATE POLICY "Service role full access"
ON storage.objects
TO service_role
USING (true)
WITH CHECK (true);
