-- Migration: Add tables for enhanced code generation platform
-- Based on LLM Platform Complete Design Guide

-- ============================================
-- PREVIEW SESSIONS
-- Track live preview server sessions
-- ============================================

CREATE TABLE IF NOT EXISTS public.preview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  
  -- Session details
  port integer NOT NULL,
  preview_url text NOT NULL,
  process_id integer, -- PID of Vite process
  
  -- Status
  status text DEFAULT 'starting' CHECK (status IN (
    'starting',
    'installing',
    'running',
    'stopped',
    'error'
  )),
  
  -- Resource usage
  memory_mb integer,
  cpu_percent numeric(5, 2),
  
  -- Activity tracking
  last_activity_at timestamp with time zone DEFAULT now(),
  auto_stop_at timestamp with time zone, -- Auto-stop after inactivity
  
  started_at timestamp with time zone DEFAULT now(),
  stopped_at timestamp with time zone,
  
  error_message text,

  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_preview_sessions_project ON preview_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_preview_sessions_status ON preview_sessions(status);
CREATE INDEX IF NOT EXISTS idx_preview_sessions_activity ON preview_sessions(last_activity_at);

-- ============================================
-- BUILD LOGS
-- Track build processes and outputs
-- ============================================

CREATE TABLE IF NOT EXISTS public.build_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  preview_session_id uuid REFERENCES public.preview_sessions(id),
  revision_id uuid REFERENCES public.revisions(id),
  
  -- Build information
  build_type text CHECK (build_type IN ('dev', 'production')),
  status text CHECK (status IN ('pending', 'running', 'success', 'failed')),
  
  -- Logs
  stdout text,
  stderr text,
  exit_code integer,
  
  -- Timing
  started_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  duration_ms integer,

  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_build_logs_project ON build_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_build_logs_session ON build_logs(preview_session_id);
CREATE INDEX IF NOT EXISTS idx_build_logs_revision ON build_logs(revision_id);

-- ============================================
-- FILE HISTORY (Version Control)
-- Track individual file changes with versioning
-- ============================================

CREATE TABLE IF NOT EXISTS public.file_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES public.revisions(id),
  
  file_path text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  size_bytes integer,
  
  -- Change metadata
  change_type text CHECK (change_type IN ('create', 'update', 'delete', 'rename')),
  change_description text,
  changed_by uuid REFERENCES auth.users(id),
  
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_history_project ON file_history(project_id);
CREATE INDEX IF NOT EXISTS idx_file_history_revision ON file_history(revision_id);
CREATE INDEX IF NOT EXISTS idx_file_history_path ON file_history(project_id, file_path);

-- ============================================
-- ERROR LOGS
-- Centralized error tracking
-- ============================================

CREATE TABLE IF NOT EXISTS public.error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  project_id uuid REFERENCES public.projects(id),
  
  error_type text NOT NULL,
  error_message text NOT NULL,
  stack_trace text,
  
  context jsonb, -- Additional error context
  
  severity text CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  resolved boolean DEFAULT false,
  resolved_at timestamp with time zone,
  resolved_by uuid REFERENCES auth.users(id),
  
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_user ON error_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_project ON error_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity);
CREATE INDEX IF NOT EXISTS idx_error_logs_unresolved ON error_logs(resolved) WHERE resolved = false;

-- ============================================
-- AI GENERATIONS (Enhanced)
-- Detailed AI generation tracking
-- ============================================

CREATE TABLE IF NOT EXISTS public.ai_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  revision_id uuid REFERENCES public.revisions(id),
  
  -- Request details
  prompt text NOT NULL,
  model text NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  system_prompt text,
  
  -- Token usage
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  
  -- Response
  response_data jsonb, -- Full API response
  files_generated text[], -- Array of file paths
  files_modified text[],
  files_deleted text[],
  
  -- Performance
  generation_time_ms integer,
  status text CHECK (status IN ('pending', 'success', 'error', 'partial')),
  error_message text,
  
  -- Cost tracking
  estimated_cost_usd numeric(10, 6),
  
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_generations_project ON ai_generations(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_generations_user ON ai_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_generations_created ON ai_generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_generations_status ON ai_generations(status);

-- ============================================
-- Add new columns to existing projects table
-- ============================================

-- Add docker/server paths for VPS-based storage
ALTER TABLE public.projects 
  ADD COLUMN IF NOT EXISTS docker_path text,
  ADD COLUMN IF NOT EXISTS server_path text,
  ADD COLUMN IF NOT EXISTS preview_port integer,
  ADD COLUMN IF NOT EXISTS template_type text DEFAULT 'vite-react-ts',
  ADD COLUMN IF NOT EXISTS node_version text DEFAULT '20',
  ADD COLUMN IF NOT EXISTS package_manager text DEFAULT 'npm',
  ADD COLUMN IF NOT EXISTS last_built_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamp with time zone DEFAULT now(),
  ADD COLUMN IF NOT EXISTS auto_save boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS preview_url text;

-- ============================================
-- VIEWS FOR COMMON QUERIES
-- ============================================

-- Project summary with file counts
CREATE OR REPLACE VIEW public.project_summary AS
SELECT 
  p.id,
  p.user_id,
  p.name,
  p.status,
  p.preview_url,
  p.created_at,
  p.updated_at,
  p.last_accessed_at,
  p.revision_count as file_count,
  p.total_storage_bytes as total_size_bytes,
  (SELECT MAX(r.created_at) FROM public.revisions r WHERE r.project_id = p.id) as last_revision_date
FROM public.projects p
WHERE p.status != 'deleted';

-- Active preview sessions view
CREATE OR REPLACE VIEW public.active_preview_sessions AS
SELECT 
  ps.id,
  ps.project_id,
  ps.user_id,
  ps.port,
  ps.preview_url,
  ps.status,
  ps.started_at,
  ps.last_activity_at,
  p.name as project_name
FROM public.preview_sessions ps
JOIN public.projects p ON p.id = ps.project_id
WHERE ps.status = 'running';

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

ALTER TABLE public.preview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.build_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_generations ENABLE ROW LEVEL SECURITY;

-- Preview sessions policies
CREATE POLICY "Users can view own preview sessions"
  ON public.preview_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own preview sessions"
  ON public.preview_sessions FOR ALL
  USING (auth.uid() = user_id);

-- Build logs policies
CREATE POLICY "Users can view build logs for their projects"
  ON public.build_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = build_logs.project_id
      AND projects.user_id = auth.uid()
    )
  );

-- File history policies
CREATE POLICY "Users can view file history for their projects"
  ON public.file_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = file_history.project_id
      AND projects.user_id = auth.uid()
    )
  );

-- Error logs policies
CREATE POLICY "Users can view own error logs"
  ON public.error_logs FOR SELECT
  USING (auth.uid() = user_id);

-- AI generations policies
CREATE POLICY "Users can view own ai generations"
  ON public.ai_generations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create ai generations"
  ON public.ai_generations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- TRIGGERS
-- ============================================

-- Update updated_at timestamp function (if not exists)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at triggers for new tables where applicable
-- (preview_sessions doesn't have updated_at, so skip)

-- ============================================
-- COMMENTS for documentation
-- ============================================

COMMENT ON TABLE public.preview_sessions IS 'Tracks live preview server sessions for projects';
COMMENT ON TABLE public.build_logs IS 'Build process logs and outputs';
COMMENT ON TABLE public.file_history IS 'Version control for individual file changes';
COMMENT ON TABLE public.error_logs IS 'Centralized error tracking and logging';
COMMENT ON TABLE public.ai_generations IS 'Detailed AI code generation tracking with token usage and costs';
