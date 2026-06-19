-- Assign a project to an organization and sync access requests to org members.
-- This keeps assignment + invitation fan-out atomic and consistent.

CREATE OR REPLACE FUNCTION public.assign_project_to_organization(
    p_project_id UUID,
    p_organization_id UUID,
    p_send_requests BOOLEAN DEFAULT TRUE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_project projects%ROWTYPE;
    v_invited_count INTEGER := 0;
    v_invited_recipients JSONB := '[]'::jsonb;
    v_inv_row RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Not authenticated');
    END IF;

    SELECT *
      INTO v_project
      FROM projects
     WHERE id = p_project_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Project not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM organizations o WHERE o.id = p_organization_id
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Organization not found');
    END IF;

    -- Permission check mirrors projects update semantics.
    IF NOT (
        v_project.user_id = auth.uid()
        OR v_project.created_by = auth.uid()
        OR EXISTS (
            SELECT 1
              FROM org_members om
             WHERE om.org_id = v_project.organization_id
               AND om.user_id = auth.uid()
               AND om.role = 'admin'
        )
        OR get_my_role() = 'super_admin'
    ) THEN
        RETURN json_build_object('success', false, 'error', 'You do not have permission to reassign this project');
    END IF;

    -- Guardrail: non-super-admin users must be admin in target org too.
    IF get_my_role() <> 'super_admin'
       AND NOT EXISTS (
            SELECT 1
              FROM org_members om
             WHERE om.org_id = p_organization_id
               AND om.user_id = auth.uid()
               AND om.role = 'admin'
       ) THEN
        RETURN json_build_object('success', false, 'error', 'You must be an admin in the target organization');
    END IF;

    UPDATE projects
       SET organization_id = p_organization_id,
           updated_at = NOW()
     WHERE id = p_project_id;

    IF p_send_requests THEN
                FOR v_inv_row IN
                        INSERT INTO project_invitations (project_id, email, invited_by, expires_at)
                        SELECT
                                p_project_id,
                                lower(pr.email),
                                auth.uid(),
                                NOW() + INTERVAL '7 days'
                        FROM org_members om
                        JOIN profiles pr
                            ON pr.id = om.user_id
                        WHERE om.org_id = p_organization_id
                            AND om.user_id <> auth.uid()
                            AND pr.email IS NOT NULL
                            AND length(trim(pr.email)) > 0
                            AND NOT EXISTS (
                                    SELECT 1
                                        FROM project_member_access pma
                                     WHERE pma.project_id = p_project_id
                                         AND pma.user_id = om.user_id
                            )
                            AND NOT EXISTS (
                                    SELECT 1
                                        FROM project_invitations pi
                                     WHERE pi.project_id = p_project_id
                                         AND lower(pi.email) = lower(pr.email)
                                         AND pi.status = 'pending'
                            )
                        RETURNING email, token
                LOOP
                        v_invited_count := v_invited_count + 1;
                        v_invited_recipients := v_invited_recipients || jsonb_build_array(
                                jsonb_build_object('email', v_inv_row.email, 'token', v_inv_row.token)
                        );
                END LOOP;
    END IF;

    RETURN json_build_object(
        'success', true,
        'project_id', p_project_id,
        'organization_id', p_organization_id,
        'invited_count', v_invited_count,
        'invited_recipients', v_invited_recipients
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_project_to_organization(UUID, UUID, BOOLEAN)
TO authenticated;
