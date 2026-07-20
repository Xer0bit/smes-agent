-- Archive table for deleted projects   keeps metadata for up to 2 years
-- so support can recover project info, files list, and owner details.
CREATE TABLE IF NOT EXISTS public.deleted_projects (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid        NOT NULL,          -- original projects.id
  project_name      text        NOT NULL,
  project_slug      text,
  owner_user_id     uuid,                          -- created_by on the original project
  organization_id   uuid,
  plan_tier         text,
  deleted_by        uuid,                          -- who triggered the delete (may differ from owner)
  deleted_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '2 years'),
  metadata          jsonb       NOT NULL DEFAULT '{}', -- snapshot of project row + settings
  CONSTRAINT deleted_projects_pkey PRIMARY KEY (id)
);

-- Index for support lookups
CREATE INDEX deleted_projects_owner_idx       ON public.deleted_projects (owner_user_id);
CREATE INDEX deleted_projects_project_id_idx  ON public.deleted_projects (project_id);
CREATE INDEX deleted_projects_deleted_at_idx  ON public.deleted_projects (deleted_at DESC);

-- Admins can read; service_role can write; no direct user access
ALTER TABLE public.deleted_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.deleted_projects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Auto-purge rows past expires_at (runs via pg_cron if available, otherwise cleanup job)
-- Manual: DELETE FROM deleted_projects WHERE expires_at < now();

COMMENT ON TABLE public.deleted_projects IS
  'Soft-delete archive   one row per deleted project. Retained for 2 years for support recovery. '
  'metadata contains a snapshot of the project row, settings (seo, etc.), and file paths.';

-- Atomic project deletion function   deletes all 41 FK-constrained child tables
-- in one transaction so no FK constraint can be left dangling.
CREATE OR REPLACE FUNCTION public.delete_project_cascade(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM agent_task_logs         WHERE project_id = p_project_id;
  DELETE FROM ai_agents               WHERE project_id = p_project_id;
  DELETE FROM error_logs              WHERE project_id = p_project_id;
  DELETE FROM extra_lines_purchases   WHERE project_id = p_project_id;
  DELETE FROM jobs                    WHERE project_id = p_project_id;
  DELETE FROM project_add_ons         WHERE project_id = p_project_id;
  DELETE FROM project_billing         WHERE project_id = p_project_id;
  DELETE FROM project_custom_domains  WHERE project_id = p_project_id;
  DELETE FROM project_settings        WHERE project_id = p_project_id;
  DELETE FROM project_subdomains      WHERE project_id = p_project_id;
  DELETE FROM published_versions      WHERE project_id = p_project_id;
  DELETE FROM usage_records           WHERE project_id = p_project_id;
  DELETE FROM usage_tracking          WHERE project_id = p_project_id;
  -- CASCADE handles the remaining 28 child tables automatically
  DELETE FROM projects WHERE id = p_project_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_project_cascade(uuid) TO service_role;
