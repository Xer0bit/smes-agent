-- Each project gets its own isolated tenant database schema.
-- Switch the primary lookup key from user_id to project_id.
ALTER TABLE public.tenant_databases
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS tenant_databases_project_id_idx
  ON public.tenant_databases (project_id)
  WHERE project_id IS NOT NULL AND status != 'deprovisioned';
