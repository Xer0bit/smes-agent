-- Returns pending project/org invitations for the currently authenticated user.
-- SECURITY DEFINER is used so invitees can always read only their own invites by email.

CREATE OR REPLACE FUNCTION public.list_my_pending_invitations()
RETURNS TABLE (
  invitation_type text,
  invitation_id uuid,
  token text,
  project_id uuid,
  project_name text,
  org_id uuid,
  org_name text,
  role text,
  inviter_name text,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH me AS (
    SELECT lower(u.email) AS email
    FROM auth.users u
    WHERE u.id = auth.uid()
  )
  SELECT
    'project'::text AS invitation_type,
    pi.id AS invitation_id,
    pi.token::text AS token,
    pi.project_id,
    COALESCE(p.name, 'Untitled Project') AS project_name,
    NULL::uuid AS org_id,
    NULL::text AS org_name,
    NULL::text AS role,
    COALESCE(pr.full_name, pr.email, 'A team member') AS inviter_name,
    pi.expires_at
  FROM public.project_invitations pi
  JOIN me ON lower(pi.email) = me.email
  LEFT JOIN public.projects p ON p.id = pi.project_id
  LEFT JOIN public.profiles pr ON pr.id = pi.invited_by
  WHERE pi.status = 'pending'
    AND pi.expires_at >= now()

  UNION ALL

  SELECT
    'organization'::text AS invitation_type,
    oi.id AS invitation_id,
    oi.token,
    NULL::uuid AS project_id,
    NULL::text AS project_name,
    oi.org_id,
    COALESCE(o.name, 'Organization') AS org_name,
    oi.role::text,
    COALESCE(pr2.full_name, pr2.email, 'A team member') AS inviter_name,
    oi.expires_at
  FROM public.org_invitations oi
  JOIN me ON lower(oi.email) = me.email
  LEFT JOIN public.organizations o ON o.id = oi.org_id
  LEFT JOIN public.profiles pr2 ON pr2.id = oi.invited_by
  WHERE oi.status = 'pending'
    AND oi.expires_at >= now()

  ORDER BY expires_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_pending_invitations() TO authenticated;
