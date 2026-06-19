-- Add CASCADE delete to foreign keys for proper project deletion
-- This migration modifies existing constraints to cascade deletes

-- 1. Revisions -> Projects (CASCADE)
ALTER TABLE public.revisions 
  DROP CONSTRAINT IF EXISTS revisions_project_id_fkey;
ALTER TABLE public.revisions 
  ADD CONSTRAINT revisions_project_id_fkey 
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

-- 2. Messages -> Projects (CASCADE)
ALTER TABLE public.messages 
  DROP CONSTRAINT IF EXISTS messages_project_id_fkey;
ALTER TABLE public.messages 
  ADD CONSTRAINT messages_project_id_fkey 
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

-- 3. Revision Preview -> Revisions (CASCADE)
ALTER TABLE public.revision_preview 
  DROP CONSTRAINT IF EXISTS revision_preview_revision_id_fkey;
ALTER TABLE public.revision_preview 
  ADD CONSTRAINT revision_preview_revision_id_fkey 
  FOREIGN KEY (revision_id) REFERENCES public.revisions(id) ON DELETE CASCADE;

-- 4. Revision Preview -> Projects (CASCADE)
ALTER TABLE public.revision_preview 
  DROP CONSTRAINT IF EXISTS revision_preview_project_id_fkey;
ALTER TABLE public.revision_preview 
  ADD CONSTRAINT revision_preview_project_id_fkey 
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

-- 5. Project Members -> Projects (CASCADE)
ALTER TABLE public.project_members 
  DROP CONSTRAINT IF EXISTS project_members_project_id_fkey;
ALTER TABLE public.project_members 
  ADD CONSTRAINT project_members_project_id_fkey 
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
