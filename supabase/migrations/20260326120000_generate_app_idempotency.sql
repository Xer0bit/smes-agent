-- Durable idempotency records for /api/v1/ai/generate-app across multi-instance deployments.
CREATE TABLE IF NOT EXISTS public.generate_app_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  operation_id text,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generate_app_idempotency_user_project
  ON public.generate_app_idempotency(user_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generate_app_idempotency_status
  ON public.generate_app_idempotency(status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_generate_app_idempotency_updated_at ON public.generate_app_idempotency;
CREATE TRIGGER trg_generate_app_idempotency_updated_at
  BEFORE UPDATE ON public.generate_app_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
