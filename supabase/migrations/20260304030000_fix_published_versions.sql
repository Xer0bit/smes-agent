-- =============================================================================
-- Allow direct publishing without a revision (subdomain publish flow)
-- =============================================================================

-- Make revision_id and version_tag nullable so we can insert a published_version
-- from the subdomain publish flow (which doesn't create a revision record).
ALTER TABLE public.published_versions
  ALTER COLUMN revision_id  DROP NOT NULL,
  ALTER COLUMN version_tag  DROP NOT NULL;

-- Ensure the subdomain unique index exists (migration 20260223 may not have run yet)
CREATE UNIQUE INDEX IF NOT EXISTS idx_published_versions_subdomain
  ON public.published_versions(subdomain)
  WHERE subdomain IS NOT NULL;

-- Allow write access via has_project_access (handles owner, created_by, org admin, assigned members)
DROP POLICY IF EXISTS "published_versions_owner_write" ON public.published_versions;
CREATE POLICY "published_versions_owner_write"
  ON public.published_versions
  FOR ALL
  USING (public.has_project_access(project_id))
  WITH CHECK (public.has_project_access(project_id));

-- Allow reading published versions (for domain settings panel)
DROP POLICY IF EXISTS "published_versions_owner_read" ON public.published_versions;
CREATE POLICY "published_versions_owner_read"
  ON public.published_versions
  FOR SELECT
  USING (public.has_project_access(project_id));
