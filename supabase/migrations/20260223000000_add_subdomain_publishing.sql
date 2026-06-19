-- Add subdomain publishing support

-- 1. Add subdomain & metadata columns to published_versions
ALTER TABLE public.published_versions
  ADD COLUMN IF NOT EXISTS subdomain    TEXT,
  ADD COLUMN IF NOT EXISTS files_count  INT DEFAULT 0;

-- Subdomains must be globally unique across all published versions
CREATE UNIQUE INDEX IF NOT EXISTS idx_published_versions_subdomain
  ON public.published_versions(subdomain)
  WHERE subdomain IS NOT NULL;

-- 2. Track published subdomain + timestamp on projects
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS published_subdomain TEXT,
  ADD COLUMN IF NOT EXISTS published_url       TEXT,
  ADD COLUMN IF NOT EXISTS published_at        TIMESTAMPTZ;

-- 3. RPC: check if a subdomain slug is available
CREATE OR REPLACE FUNCTION public.check_subdomain_available(p_slug TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.published_versions
    WHERE subdomain = lower(trim(p_slug))
      AND status = 'published'
  );
$$;

GRANT EXECUTE ON FUNCTION public.check_subdomain_available(TEXT) TO authenticated;

-- 4. Allow owners to insert/update their own published_versions
DROP POLICY IF EXISTS "published_versions_owner_write" ON public.published_versions;
CREATE POLICY "published_versions_owner_write" ON public.published_versions
  FOR ALL USING (
    deployed_by = auth.uid()
    OR public.has_project_access(project_id)
  );
