/**
 * A summary that miscounts is worse than no summary: it gets believed.
 *
 * Shapes here come from the real 400-run sample pulled on 2026-08-30 —
 * 12 failed, 36 stuck-aborted, 32 with search misses, 22 with preview errors,
 * p50 78s and p95 475s against a 3295s max. The p50/p95 gap is the point:
 * a mean would have read ~120s and hidden the tail entirely.
 */
import { describe, it, expect } from 'vitest';
import { summarizeDelivery, groupStuckReasons, type AgentRunRow } from '../deliveryHealth';

const run = (over: Partial<AgentRunRow> = {}): AgentRunRow => ({
  status: 'completed',
  duration_ms: 1000,
  estimated_cost_usd: 0.1,
  edit_search_miss_count: 0,
  stuck_abort_reason: null,
  preview_errors: null,
  created_at: '2026-08-30T00:00:00Z',
  ...over,
});

describe('counting outcomes', () => {
  it('separates failed from stuck-aborted — a stuck run still completes', () => {
    // 36 of the 400 sampled runs carried a stuck reason while status stayed
    // 'completed'. Folding them into "failed" would overstate failure 4x.
    const rows = [run(), run({ status: 'failed' }), run({ stuck_abort_reason: 'stuck for 6 steps' })];
    const s = summarizeDelivery(rows);
    expect(s.failed).toBe(1);
    expect(s.stuckAborted).toBe(1);
    expect(s.runs).toBe(3);
  });

  it('counts a run once however many search misses it had', () => {
    const s = summarizeDelivery([run({ edit_search_miss_count: 9 }), run({ edit_search_miss_count: 0 })]);
    expect(s.withSearchMisses).toBe(1);
  });

  it('reads preview_errors as both an array and a bare string', () => {
    // The jsonb column has held both shapes.
    const s = summarizeDelivery([
      run({ preview_errors: ['TS2304'] }),
      run({ preview_errors: 'build failed' }),
      run({ preview_errors: [] }),
      run({ preview_errors: null }),
    ]);
    expect(s.withPreviewErrors).toBe(2);
  });
});

describe('percentiles, not averages', () => {
  it('reports a tail the mean would hide', () => {
    // Mirrors the real sample: a dense body around 78s with a slow quarter
    // reaching 475s. The mean of this set is ~177s, which describes neither.
    const rows = [
      ...[...Array(15)].map(() => run({ duration_ms: 78_000 })),
      ...[...Array(5)].map(() => run({ duration_ms: 475_000 })),
    ];
    const s = summarizeDelivery(rows);
    expect(s.durationP50Ms).toBe(78_000);
    expect(s.durationP95Ms).toBe(475_000);
  });

  it('does not let a lone extreme outlier drag p95', () => {
    // Nearest-rank p95 over 20 items lands on the 19th, so one 55-minute run
    // is visible in max but must not be reported as the 95th percentile.
    const rows = [...[...Array(19)].map(() => run({ duration_ms: 78_000 })), run({ duration_ms: 3_295_000 })];
    expect(summarizeDelivery(rows).durationP95Ms).toBe(78_000);
  });

  it('ignores null and negative durations rather than counting them as zero', () => {
    const s = summarizeDelivery([run({ duration_ms: null }), run({ duration_ms: -1 }), run({ duration_ms: 500 })]);
    expect(s.durationP50Ms).toBe(500);
  });
});

describe('empty and degenerate input', () => {
  it('returns zeros rather than NaN for no runs', () => {
    const s = summarizeDelivery([]);
    expect(s.successRate).toBe(0);
    expect(s.durationP50Ms).toBe(0);
    expect(s.durationP95Ms).toBe(0);
    expect(s.totalCostUsd).toBe(0);
  });

  it('treats a missing cost as zero, not as a break', () => {
    expect(summarizeDelivery([run({ estimated_cost_usd: null }), run({ estimated_cost_usd: 0.5 })]).totalCostUsd).toBe(0.5);
  });

  it('computes success rate over all runs, including stuck ones', () => {
    const s = summarizeDelivery([run(), run(), run({ status: 'failed' }), run({ status: 'failed' })]);
    expect(s.successRate).toBe(0.5);
  });
});

describe('grouping stuck reasons', () => {
  it('collapses the step count so distinct failure modes surface', () => {
    // Raw strings produced ten buckets from 36 runs. There are two modes.
    const rows = [
      run({ stuck_abort_reason: 'stuck analyzing without making a change for 6 steps' }),
      run({ stuck_abort_reason: 'stuck analyzing without making a change for 14 steps' }),
      run({ stuck_abort_reason: 'stuck analyzing without making a change for 18 steps' }),
      run({ stuck_abort_reason: 'stuck analyzing without making a change for 6 steps, and the build is confirmed broken' }),
    ];
    const g = groupStuckReasons(rows);
    expect(g).toHaveLength(2);
    expect(g[0].count).toBe(3);
    expect(g[0].reason).toContain('N steps');
  });

  it('orders by frequency so the dominant mode reads first', () => {
    const g = groupStuckReasons([
      run({ stuck_abort_reason: 'rare thing for 2 steps' }),
      run({ stuck_abort_reason: 'common thing for 3 steps' }),
      run({ stuck_abort_reason: 'common thing for 9 steps' }),
    ]);
    expect(g[0].reason).toContain('common');
    expect(g[0].count).toBe(2);
  });

  it('ignores runs with no stuck reason', () => {
    expect(groupStuckReasons([run(), run()])).toEqual([]);
  });
});
