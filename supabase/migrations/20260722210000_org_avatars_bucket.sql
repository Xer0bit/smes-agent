-- Storage bucket for organization avatars (public read), uploaded directly
-- from the client. Objects live at "{org_id}/avatar.<ext>"   the org_id path
-- segment is what the write policies check against org_members/created_by.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('org-avatars', 'org-avatars', true, 2097152, ARRAY['image/webp','image/png','image/jpeg'])
  ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Org avatars public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'org-avatars');

CREATE POLICY "Org avatars admin write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'org-avatars'
    AND EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id::text = (storage.foldername(name))[1]
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
      WHERE o.id::text = (storage.foldername(name))[1]
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
      WHERE o.id::text = (storage.foldername(name))[1]
        AND (
          o.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.org_members m
            WHERE m.org_id = o.id AND m.user_id = auth.uid() AND m.role = 'admin'
          )
        )
    )
  );
