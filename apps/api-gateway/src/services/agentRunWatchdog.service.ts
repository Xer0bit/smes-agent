/**
 * agent_runs watchdog -- periodic sweep that marks rows stuck in
 * status='running' as failed once they've clearly been abandoned.
 *
 * runAgentLoop() already updates the row to 'completed'/'failed' on every
 * normal exit path (success, caught exception, abort) -- see
 * agentLoopService.ts. Those updates are fire-and-forget (not awaited), so
 * a genuinely hung run (an awaited operation that never settles, not a
 * crash) never reaches ANY of those update sites: the try block simply
 * never finishes, so the row stays 'running' forever even though the
 * process is alive and healthy otherwise. Confirmed live 2026-08-09: one
 * row stuck at steps_taken=0 for hours despite AGENT_TIMEOUT_MS's 8-minute
 * default, meaning the timeout's own abort() didn't unblock whatever
 * hung -- a second-layer safety net, not a fix for that root cause.
 *
 * Deliberately a dumb, safe sweep (no attempt to touch the actual run,
 * its lock, or its process) -- just closes the visible-lie gap so
 * "status=running" is trustworthy again. STALE_AFTER_MS is set well above
 * AGENT_TIMEOUT_MS's max (8 min) so this never races the normal timeout
 * path's own cleanup.
 */
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_AFTER_MS = 20 * 60 * 1000; // 20 minutes -- 2.5x AGENT_TIMEOUT_MS's 8min default

let watchdogTimer: NodeJS.Timeout | null = null;

export async function sweepStaleAgentRuns(): Promise<number> {
  if (!supabase) return 0;
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from('agent_runs')
    .update({
      status: 'failed',
      error_message: `Run did not complete within ${STALE_AFTER_MS / 60_000} minutes and was marked failed by the watchdog (likely a hung operation the run's own timeout failed to unblock).`,
      completed_at: new Date().toISOString(),
    })
    .eq('status', 'running')
    .lt('started_at', cutoff)
    .select('id, project_id');

  if (error) {
    logger.warn('[AgentRunWatchdog] sweep failed:', error.message);
    return 0;
  }
  const count = data?.length ?? 0;
  if (count > 0) {
    logger.warn(`[AgentRunWatchdog] marked ${count} stale run(s) as failed:`, data?.map((r: any) => r.id));
  }
  return count;
}

/** Idempotent; call once at startup. */
export function startAgentRunWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    sweepStaleAgentRuns().catch((err) => logger.warn('[AgentRunWatchdog] sweep error:', err?.message));
  }, SWEEP_INTERVAL_MS);
  watchdogTimer.unref?.();
}
