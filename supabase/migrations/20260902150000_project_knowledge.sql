-- Project knowledge: every piece of context a run may carry, as rows the
-- owner can see, archive and delete. Replaces the two free-text columns on
-- projects (custom_system_prompt, context_notes), which are migrated into
-- 'note' rows below and no longer read by the agent.
CREATE TABLE IF NOT EXISTS public.project_knowledge (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid        NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source      text        NOT NULL CHECK (source IN ('note', 'agent', 'chat', 'change', 'upload', 'codebase')),
  source_ref  text,
  heading     text        NOT NULL,
  content     text        NOT NULL,
  tokens      integer     NOT NULL DEFAULT 0,
  archived    boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Re-recording the same run/file updates the row instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS project_knowledge_source_ref_key
  ON public.project_knowledge (project_id, source, source_ref);
CREATE INDEX IF NOT EXISTS project_knowledge_project_active_idx
  ON public.project_knowledge (project_id, archived, created_at DESC);

ALTER TABLE public.project_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_manage_project_knowledge" ON public.project_knowledge
  FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM public.projects WHERE id = project_id)
      OR auth.uid() IN (SELECT created_by FROM public.projects WHERE id = project_id))
  WITH CHECK (auth.uid() IN (SELECT user_id FROM public.projects WHERE id = project_id)
      OR auth.uid() IN (SELECT created_by FROM public.projects WHERE id = project_id));

CREATE POLICY "service_role_project_knowledge" ON public.project_knowledge
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Carry the old free-text fields over as owner notes so nothing is lost.
INSERT INTO public.project_knowledge (project_id, source, source_ref, heading, content, tokens)
SELECT id, 'note', 'legacy-system-prompt', 'Custom instructions', custom_system_prompt,
       ceil(length(custom_system_prompt) / 4.0)::int
FROM public.projects
WHERE custom_system_prompt IS NOT NULL AND btrim(custom_system_prompt) <> ''
ON CONFLICT (project_id, source, source_ref) DO NOTHING;

INSERT INTO public.project_knowledge (project_id, source, source_ref, heading, content, tokens)
SELECT id, 'note', 'legacy-context-notes', 'Project context', context_notes,
       ceil(length(context_notes) / 4.0)::int
FROM public.projects
WHERE context_notes IS NOT NULL AND btrim(context_notes) <> ''
ON CONFLICT (project_id, source, source_ref) DO NOTHING;
