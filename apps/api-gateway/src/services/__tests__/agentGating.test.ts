/**
 * The never-regress contract for increment-1 real-signal gating.
 *
 * Each gate reads ONE tri-state flag (ctx.lastBuildErrorsHealthy). The whole
 * point of the increment is: an explicit `false` (a real build check confirmed
 * broken) tightens the gate, while `undefined` (never checked -- the default on
 * every run that doesn't call get_build_errors, and after every write resets it)
 * must behave EXACTLY as before the flag existed. `true` is treated as the
 * permissive default too: a build that passed is not a reason to abort harder.
 *
 * These are trivial predicates, which is exactly why they need a test: they are
 * buried in a 3000-line loop where a formatter or a refactor could flip a `===`
 * or drop a branch and nothing else would notice until an agent run misbehaved
 * in production.
 */
import { describe, it, expect } from 'vitest';
import {
  phantomAbortThresholdFor,
  isStuckAndBuildKnownBroken,
  unfulfilledPromiseNote,
} from '../agentGating.js';

describe('phantomAbortThresholdFor', () => {
  it('tightens 3 -> 2 only when the build is confirmed broken', () => {
    expect(phantomAbortThresholdFor(false)).toBe(2);
  });

  it('stays at the default 3 for healthy and never-checked (no regression)', () => {
    expect(phantomAbortThresholdFor(true)).toBe(3);
    expect(phantomAbortThresholdFor(undefined)).toBe(3);
  });
});

describe('isStuckAndBuildKnownBroken', () => {
  const T = 6; // STUCK_ANALYSIS_THRESHOLD

  it('fires only when stuck AND the build is confirmed broken', () => {
    expect(isStuckAndBuildKnownBroken(6, T, false)).toBe(true);
    expect(isStuckAndBuildKnownBroken(9, T, false)).toBe(true);
  });

  it('does not fire below the step threshold even with a broken build', () => {
    expect(isStuckAndBuildKnownBroken(5, T, false)).toBe(false);
  });

  it('never fires on a healthy or never-checked build (no regression)', () => {
    expect(isStuckAndBuildKnownBroken(9, T, true)).toBe(false);
    expect(isStuckAndBuildKnownBroken(9, T, undefined)).toBe(false);
  });
});

describe('unfulfilledPromiseNote', () => {
  it('names the real build errors only when the build is confirmed broken', () => {
    expect(unfulfilledPromiseNote(false)).toContain('the last build check showed real errors');
  });

  it('uses the neutral note for healthy and never-checked (no regression)', () => {
    for (const h of [true, undefined] as const) {
      const note = unfulfilledPromiseNote(h);
      expect(note).toContain("Let me know if you'd like me to go ahead");
      expect(note).not.toContain('showed real errors');
    }
  });
});
