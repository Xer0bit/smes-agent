-- =============================================================================
-- Fix publish upsert conflict target on published_versions.subdomain
-- =============================================================================

-- PostgREST upsert with `onConflict: 'subdomain'` requires a non-partial unique
-- index or constraint on `subdomain`. A partial unique index cannot be inferred
-- as a valid conflict target for this upsert shape.

DROP INDEX IF EXISTS public.idx_published_versions_subdomain;

CREATE UNIQUE INDEX idx_published_versions_subdomain
  ON public.published_versions(subdomain);