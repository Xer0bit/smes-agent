/**
 * Delivery health, derived from agent_runs.
 *
 * Kept pure and separate from the page for the reason pushOutcome was: a
 * summary that silently miscounts is worse than no summary, and a component
 * cannot be tested.
 *
 * Deliberately narrow. It reads only columns that are actually written on
 * every run. `preview_promoted` is excluded from the ratio for existing rows:
 * the column has carried DEFAULT false since 20260417100000 and nothing wrote
 * it until now, so a promotion rate computed over historical rows would report
 * 0% forever and look like a catastrophic outage rather than a missing feed.
 * It becomes meaningful once rows written after that fix accumulate.
 */

export interface AgentRunRow {
  status: string | null;
  duration_ms: number | null;
  estimated_cost_usd: number | null;
  edit_search_miss_count: number | null;
  stuck_abort_reason: string | null;
  preview_errors: unknown;
  created_at: string | null;
}

export interface DeliveryHealth {
  runs: number;
  failed: number;
  stuckAborted: number;
  withSearchMisses: number;
  withPreviewErrors: number;
  /** Share of runs that reached 'completed'. 0 when there are no runs. */
  successRate: number;
  durationP50Ms: number;
  durationP95Ms: number;
  totalCostUsd: number;
}

/** Nearest-rank percentile. Returns 0 for an empty set rather than NaN. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function hasPreviewErrors(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  // The column is jsonb and has held both an array and a bare string.
  return typeof value === 'string' ? value.length > 0 : false;
}

export function summarizeDelivery(rows: readonly AgentRunRow[]): DeliveryHealth {
  const durations = rows
    .map((r) => r.duration_ms)
    .filter((d): d is number => typeof d === 'number' && d >= 0)
    .sort((a, b) => a - b);

  const completed = rows.filter((r) => r.status === 'completed').length;

  return {
    runs: rows.length,
    failed: rows.filter((r) => r.status === 'failed').length,
    stuckAborted: rows.filter((r) => Boolean(r.stuck_abort_reason)).length,
    withSearchMisses: rows.filter((r) => (r.edit_search_miss_count ?? 0) > 0).length,
    withPreviewErrors: rows.filter((r) => hasPreviewErrors(r.preview_errors)).length,
    successRate: rows.length === 0 ? 0 : completed / rows.length,
    durationP50Ms: percentile(durations, 50),
    durationP95Ms: percentile(durations, 95),
    totalCostUsd: rows.reduce((sum, r) => sum + (r.estimated_cost_usd ?? 0), 0),
  };
}

/**
 * Group stuck-abort reasons by their shape rather than their step count.
 *
 * The reason string embeds the step number ("stuck analyzing without making a
 * change for 14 steps"), so counting raw strings produced ten near-identical
 * buckets from 36 runs and hid the fact that they are two failure modes.
 */
export function groupStuckReasons(rows: readonly AgentRunRow[]): Array<{ reason: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    if (!row.stuck_abort_reason) continue;
    const shape = row.stuck_abort_reason.replace(/\b\d+\s+steps?\b/, 'N steps');
    buckets.set(shape, (buckets.get(shape) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}
