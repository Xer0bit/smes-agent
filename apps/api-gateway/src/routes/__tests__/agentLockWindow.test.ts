/**
 * The agent lock has exactly one staleness bound, and two callers depend on it
 * agreeing with itself:
 *
 *   - tryAcquireAgentLock  -> "is this lock dead enough to steal?"
 *   - readLiveAgentLock    -> "is this lock alive enough to report to the UI?"
 *
 * When those were two separate inline comparisons, a lock could sit in a dead
 * zone where /active-run reported nothing running while the lock check still
 * rejected the user's next message -- the reported "it says a generation is
 * already running, but I don't see one" bug. isLockLive is now the single
 * bound; this pins the boundary behaviour so a future edit to either caller
 * fails here instead of in production.
 */
import { describe, it, expect, vi } from 'vitest';

// ai.routes.ts -> config/database.js throws at module load without SUPABASE_*;
// isLockLive is pure arithmetic over a timestamp and touches none of it.
// Same shape as healthServiceRole.test.ts.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { isLockLive } from '../ai.routes.js';

const MIN = 60_000;

describe('agent lock staleness window', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('treats a just-acquired lock as live', () => {
    expect(isLockLive(ago(0), now)).toBe(true);
  });

  it('treats a lock refreshed within the heartbeat interval as live', () => {
    // A healthy run re-stamps acquired_at every 30s, so this is the steady
    // state of every in-flight generation.
    expect(isLockLive(ago(30_000), now)).toBe(true);
  });

  it('still treats a lock that missed several heartbeats as live', () => {
    // Transient Supabase failures must not let another request steal the lock
    // out from under a run that is genuinely still going.
    expect(isLockLive(ago(2 * MIN), now)).toBe(true);
  });

  it('treats a lock abandoned past the bound as dead', () => {
    // The SIGKILLed-worker case: nothing is refreshing this row any more.
    expect(isLockLive(ago(4 * MIN), now)).toBe(false);
  });

  it('does not resurrect the old 15-minute wedge', () => {
    // Regression guard: before the heartbeat, a leaked lock blocked the project
    // for 15 minutes against a ~10s client retry budget.
    expect(isLockLive(ago(15 * MIN), now)).toBe(false);
  });

  it('rejects an unparseable timestamp rather than reporting it live', () => {
    // A garbage value must fail toward "not live" so it can be reclaimed,
    // never toward "live forever", which would wedge the project permanently.
    expect(isLockLive('not-a-date', now)).toBe(false);
  });
});
