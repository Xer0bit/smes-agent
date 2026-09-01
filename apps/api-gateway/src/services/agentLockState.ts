/**
 * Liveness of the cross-worker `agent_locks` row.
 *
 * This lives in its own module because two very different callers need the same
 * bound: the route that decides whether a project is busy, and the watchdog that
 * decides whether an `agent_runs` row still has a process behind it. Duplicating
 * the staleness constant across those two would let them disagree, and the
 * disagreement is exactly the user-visible bug class it was written to close --
 * one component reporting a run that the other has already written off.
 */

/**
 * How long a lock survives without a heartbeat before another request may
 * reclaim it. A LIVE run refreshes `acquired_at` every
 * AGENT_LOCK_HEARTBEAT_MS, so this is a few missed beats, not a guess at the
 * longest plausible run.
 */
export const AGENT_LOCK_STALE_MS = 3 * 60_000;
export const AGENT_LOCK_HEARTBEAT_MS = 30_000;

export function isLockLive(acquiredAt: string, now: number = Date.now()): boolean {
  // An unparseable timestamp yields NaN, and `NaN <= x` is false -- so a
  // garbage value reads as dead (reclaimable) rather than live-forever, which
  // is the safe direction: the wrong one would wedge the project permanently.
  return now - new Date(acquiredAt).getTime() <= AGENT_LOCK_STALE_MS;
}

export interface AgentRunRow {
  id: string;
  project_id: string;
  started_at: string;
}

export interface AgentLockRow {
  project_id: string;
  acquired_at: string;
}

/**
 * Which `status='running'` rows no longer have a process behind them.
 *
 * A run holds its project's lock for its whole life and heartbeats it, so "no
 * live lock" is positive evidence the owner is gone -- a killed worker, an OOM,
 * a deploy. That is a far better signal than the age-only cutoff this replaces,
 * which had to sit above the longest plausible run (20 minutes) purely to avoid
 * killing healthy ones, and so left every genuinely dead run lying about its
 * status for that entire window after each restart.
 *
 * `graceMs` still guards the one race the lock cannot: the moment between the
 * `agent_runs` insert and the lock row becoming visible to another worker's
 * read.
 */
export function selectAbandonedRuns(
  runs: readonly AgentRunRow[],
  locks: readonly AgentLockRow[],
  now: number,
  graceMs: number,
): AgentRunRow[] {
  const liveProjects = new Set(
    locks.filter((l) => isLockLive(l.acquired_at, now)).map((l) => l.project_id),
  );
  return runs.filter((r) => {
    if (liveProjects.has(r.project_id)) return false;
    const age = now - new Date(r.started_at).getTime();
    // NaN age (unparseable started_at) must NOT be swept: without a readable
    // start time there is no evidence of abandonment, and failing a healthy run
    // is worse than leaving a stale row for a human to notice.
    return age > graceMs;
  });
}
