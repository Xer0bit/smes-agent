-- Runtime instances per project for single-host Docker orchestration tracking.
CREATE TABLE IF NOT EXISTS public.project_runtime_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE CASCADE,
  container_id text,
  runtime_status text NOT NULL DEFAULT 'stopped' CHECK (runtime_status IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
  runtime_mode text NOT NULL DEFAULT 'single-host-docker',
  preview_url text,
  host_node text,
  started_at timestamptz,
  last_active_at timestamptz,
  stopped_at timestamptz,
  idle_timeout_minutes integer NOT NULL DEFAULT 10,
  stop_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_runtime_instances_status ON public.project_runtime_instances(runtime_status);
CREATE INDEX IF NOT EXISTS idx_project_runtime_instances_last_active ON public.project_runtime_instances(last_active_at DESC);

-- Queue-oriented run jobs for agent worker migration.
CREATE TABLE IF NOT EXISTS public.agent_run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  workflow_mode text NOT NULL DEFAULT 'claude_code' CHECK (workflow_mode IN ('legacy', 'claude_code')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error_code text,
  error_message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_jobs_status ON public.agent_run_jobs(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_jobs_project_id ON public.agent_run_jobs(project_id, created_at DESC);

-- Event timeline for run observability and UI timeline rendering.
CREATE TABLE IF NOT EXISTS public.agent_run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.agent_run_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  phase text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id ON public.agent_run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_project_id ON public.agent_run_events(project_id, created_at DESC);
