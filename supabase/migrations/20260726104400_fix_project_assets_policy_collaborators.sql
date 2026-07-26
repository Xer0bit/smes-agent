-- project-assets storage policies only checked projects.created_by = auth.uid(),
-- so org admins and invited editors (project_member_access, role != 'viewer'/'client')
-- got a bare 400 from Supabase Storage on any upload/update/delete (e.g. favicon
-- upload in SiteSettingsEditor.tsx) even though the app's own getUserRole() in
-- project.service.ts grants them write access everywhere else. Bring storage RLS
-- in line with that same rule.

CREATE OR REPLACE FUNCTION public.can_write_project_assets(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND (
        p.user_id = auth.uid()
        OR p.created_by = auth.uid()
        OR (p.organization_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.org_members om
          WHERE om.org_id = p.organization_id
            AND om.user_id = auth.uid()
            AND om.role = 'admin'
        ))
        OR EXISTS (
          SELECT 1 FROM public.project_member_access pma
          WHERE pma.project_id = p.id
            AND pma.user_id = auth.uid()
            AND pma.role NOT IN ('viewer', 'client')
        )
      )
  );
$$;

DROP POLICY IF EXISTS "Users can upload assets to their own project folders" ON storage.objects;
CREATE POLICY "Users can upload assets to their own project folders"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'project-assets'
  AND public.can_write_project_assets((storage.foldername(name))[1]::uuid)
);

DROP POLICY IF EXISTS "Users can update their own project assets" ON storage.objects;
CREATE POLICY "Users can update their own project assets"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'project-assets'
  AND public.can_write_project_assets((storage.foldername(name))[1]::uuid)
);

DROP POLICY IF EXISTS "Users can delete their own project assets" ON storage.objects;
CREATE POLICY "Users can delete their own project assets"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'project-assets'
  AND public.can_write_project_assets((storage.foldername(name))[1]::uuid)
);
