-- Fix: edge_functions_project_id_name_key is a PARTIAL unique index
-- (WHERE project_id IS NOT NULL, added by 20260709120000). Postgres can only
-- use a partial index as an ON CONFLICT arbiter when the ON CONFLICT clause
-- itself repeats the same WHERE predicate -- PostgREST's upsert
-- (`on_conflict=project_id,name`, used by ecg-dev-agent.routes.ts's edge
-- function seed steps) has no way to express that, so every such upsert has
-- been failing with "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" (confirmed live via psql, 2026-08-10). The
-- calling code never checked the Supabase response's `.error` field, so this
-- has been silently no-op-ing -- SSE steps reported "done" while zero rows
-- ever landed.
--
-- Fix: drop the partial index, replace with a plain unique index on the same
-- columns. NULL is never treated as a duplicate by a standard unique index
-- either, so legacy project_id-less rows (the pre-project_id user_id-scoped
-- rows) still coexist exactly as before -- this changes nothing about which
-- rows are considered distinct, only makes the index usable as a conflict
-- target.
DROP INDEX IF EXISTS edge_functions_project_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS edge_functions_project_id_name_key
  ON edge_functions (project_id, name);
