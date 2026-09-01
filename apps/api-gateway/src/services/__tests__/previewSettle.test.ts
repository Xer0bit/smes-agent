/**
 * This decides whether a run gets handed to the repair pipeline, which edits
 * files. A wrong "unhealthy" here rewrites code that was never broken, which is
 * exactly what happened when the old version sampled preview health at a fixed
 * 600ms while a 199-file Vite rebuild was still in flight.
 */
import { describe, expect, it } from 'vitest';
import { awaitPreviewSettled, type PreviewStatus } from '../previewSettle.js';

const healthy: PreviewStatus = { healthy: true, errors: [] };
const broken = (...errors: string[]): PreviewStatus => ({ healthy: false, errors, diagnosticKind: 'build' });

/** Returns each scripted status in turn, repeating the last one forever. */
function scripted(...statuses: PreviewStatus[]) {
  let i = 0;
  return async () => statuses[Math.min(i++, statuses.length - 1)];
}

const fast = { sleep: async () => {}, intervalMs: 10, budgetMs: 1000 };

describe('awaitPreviewSettled', () => {
  it('accepts a healthy preview on the first read without waiting', async () => {
    const r = await awaitPreviewSettled(scripted(healthy), fast);
    expect(r.healthy).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.reads).toBe(1);
  });

  it('does NOT call a mid-rebuild blip a failure', async () => {
    // The regression: transient error, then the rebuild finishes and it is fine.
    const r = await awaitPreviewSettled(scripted(broken('transient'), healthy), fast);
    expect(r.healthy).toBe(true);
    expect(r.settled).toBe(true);
  });

  it('waits through several transient errors before the preview comes good', async () => {
    const r = await awaitPreviewSettled(
      scripted(broken('a'), broken('b'), broken('c'), healthy),
      fast,
    );
    expect(r.healthy).toBe(true);
    expect(r.reads).toBe(4);
  });

  it('reports a real failure once the same error persists', async () => {
    const r = await awaitPreviewSettled(scripted(broken('Cannot find module X')), fast);
    expect(r.healthy).toBe(false);
    expect(r.settled).toBe(true);   // settled => the caller may act on it
    expect(r.errors).toEqual(['Cannot find module X']);
  });

  it('treats the same errors in a different order as the same failure', async () => {
    const r = await awaitPreviewSettled(scripted(broken('x', 'y'), broken('y', 'x')), fast);
    expect(r.healthy).toBe(false);
    expect(r.settled).toBe(true);
  });

  it('returns unsettled, NOT a failure, when errors keep changing until the budget ends', async () => {
    let n = 0;
    const churning = async () => broken(`different-${n++}`);
    const r = await awaitPreviewSettled(churning, fast);
    expect(r.healthy).toBe(false);
    // The critical assertion: a still-moving preview must never license repair.
    expect(r.settled).toBe(false);
  });

  it('stays within its time budget', async () => {
    let clock = 0;
    let n = 0;
    const r = await awaitPreviewSettled(async () => broken(`x-${n++}`), {
      ...fast,
      budgetMs: 500,
      intervalMs: 100,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(r.settled).toBe(false);
    expect(r.elapsedMs).toBeLessThanOrEqual(500);
  });
});
