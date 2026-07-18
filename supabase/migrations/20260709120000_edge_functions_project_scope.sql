-- Fix: edge_functions was scoped by user_id only, so a user with multiple
-- projects could silently overwrite one project's function with another's
-- (same name), and invoking a function ran whichever project last wrote that
-- name against a DIFFERENT project's database credentials. Scope by project.

ALTER TABLE edge_functions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE edge_function_logs ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;

-- Backfill: best-effort — a user's sole project if they have exactly one,
-- otherwise leave NULL (ambiguous; those rows become inert until rewritten).
UPDATE edge_functions ef SET project_id = p.id
FROM public.projects p
WHERE ef.project_id IS NULL
  AND p.user_id = ef.user_id
  AND (SELECT COUNT(*) FROM public.projects p2 WHERE p2.user_id = ef.user_id) = 1;

UPDATE edge_function_logs l SET project_id = ef.project_id
FROM edge_functions ef
WHERE l.project_id IS NULL AND l.function_id = ef.id;

ALTER TABLE edge_functions DROP CONSTRAINT IF EXISTS edge_functions_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS edge_functions_project_id_name_key
  ON edge_functions (project_id, name) WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS edge_functions_project_id_idx ON edge_functions (project_id);
CREATE INDEX IF NOT EXISTS edge_function_logs_project_id_idx ON edge_function_logs (project_id);

DROP POLICY IF EXISTS "users_own_edge_functions" ON edge_functions;
CREATE POLICY "users_own_edge_functions" ON edge_functions
  FOR ALL USING (
    auth.uid() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
      OR project_id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid() AND role = 'editor')
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
      OR project_id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid() AND role = 'editor')
    )
  );

DROP POLICY IF EXISTS "users_own_function_logs" ON edge_function_logs;
CREATE POLICY "users_own_function_logs" ON edge_function_logs
  FOR ALL USING (
    auth.uid() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
      OR project_id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid() AND role = 'editor')
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
      OR project_id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid() AND role = 'editor')
    )
  );
