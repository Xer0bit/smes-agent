-- Per-route SEO overrides + redirect rules, for the SEO audit's Phase 1-3 items.
-- Business identity (Organization/LocalBusiness fields, social profiles) stays in
-- the existing project_settings(setting_key='business_identity') JSONB pattern —
-- it's a singleton per project, not multi-row, so a new table would be overkill.
-- Per-route SEO and redirects are inherently multi-row per project, so they get
-- dedicated tables for real querying/enumeration (sitemap generation, per-route
-- publish-time lookups) instead of being crammed into one JSONB blob.

CREATE TABLE public.project_seo_routes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  -- Matches the route path as declared in App.tsx's <Route path="...">, e.g.
  -- "/", "/product/:id", "/about". Kept as the route PATTERN, not a resolved
  -- concrete URL — dynamic segments (":id") get resolved at publish/sitemap-
  -- generation time from real data, not stored per-instance here.
  route_path text NOT NULL,
  title text,
  description text,
  keywords text,
  og_title text,
  og_description text,
  og_image text,
  canonical_url text,
  robots text,
  -- 'WebSite' | 'Product' | 'Article' | 'LocalBusiness' | 'Organization' | 'BreadcrumbList'
  structured_data_type text,
  -- Type-specific extra fields (e.g. price/availability/sku for Product) that
  -- don't warrant dedicated columns — kept flexible since schema.org types vary widely.
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_seo_routes_pkey PRIMARY KEY (id),
  CONSTRAINT project_seo_routes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT project_seo_routes_unique_route UNIQUE (project_id, route_path)
);

CREATE INDEX idx_project_seo_routes_project_id ON public.project_seo_routes(project_id);

CREATE TABLE public.project_redirects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  from_path text NOT NULL,
  to_path text NOT NULL,
  status_code integer NOT NULL DEFAULT 301,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_redirects_pkey PRIMARY KEY (id),
  CONSTRAINT project_redirects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT project_redirects_status_code_check CHECK (status_code IN (301, 302)),
  CONSTRAINT project_redirects_unique_from UNIQUE (project_id, from_path)
);

CREATE INDEX idx_project_redirects_project_id ON public.project_redirects(project_id);

ALTER TABLE public.project_seo_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_redirects ENABLE ROW LEVEL SECURITY;

-- Same access pattern used across all other project-scoped tables (see
-- project_agent_skills, etc.) — has_project_access() covers owner/org-admin/
-- explicit-member checks in one place.
CREATE POLICY "seo_routes_select" ON public.project_seo_routes
  FOR SELECT USING (public.has_project_access(project_id));
CREATE POLICY "seo_routes_insert" ON public.project_seo_routes
  FOR INSERT WITH CHECK (public.has_project_access(project_id));
CREATE POLICY "seo_routes_update" ON public.project_seo_routes
  FOR UPDATE USING (public.has_project_access(project_id));
CREATE POLICY "seo_routes_delete" ON public.project_seo_routes
  FOR DELETE USING (public.has_project_access(project_id));

CREATE POLICY "redirects_select" ON public.project_redirects
  FOR SELECT USING (public.has_project_access(project_id));
CREATE POLICY "redirects_insert" ON public.project_redirects
  FOR INSERT WITH CHECK (public.has_project_access(project_id));
CREATE POLICY "redirects_update" ON public.project_redirects
  FOR UPDATE USING (public.has_project_access(project_id));
CREATE POLICY "redirects_delete" ON public.project_redirects
  FOR DELETE USING (public.has_project_access(project_id));
