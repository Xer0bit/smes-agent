-- Add missing RLS policies for revisions
-- Without these, INSERT/SELECT/UPDATE/DELETE are denied when RLS is enabled.

ALTER TABLE revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view revisions" ON revisions;
DROP POLICY IF EXISTS "Users can insert revisions" ON revisions;
DROP POLICY IF EXISTS "Users can update revisions" ON revisions;
DROP POLICY IF EXISTS "Users can delete revisions" ON revisions;

CREATE POLICY "Users can view revisions" ON revisions
  FOR SELECT USING (
    has_project_access(project_id)
  );

CREATE POLICY "Users can insert revisions" ON revisions
  FOR INSERT WITH CHECK (
    has_project_access(project_id)
    AND (user_id = auth.uid() OR user_id IS NULL)
  );

CREATE POLICY "Users can update revisions" ON revisions
  FOR UPDATE USING (
    has_project_access(project_id)
  )
  WITH CHECK (
    has_project_access(project_id)
  );

CREATE POLICY "Users can delete revisions" ON revisions
  FOR DELETE USING (
    has_project_access(project_id)
  );
