-- Community templates: a project its owner shares as a starting point.
-- Anyone signed in can browse the gallery and "remix" one: a new project in
-- their workspace seeded with the template's latest revision files.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_template            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_category      text,
  ADD COLUMN IF NOT EXISTS template_tags          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS template_published_at  timestamptz,
  ADD COLUMN IF NOT EXISTS remix_count            integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS template_source_id     uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS projects_templates_idx ON public.projects (template_published_at DESC) WHERE is_template;

CREATE OR REPLACE FUNCTION public.increment_remix_count(p_project_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.projects SET remix_count = remix_count + 1 WHERE id = p_project_id;
$$;
