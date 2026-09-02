-- agent_runs becomes the durable run record (#6 Phase 1).
--
-- Today a run's state is split across four places and none is authoritative:
--   activeAgentRuns  (per-process memory -- gone when the worker dies)
--   agent_locks      (who holds the project, and the only liveness signal)
--   agent_runs       (status, but no owner and no heartbeat)
--   the Redis stream mirror
--
-- Consequences measured over 14 days of traces: 84 of 477 runs (17.6%) produced
-- steps and then never recorded an outcome. The watchdog has to INFER liveness
-- from agent_locks because the run row cannot say who owns it, so two tables
-- encode one fact and can disagree.
--
-- These four columns let the run row answer for itself. All nullable with no
-- backfill: existing rows keep working, and code paths that do not set them are
-- unchanged.

ALTER TABLE public.agent_runs
  -- Which worker owns this run. The watchdog currently borrows agent_locks'
  -- liveness because this does not exist.
  ADD COLUMN IF NOT EXISTS worker_id text,

  -- Where the run is. 'completed' alone cannot distinguish "still generating"
  -- from "generating finished, publishing to preview" -- and the publish phase
  -- was measured at 104-139s, long enough that the difference is user-visible.
  ADD COLUMN IF NOT EXISTS phase text,

  -- The revision this run produced. Its absence is why manifest rollback has to
  -- resolve a run's revision by TIME WINDOW (runSandbox.findRunRevision),
  -- relying on the project lock to guarantee no two runs overlap.
  ADD COLUMN IF NOT EXISTS revision_id uuid,

  -- Proof of life, so a dead run is detectable from this row alone.
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN public.agent_runs.worker_id IS
  'Process/worker that owns this run (e.g. pid:1234@host). Null for rows written before 2026-09-02.';
COMMENT ON COLUMN public.agent_runs.phase IS
  'preparing | generating | publishing | persisting | done. Finer-grained than status.';
COMMENT ON COLUMN public.agent_runs.revision_id IS
  'Revision this run produced, so rollback need not resolve it by time window.';
COMMENT ON COLUMN public.agent_runs.heartbeat_at IS
  'Last liveness beat. A running row whose heartbeat has lapsed is abandoned.';

-- The watchdog's query: running rows ordered by liveness. Partial index because
-- only running rows are ever swept, and they are a small minority.
CREATE INDEX IF NOT EXISTS agent_runs_running_heartbeat_idx
  ON public.agent_runs (heartbeat_at)
  WHERE status = 'running';

-- Rollback's lookup: the revision a given run produced.
CREATE INDEX IF NOT EXISTS agent_runs_revision_idx
  ON public.agent_runs (revision_id)
  WHERE revision_id IS NOT NULL;
