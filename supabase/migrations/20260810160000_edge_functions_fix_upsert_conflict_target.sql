-- Fix: on this dev machine's local Supabase, edge_functions_project_id_name_key
-- was a PARTIAL unique index (WHERE project_id IS NOT NULL, added by
-- 20260709120000). Postgres can only use a partial index as an ON CONFLICT
-- arbiter when the ON CONFLICT clause repeats the same WHERE predicate --
-- PostgREST's upsert (`on_conflict=project_id,name`, used by
-- ecg-dev-agent.routes.ts's edge function seed steps) has no way to express
-- that, so every such upsert failed with "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification" there (confirmed live
-- via psql, 2026-08-10). The calling code never checked the Supabase
-- response's `.error` field either, so this silently no-op-ed behind a
-- "done" SSE status.
--
-- Deploy-time finding (VPS1, same day): production's index of this name is
-- NOT partial -- it's a full UNIQUE CONSTRAINT (confirmed: ON CONFLICT
-- (project_id, name) already works correctly against it). The two
-- environments diverged, likely because 20260709120000's
-- `CREATE UNIQUE INDEX IF NOT EXISTS` silently kept an already-present
-- full constraint of the same name on production instead of replacing it,
-- while a fresh local dev DB created the partial version for real.
--
-- This migration is therefore conditional: only replace the index if it is
-- actually partial. On production (already full, already correct) it is a
-- deliberate no-op. Only PostgreSQL's own catalog (pg_indexes.indexdef, "...
-- WHERE ..." iff partial) is trusted to decide -- not an assumption about
-- which environment this runs in.
DO $$
DECLARE
  def text;
BEGIN
  SELECT indexdef INTO def FROM pg_indexes WHERE indexname = 'edge_functions_project_id_name_key';
  IF def IS NOT NULL AND def ILIKE '%WHERE%' THEN
    EXECUTE 'ALTER TABLE edge_functions DROP CONSTRAINT IF EXISTS edge_functions_project_id_name_key';
    EXECUTE 'DROP INDEX IF EXISTS edge_functions_project_id_name_key';
    EXECUTE 'CREATE UNIQUE INDEX edge_functions_project_id_name_key ON edge_functions (project_id, name)';
  END IF;
END $$;
