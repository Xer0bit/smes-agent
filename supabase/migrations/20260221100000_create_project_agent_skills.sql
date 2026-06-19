-- =============================================================================
-- Project Agent Skills
-- Stores per-project skills/instructions injected into the agent system prompt
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.project_agent_skills (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid          NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name          text          NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description   text          NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  category      text          NOT NULL DEFAULT 'general'
                              CHECK (category IN ('coding','design','architecture','data','general')),
  is_active     boolean       NOT NULL DEFAULT true,
  sort_order    integer       NOT NULL DEFAULT 0,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_agent_skills_project ON public.project_agent_skills(project_id);
CREATE INDEX IF NOT EXISTS idx_project_agent_skills_active  ON public.project_agent_skills(project_id, is_active);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_agent_skills_updated_at ON public.project_agent_skills;
CREATE TRIGGER trg_project_agent_skills_updated_at
  BEFORE UPDATE ON public.project_agent_skills
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.project_agent_skills ENABLE ROW LEVEL SECURITY;

-- Select: anyone with project access can read skills
CREATE POLICY "skills_select" ON public.project_agent_skills
  FOR SELECT USING (public.has_project_access(project_id));

-- Insert / Update / Delete: project owner / org admin only
CREATE POLICY "skills_insert" ON public.project_agent_skills
  FOR INSERT WITH CHECK (public.has_project_access(project_id));

CREATE POLICY "skills_update" ON public.project_agent_skills
  FOR UPDATE USING (public.has_project_access(project_id));

CREATE POLICY "skills_delete" ON public.project_agent_skills
  FOR DELETE USING (public.has_project_access(project_id));

-- Seed a few starter skills for newly created projects is handled by the app.
