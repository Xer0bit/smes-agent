-- Migration: Add get_latest_preview_url function
-- Purpose: Resolve PGRST202 error by providing the missing function expected by the frontend

CREATE OR REPLACE FUNCTION public.get_latest_preview_url(p_project_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER -- Run with privileges of the creator (postgres) to ensure we can read the tables
SET search_path = public
AS $$
DECLARE
  v_url text;
BEGIN
  -- Get the latest preview URL from revision_preview join revisions
  -- We prefer Cloudflare URL if available, otherwise standard preview_url
  SELECT 
    COALESCE(rp.cloudflare_url, rp.preview_url) INTO v_url
  FROM public.revisions r
  JOIN public.revision_preview rp ON r.id = rp.revision_id
  WHERE r.project_id = p_project_id
  AND (rp.cloudflare_url IS NOT NULL OR rp.preview_url IS NOT NULL)
  ORDER BY r.created_at DESC
  LIMIT 1;
  
  -- If not found in revisions, check project level (fallback)
  IF v_url IS NULL THEN
    SELECT preview_url INTO v_url
    FROM public.projects
    WHERE id = p_project_id;
  END IF;

  RETURN v_url;
END;
$$;

-- Grant access to authenticated users and anon (if needed for public projects, though usually authenticated)
GRANT EXECUTE ON FUNCTION public.get_latest_preview_url(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_preview_url(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_latest_preview_url(uuid) TO service_role;

COMMENT ON FUNCTION public.get_latest_preview_url IS 'Returns the most recent active preview URL for a project, checking revisions first then project fallback.';
