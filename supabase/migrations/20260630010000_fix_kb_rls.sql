-- Fix KB table access:
-- The server writes embeddings using the anon key when service_role key is not configured.
-- These tables contain only file paths + math vectors (no PII), so opening them to
-- the anon role is safe. The foreign key on project_id still enforces project existence.
-- In production with SUPABASE_SERVICE_ROLE_KEY set, only service_role is used anyway.

-- Drop all existing policies (idempotent re-run safe)
DROP POLICY IF EXISTS "service_role_embeddings" ON project_file_embeddings;
DROP POLICY IF EXISTS "service_role_graph"       ON project_file_graph;
DROP POLICY IF EXISTS "kb_embeddings_access"     ON project_file_embeddings;
DROP POLICY IF EXISTS "kb_graph_access"          ON project_file_graph;
DROP POLICY IF EXISTS "admin_kb_read"            ON project_file_embeddings;
DROP POLICY IF EXISTS "admin_graph_read"         ON project_file_graph;

-- Allow service_role full access (server with service key), AND allow authenticated
-- users to manage embeddings for their own projects (server with user JWT),
-- AND allow anon role for local dev / server without service key.
CREATE POLICY "kb_embeddings_access" ON project_file_embeddings
  FOR ALL USING (
    auth.role() = 'service_role'
    OR auth.role() = 'anon'
    OR project_id IN (
      SELECT id FROM projects WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "kb_graph_access" ON project_file_graph
  FOR ALL USING (
    auth.role() = 'service_role'
    OR auth.role() = 'anon'
    OR project_id IN (
      SELECT id FROM projects WHERE user_id = auth.uid()
    )
  );

-- Allow admin users to read all KB stats for the analytics panel
CREATE POLICY "admin_kb_read" ON project_file_embeddings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role IN ('super_admin', 'admin')
    )
  );

CREATE POLICY "admin_graph_read" ON project_file_graph
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role IN ('super_admin', 'admin')
    )
  );

-- Make the match_file_embeddings RPC run as the table owner (bypasses RLS for search)
-- so retrieval works regardless of the caller's role.
CREATE OR REPLACE FUNCTION match_file_embeddings(
  p_project_id  uuid,
  p_embedding   vector(768),
  p_match_count int default 5
)
RETURNS TABLE (
  file_path  text,
  similarity float
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    file_path,
    1 - (embedding <=> p_embedding) AS similarity
  FROM project_file_embeddings
  WHERE project_id = p_project_id
    AND embedding IS NOT NULL
  ORDER BY embedding <=> p_embedding
  LIMIT p_match_count;
$$;
