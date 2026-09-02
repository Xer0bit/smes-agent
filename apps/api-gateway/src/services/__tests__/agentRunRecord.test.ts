/**
 * The heartbeat decides whether a run is declared dead. Wrong in one direction
 * a row is stranded 'running' forever (84 of 477 traced runs did exactly that);
 * wrong in the other a healthy run is failed out from under a working agent.
 */
import { describe, expect, it } from 'vitest';
import { RUN_HEARTBEAT_MS, selectStaleByHeartbeat, workerId } from '../agentRunRecord.js';

const NOW = 1_800_000_000_000;
const beatAgo = (ms: number) => new Date(NOW - ms).toISOString();

describe('selectStaleByHeartbeat', () => {
  it('leaves a run alone while it is beating', () => {
    const rows = [{ id: 'live', heartbeat_at: beatAgo(RUN_HEARTBEAT_MS) }];
    expect(selectStaleByHeartbeat(rows, NOW)).toEqual([]);
  });

  it('tolerates several missed beats before declaring death', () => {
    // A run mid-publish can legitimately miss a few: the push measured 104-139s.
    const rows = [{ id: 'busy', heartbeat_at: beatAgo(RUN_HEARTBEAT_MS * 5) }];
    expect(selectStaleByHeartbeat(rows, NOW)).toEqual([]);
  });

  it('selects a run whose heartbeat has clearly lapsed', () => {
    const rows = [{ id: 'dead', heartbeat_at: beatAgo(RUN_HEARTBEAT_MS * 10) }];
    expect(selectStaleByHeartbeat(rows, NOW).map((r) => r.id)).toEqual(['dead']);
  });

  it('never sweeps a row with no heartbeat at all', () => {
    // Pre-migration rows, and rows whose claim never landed. Absence of a beat
    // is not evidence of death -- the lock-based sweep still covers those.
    const rows = [
      { id: 'legacy', heartbeat_at: null },
      { id: 'unclaimed' },
    ];
    expect(selectStaleByHeartbeat(rows, NOW)).toEqual([]);
  });

  it('ignores an unparseable heartbeat rather than guessing', () => {
    const rows = [{ id: 'garbage', heartbeat_at: 'not-a-date' }];
    expect(selectStaleByHeartbeat(rows, NOW)).toEqual([]);
  });

  it('judges each row independently', () => {
    const rows = [
      { id: 'live', heartbeat_at: beatAgo(1_000) },
      { id: 'dead', heartbeat_at: beatAgo(RUN_HEARTBEAT_MS * 20) },
    ];
    expect(selectStaleByHeartbeat(rows, NOW).map((r) => r.id)).toEqual(['dead']);
  });

  it('honours a caller-supplied tolerance', () => {
    const rows = [{ id: 'x', heartbeat_at: beatAgo(RUN_HEARTBEAT_MS * 3) }];
    expect(selectStaleByHeartbeat(rows, NOW, 6)).toEqual([]);
    expect(selectStaleByHeartbeat(rows, NOW, 2).map((r) => r.id)).toEqual(['x']);
  });
});

describe('workerId', () => {
  it('carries both pid and host, since pids repeat across machines', () => {
    expect(workerId()).toMatch(/^pid:\d+@/);
  });
});
