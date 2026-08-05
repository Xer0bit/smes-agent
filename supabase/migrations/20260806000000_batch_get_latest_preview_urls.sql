-- Batched sibling of get_latest_preview_url(): the dashboard project list
-- (src/pages/dashboard/Projects.tsx) previously called the single-project RPC
-- once per project via Promise.all -- N separate round-trips to render one
-- list, all firing on every dashboard load. Same query logic, just resolved
-- for a set of project IDs in one call instead of N.
CREATE OR REPLACE FUNCTION public.get_latest_preview_urls(p_project_ids uuid[])
RETURNS TABLE(project_id uuid, preview_url text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pid AS project_id,
    COALESCE(
      (
        SELECT COALESCE(rp.cloudflare_url, rp.preview_url)
        FROM public.revisions r
        JOIN public.revision_preview rp ON r.id = rp.revision_id
        WHERE r.project_id = pid
        AND (rp.cloudflare_url IS NOT NULL OR rp.preview_url IS NOT NULL)
        ORDER BY r.created_at DESC
        LIMIT 1
      ),
      (SELECT p.preview_url FROM public.projects p WHERE p.id = pid)
    ) AS preview_url
  FROM unnest(p_project_ids) AS pid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_latest_preview_urls(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_preview_urls(uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.get_latest_preview_urls(uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_latest_preview_urls IS 'Batched version of get_latest_preview_url() for resolving preview URLs for many projects in one call instead of N.';
