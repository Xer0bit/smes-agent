-- =============================================================================
-- Agent Runs Tracking
-- Tracks individual agent loop executions (SSE-based agent-stream runs)
-- References: ai_generations (already tracks per-generation costs)
-- This table covers the new agentic loop SSE endpoint specifically.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.agent_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES auth.users(id),

    -- Request
    prompt          text NOT NULL,
    model           text NOT NULL DEFAULT 'claude-3-5-haiku-20241022',

    -- Result
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
    steps_taken     integer DEFAULT 0,
    files_written   integer DEFAULT 0,
    files_deleted   integer DEFAULT 0,
    dependencies    text[],
    summary         text,
    error_message   text,

    -- Timing
    started_at      timestamptz DEFAULT NOW(),
    completed_at    timestamptz,
    duration_ms     integer
                    GENERATED ALWAYS AS (
                        CASE WHEN completed_at IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (completed_at - started_at))::integer * 1000
                        END
                    ) STORED,

    created_at      timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_project  ON public.agent_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user     ON public.agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status   ON public.agent_runs(status);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_runs_owner_select"
    ON public.agent_runs FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "agent_runs_owner_insert"
    ON public.agent_runs FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "agent_runs_owner_update"
    ON public.agent_runs FOR UPDATE
    USING (auth.uid() = user_id);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON public.agent_runs TO authenticated;
GRANT ALL ON public.agent_runs TO service_role;

COMMENT ON TABLE public.agent_runs IS 'Tracks each agent-stream SSE loop run: steps, files written, timing';
