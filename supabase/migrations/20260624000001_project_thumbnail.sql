-- Add thumbnail_url to projects
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS thumbnail_url text;

-- Storage bucket for project thumbnails (public read)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('thumbnails', 'thumbnails', true, 524288, ARRAY['image/webp','image/png','image/jpeg'])
  ON CONFLICT (id) DO NOTHING;

-- Public read (anyone can view thumbnails)
CREATE POLICY "Thumbnails public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'thumbnails');

-- Service role can write/replace thumbnails
CREATE POLICY "Thumbnails service write"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'thumbnails');

CREATE POLICY "Thumbnails service update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'thumbnails');
