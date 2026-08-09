-- Phase 1 of the orchestration plan (2026-08-09): plan mode currently produces
-- nothing durable -- it's pure chat text, thrown away, never fed into the
-- later build run. This table gives it a real, persisted artifact instead.
--
-- New plan supersedes the prior one (mirrors the snapshot-prune philosophy
-- already used for agent_runs/checkpoints) rather than blocking on an
-- existing unexecuted plan -- confirmed as the desired behavior.

CREATE TABLE IF NOT EXISTS public.agent_plans (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES auth.users(id),
    run_id      uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,

    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'approved', 'superseded', 'completed')),

    summary     text NOT NULL,
    steps       jsonb NOT NULL DEFAULT '[]',

    created_at  timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_plans_project_status
    ON public.agent_plans(project_id, status, created_at DESC);

ALTER TABLE public.agent_plans ENABLE ROW LEVEL SECURITY;

-- Same access shape as agent_runs/projects: service role (server-side) does
-- everything; owners can read their own project's plans directly if the
-- frontend ever wants to show plan history.
CREATE POLICY "agent_plans_service_all" ON public.agent_plans
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "agent_plans_owner_select" ON public.agent_plans
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.projects p
            WHERE p.id = agent_plans.project_id AND p.user_id = auth.uid()
        )
    );
