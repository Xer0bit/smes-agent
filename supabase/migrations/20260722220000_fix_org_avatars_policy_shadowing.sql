-- Fix: the write/update/delete policies from 20260722210000 referenced a bare
-- `name` inside a subquery against `organizations` (which itself has a `name`
-- column   the org's display name). Postgres resolved the bare identifier to
-- the innermost scope (organizations.name, e.g. "LOCAL_GUY") instead of the
-- intended storage.objects.name (the upload path, e.g. "<org_id>/avatar.png"),
-- so storage.foldername() was splitting the org's display name and never
-- matching   every upload was silently rejected by RLS. Qualify explicitly.
DROP POLICY IF EXISTS "Org avatars admin write" ON storage.objects;
DROP POLICY IF EXISTS "Org avatars admin update" ON storage.objects;
DROP POLICY IF EXISTS "Org avatars admin delete" ON storage.objects;

CREATE POLICY "Org avatars admin write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'org-avatars'
    AND EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id::text = (storage.foldername(objects.name))[1]
        AND (
          o.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.org_members m
            WHERE m.org_id = o.id AND m.user_id = auth.uid() AND m.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Org avatars admin update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'org-avatars'
    AND EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id::text = (storage.foldername(objects.name))[1]
        AND (
          o.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.org_members m
            WHERE m.org_id = o.id AND m.user_id = auth.uid() AND m.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Org avatars admin delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'org-avatars'
    AND EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id::text = (storage.foldername(objects.name))[1]
        AND (
          o.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.org_members m
            WHERE m.org_id = o.id AND m.user_id = auth.uid() AND m.role = 'admin'
          )
        )
    )
  );
