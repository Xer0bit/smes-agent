/**
 * agent_runs watchdog -- marks rows stuck in status='running' as failed once
 * their owning process is provably gone.
 *
 * runAgentLoop() updates the row to 'completed'/'failed' on every normal exit
 * path, but those updates are fire-and-forget, so two cases never reach any of
 * them: a genuinely hung run (an awaited operation that never settles -- see
 * the row confirmed stuck at steps_taken=0 for hours on 2026-08-09), and a run
 * whose worker died mid-flight (OOM, SIGKILL, a deploy). The second is routine:
 * every deploy of the gen server kills whatever was running.
 *
 * HOW ABANDONMENT IS DECIDED. A run holds its project's `agent_locks` row for
 * its entire life and heartbeats it every AGENT_LOCK_HEARTBEAT_MS, so a missing
 * or stale lock is positive evidence that nothing is behind the row any more.
 * This replaces an age-only cutoff (20 minutes, chosen to sit above the longest
 * plausible run so it could not kill a healthy one), which meant every run
 * killed by a restart kept claiming `status='running'` for twenty minutes --
 * long enough for the UI to show a generation that no process was working on.
 * Liveness is read from the same helper the route uses, so the two can never
 * disagree about whether a project is busy.
 */
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { isLockLive, selectAbandonedRuns, type AgentLockRow, type AgentRunRow } from './agentLockState.js';
import { discardSandbox, listSandboxDirs, selectOrphanedSandboxes } from './runSandbox.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Ignore rows younger than this. The lock is the real signal; this only covers
 * the gap between the `agent_runs` insert and the lock row being visible to
 * another worker's read.
 */
const GRACE_MS = 2 * 60 * 1000;
/** Rows older than this are swept even if a lock still looks live, since a lock that outlives this is itself wrong. */
const HARD_CEILING_MS = 60 * 60 * 1000;
/** A sandbox must be untouched this long before it can be considered stranded. */
const SANDBOX_MIN_AGE_MS = 30 * 60 * 1000;

let watchdogTimer: NodeJS.Timeout | null = null;

export async function sweepStaleAgentRuns(reason = 'periodic'): Promise<number> {
  if (!supabase) return 0;

  const { data: runs, error: runsError } = await supabase
    .from('agent_runs')
    .select('id, project_id, started_at')
    .eq('status', 'running');

  if (runsError) {
    logger.warn('[AgentRunWatchdog] could not read running rows:', runsError.message);
    return 0;
  }
  if (!runs || runs.length === 0) return 0;

  const runRows: AgentRunRow[] = runs;
  const projectIds = [...new Set(runRows.map((r) => r.project_id))];
  const { data: locks, error: locksError } = await supabase
    .from('agent_locks')
    .select('project_id, acquired_at')
    .in('project_id', projectIds);

  if (locksError) {
    // Without lock state every run looks abandoned. Failing healthy runs is far
    // worse than leaving stale rows for the next sweep, so do nothing.
    logger.warn('[AgentRunWatchdog] could not read locks, skipping sweep:', locksError.message);
    return 0;
  }

  const now = Date.now();
  const lockRows: AgentLockRow[] = locks ?? [];
  const abandoned = selectAbandonedRuns(runRows, lockRows, now, GRACE_MS);
  // A run whose lock somehow stayed fresh past the ceiling is a stuck heartbeat,
  // not a live run. This is the old age-only rule, kept only as a backstop.
  const overdue = runRows.filter(
    (r) => now - new Date(r.started_at).getTime() > HARD_CEILING_MS,
  );
  const ids = [...new Set([...abandoned, ...overdue].map((r) => r.id))];
  if (ids.length === 0) return 0;

  const { error } = await supabase
    .from('agent_runs')
    .update({
      status: 'failed',
      error_message:
        'The worker running this generation exited before it finished (deploy, restart, or crash). '
        + 'Any files it had already committed to a revision are kept; anything still in its sandbox was discarded.',
      completed_at: new Date().toISOString(),
    })
    .in('id', ids);

  if (error) {
    logger.warn('[AgentRunWatchdog] sweep update failed:', error.message);
    return 0;
  }
  logger.warn(`[AgentRunWatchdog] marked ${ids.length} abandoned run(s) as failed (${reason}):`, ids);
  return ids.length;
}

/**
 * Remove run sandboxes stranded on disk by a worker that died mid-run.
 *
 * `discardSandbox` runs in the route's `finally`, which a SIGKILLed or OOMed
 * worker never reaches, so every such death leaves a full source tree behind
 * with nothing that would ever remove it. Uses the same lock-liveness signal as
 * the run sweep, plus an age floor, before deleting anything.
 */
export async function sweepOrphanedSandboxes(): Promise<number> {
  const dirs = listSandboxDirs();
  if (dirs.length === 0) return 0;

  let liveProjectIds = new Set<string>();
  if (supabase) {
    const { data: locks, error } = await supabase
      .from('agent_locks')
      .select('project_id, acquired_at')
      .in('project_id', [...new Set(dirs.map((d) => d.projectId))]);
    if (error) {
      // Same rule as the run sweep: with no liveness information every sandbox
      // looks orphaned, and deleting a live run's working tree is unrecoverable.
      logger.warn('[AgentRunWatchdog] could not read locks, skipping sandbox sweep:', error.message);
      return 0;
    }
    const now = Date.now();
    const lockRows: AgentLockRow[] = locks ?? [];
    liveProjectIds = new Set(
      lockRows.filter((l) => isLockLive(l.acquired_at, now)).map((l) => l.project_id),
    );
  }

  const orphans = selectOrphanedSandboxes(dirs, liveProjectIds, Date.now(), SANDBOX_MIN_AGE_MS);
  for (const o of orphans) discardSandbox(o.sandboxPath);
  if (orphans.length > 0) {
    logger.warn(
      `[AgentRunWatchdog] removed ${orphans.length} stranded run sandbox(es)`,
      orphans.map((o) => `${o.projectId}/${o.runId}`),
    );
  }
  return orphans.length;
}

/**
 * Idempotent; call once at startup.
 *
 * Sweeps immediately as well as on the interval: a restart is the single most
 * likely reason for an abandoned row to exist, and waiting a full interval to
 * notice means the UI keeps showing a dead run for that whole window.
 */
export function startAgentRunWatchdog(): void {
  if (watchdogTimer) return;
  sweepStaleAgentRuns('startup').catch((err) =>
    logger.warn('[AgentRunWatchdog] startup sweep error:', err?.message),
  );
  sweepOrphanedSandboxes().catch((err) =>
    logger.warn('[AgentRunWatchdog] startup sandbox sweep error:', err?.message),
  );
  watchdogTimer = setInterval(() => {
    sweepStaleAgentRuns().catch((err) => logger.warn('[AgentRunWatchdog] sweep error:', err?.message));
    sweepOrphanedSandboxes().catch((err) => logger.warn('[AgentRunWatchdog] sandbox sweep error:', err?.message));
  }, SWEEP_INTERVAL_MS);
  watchdogTimer.unref?.();
}
