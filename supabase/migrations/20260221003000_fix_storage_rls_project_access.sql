-- Fix Storage RLS to match role-based project access
-- Previous policies only allowed project owner (projects.user_id = auth.uid())
-- but app now allows creator/admin/assigned member via has_project_access().

DROP POLICY IF EXISTS "Users can upload project files" ON storage.objects;
DROP POLICY IF EXISTS "Users can update project files" ON storage.objects;
DROP POLICY IF EXISTS "Users can read project files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete project files" ON storage.objects;

CREATE POLICY "Users can upload project files"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user-projects-free'
  AND (storage.foldername(name))[1] = 'projects'
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND public.has_project_access(((storage.foldername(name))[2])::uuid)
);

CREATE POLICY "Users can update project files"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user-projects-free'
  AND (storage.foldername(name))[1] = 'projects'
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND public.has_project_access(((storage.foldername(name))[2])::uuid)
)
WITH CHECK (
  bucket_id = 'user-projects-free'
  AND (storage.foldername(name))[1] = 'projects'
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND public.has_project_access(((storage.foldername(name))[2])::uuid)
);

CREATE POLICY "Users can read project files"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'user-projects-free'
  AND (storage.foldername(name))[1] = 'projects'
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND public.has_project_access(((storage.foldername(name))[2])::uuid)
);

CREATE POLICY "Users can delete project files"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'user-projects-free'
  AND (storage.foldername(name))[1] = 'projects'
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND public.has_project_access(((storage.foldername(name))[2])::uuid)
);
