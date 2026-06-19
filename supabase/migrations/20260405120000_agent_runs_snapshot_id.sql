-- =============================================================================
-- Agent Runs: add snapshot_id for persistent version history
-- Each completed agent run can now reference the snapshot taken before it ran,
-- so users can browse all versions and restore to any point in time.
-- =============================================================================

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS snapshot_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_snapshot
  ON public.agent_runs(project_id, created_at DESC)
  WHERE snapshot_id IS NOT NULL AND status = 'completed';

COMMENT ON COLUMN public.agent_runs.snapshot_id IS
  'Identifies the on-disk snapshot directory (under SNAPSHOTS_DIR) taken before this run. '
  'Set to NULL when the snapshot has been pruned.';
