-- Fix storage policies to use split_part instead of foldername for reliability
-- CRITICAL: Use storage.objects.name explicitly to avoid ambiguity with projects.name

-- DROP ALL existing policies for this bucket to ensure a clean slate
DROP POLICY IF EXISTS "Users can upload to their own project folders" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own project files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own project files" ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own project files" ON storage.objects;

-- Re-create policies using split_part
-- Path structure: projects/{project_id}/{filename...}
-- IMPORTANT: We use storage.objects.name explicitly to avoid ambiguity with projects.name

-- INSERT
CREATE POLICY "Users can upload to their own project folders"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user-projects-free' AND
  split_part(storage.objects.name, '/', 1) = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id::text = split_part(storage.objects.name, '/', 2)
    AND user_id = auth.uid()
  )
);

-- UPDATE
CREATE POLICY "Users can update their own project files"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user-projects-free' AND
  split_part(storage.objects.name, '/', 1) = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id::text = split_part(storage.objects.name, '/', 2)
    AND user_id = auth.uid()
  )
);

-- DELETE
CREATE POLICY "Users can delete their own project files"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'user-projects-free' AND
  split_part(storage.objects.name, '/', 1) = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id::text = split_part(storage.objects.name, '/', 2)
    AND user_id = auth.uid()
  )
);

-- SELECT
CREATE POLICY "Users can read their own project files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'user-projects-free' AND
  split_part(storage.objects.name, '/', 1) = 'projects' AND
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE id::text = split_part(storage.objects.name, '/', 2)
    AND user_id = auth.uid()
  )
);
