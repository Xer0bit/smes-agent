/**
 * The run's own durable record: who owns it, what phase it is in, is it alive.
 *
 * Before this, a run's state lived in four places and none was authoritative:
 * `activeAgentRuns` (per-process memory, gone when the worker dies),
 * `agent_locks` (the only liveness signal), `agent_runs` (status, but no owner
 * and no heartbeat) and the Redis stream mirror. The watchdog had to INFER
 * liveness from `agent_locks` because the run row could not say who owned it --
 * two tables encoding one fact, free to disagree.
 *
 * Measured over 14 days of traces: 84 of 477 runs (17.6%) produced steps and
 * then never recorded an outcome. A heartbeat on the row itself makes that
 * detectable from the row alone, without borrowing another table's meaning.
 *
 * Every write here is best-effort. Bookkeeping must never fail a run: an
 * un-beaten heartbeat costs a sweep, a thrown error costs the user their work.
 */
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

/** Coarse position in the run, finer-grained than `status`. */
export type RunPhase = 'preparing' | 'generating' | 'publishing' | 'persisting' | 'done';

/** How often a live run proves it is alive. */
export const RUN_HEARTBEAT_MS = 30_000;

/**
 * Identifies the process that owns a run. Host included because PM2 pids repeat
 * across machines and this fleet runs the same code on several.
 */
export function workerId(): string {
  return `pid:${process.pid}@${process.env.HOSTNAME || 'unknown'}`;
}

/** Claim ownership and start the clock. Call once, right after the row exists. */
export async function claimRun(agentRunId: string): Promise<void> {
  if (!supabase || !agentRunId) return;
  try {
    await supabase
      .from('agent_runs')
      .update({ worker_id: workerId(), phase: 'preparing', heartbeat_at: new Date().toISOString() })
      .eq('id', agentRunId);
  } catch (err) {
    logger.debug('[runRecord] claim failed (non-fatal)', { agentRunId, error: (err as Error)?.message });
  }
}

/** Record which stage the run reached, and beat the heartbeat while doing it. */
export async function setPhase(agentRunId: string | null, phase: RunPhase): Promise<void> {
  if (!supabase || !agentRunId) return;
  try {
    await supabase
      .from('agent_runs')
      .update({ phase, heartbeat_at: new Date().toISOString() })
      .eq('id', agentRunId);
  } catch (err) {
    logger.debug('[runRecord] phase update failed (non-fatal)', { agentRunId, phase, error: (err as Error)?.message });
  }
}

/**
 * Beat until stopped. Returns the stop function.
 *
 * `unref` so a forgotten timer can never hold the process open during a deploy
 * drain -- the shutdown path already has enough to do.
 */
export function startRunHeartbeat(agentRunId: string | null): () => void {
  if (!supabase || !agentRunId) return () => {};
  const timer = setInterval(() => {
    void supabase
      .from('agent_runs')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', agentRunId)
      .then(undefined, () => { /* a missed beat costs a sweep, not a run */ });
  }, RUN_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearTimeout(timer as unknown as NodeJS.Timeout);
}

/**
 * Link the run to the revision it produced.
 *
 * Without this, manifest rollback resolves a run's revision by TIME WINDOW,
 * relying on the project lock to guarantee no two runs overlap. That inference
 * is correct today but it is an inference; this is the fact.
 */
export async function linkRevision(agentRunId: string | null, revisionId: string | undefined): Promise<void> {
  if (!supabase || !agentRunId || !revisionId) return;
  try {
    await supabase.from('agent_runs').update({ revision_id: revisionId }).eq('id', agentRunId);
  } catch (err) {
    logger.debug('[runRecord] revision link failed (non-fatal)', { agentRunId, revisionId, error: (err as Error)?.message });
  }
}

/**
 * Rows that are still 'running' but whose heartbeat has lapsed.
 *
 * Pure so the staleness decision is testable without a database: it decides
 * whether a run is declared dead, and being wrong either strands a row forever
 * or kills a healthy run.
 */
export function selectStaleByHeartbeat<T extends { id: string; heartbeat_at?: string | null }>(
  rows: readonly T[],
  now: number,
  missedBeatsAllowed = 6,
): T[] {
  const cutoff = RUN_HEARTBEAT_MS * missedBeatsAllowed;
  return rows.filter((r) => {
    // No heartbeat at all: pre-2026-09-02 rows, and rows whose claim never
    // landed. Not evidence of death -- leave those to the lock-based sweep.
    if (!r.heartbeat_at) return false;
    const age = now - new Date(r.heartbeat_at).getTime();
    return Number.isFinite(age) && age > cutoff;
  });
}
