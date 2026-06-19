-- =============================================================================
-- VPS4 Enterprise Hosting: Domain management enhancements
-- Adds DNS verification tracking and hosting state columns
-- =============================================================================

-- Add hosting-related columns to project_custom_domains
ALTER TABLE public.project_custom_domains
  ADD COLUMN IF NOT EXISTS dns_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hosting_active   BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS hosting_url      TEXT,
  ADD COLUMN IF NOT EXISTS last_dns_check   TIMESTAMPTZ;

-- Add hosting deployment columns to published_versions
ALTER TABLE public.published_versions
  ADD COLUMN IF NOT EXISTS hosting_deployed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS hosting_url      TEXT;

-- RLS: authenticated users can manage their own project domains
DROP POLICY IF EXISTS "project_owner_manage_custom_domains" ON public.project_custom_domains;
CREATE POLICY "project_owner_manage_custom_domains"
  ON public.project_custom_domains FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_custom_domains.project_id
        AND (
          p.user_id = auth.uid()
          OR p.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.org_id = p.organization_id
              AND om.user_id = auth.uid()
              AND om.role = 'admin'
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_custom_domains.project_id
        AND (
          p.user_id = auth.uid()
          OR p.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM org_members om
            WHERE om.org_id = p.organization_id
              AND om.user_id = auth.uid()
              AND om.role = 'admin'
          )
        )
    )
  );

ALTER TABLE public.project_custom_domains ENABLE ROW LEVEL SECURITY;
