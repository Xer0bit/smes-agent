-- Add SEO and Meta setting columns to the projects table
ALTER TABLE public.projects 
ADD COLUMN IF NOT EXISTS website_name text,
ADD COLUMN IF NOT EXISTS website_description text,
ADD COLUMN IF NOT EXISTS meta_image_url text,
ADD COLUMN IF NOT EXISTS favicon_url text;

-- Create the project-assets bucket if it does not already exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-assets',
  'project-assets',
  true, -- Public bucket for assets
  5242880, -- 5MB limit per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/x-icon', 'image/ico'] -- Allowed image formats
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- RLS is already enabled on storage.objects by default in Supabase.
-- We only need to create the policies.

-- Policy: Users can upload assets to their own project folders
DO $$ BEGIN
  CREATE POLICY "Users can upload assets to their own project folders"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'project-assets' AND
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = (storage.foldername(name))[1]::uuid
      AND created_by = auth.uid()
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Policy: Users can update assets in their own project folders
DO $$ BEGIN
  CREATE POLICY "Users can update their own project assets"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'project-assets' AND
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = (storage.foldername(name))[1]::uuid
      AND created_by = auth.uid()
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Policy: Users can delete assets in their own project folders
DO $$ BEGIN
  CREATE POLICY "Users can delete their own project assets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'project-assets' AND
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = (storage.foldername(name))[1]::uuid
      AND created_by = auth.uid()
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Policy: Anyone can view public files in the project-assets bucket
DO $$ BEGIN
  CREATE POLICY "Public Access on project-assets"
  ON storage.objects FOR SELECT
  USING ( bucket_id = 'project-assets' );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Allow service role full access
DO $$ BEGIN
  CREATE POLICY "Service role full access on project-assets"
  ON storage.objects
  TO service_role
  USING (bucket_id = 'project-assets')
  WITH CHECK (bucket_id = 'project-assets');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
