/**
 * Both selectors decide whether something is dead. A false positive fails a
 * healthy run or deletes a live run's working tree, so the cases that matter
 * most here are the ones that must NOT be selected.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_LOCK_STALE_MS, isLockLive, selectAbandonedRuns } from '../agentLockState.js';
import { selectOrphanedSandboxes } from '../runSandbox.js';

const NOW = 1_800_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('isLockLive', () => {
  it('a heartbeating lock is live, a lapsed one is not', () => {
    expect(isLockLive(ago(30_000), NOW)).toBe(true);
    expect(isLockLive(ago(AGENT_LOCK_STALE_MS + 1_000), NOW)).toBe(false);
  });

  it('an unparseable timestamp reads as dead, never live-forever', () => {
    expect(isLockLive('not-a-date', NOW)).toBe(false);
  });
});

describe('selectAbandonedRuns', () => {
  const run = (id: string, project: string, ageMs: number) => ({
    id, project_id: project, started_at: ago(ageMs),
  });

  it('leaves a run alone while its lock is being heartbeated', () => {
    const runs = [run('r1', 'p1', 30 * MIN)]; // old, but alive
    const locks = [{ project_id: 'p1', acquired_at: ago(20_000) }];
    expect(selectAbandonedRuns(runs, locks, NOW, 2 * MIN)).toEqual([]);
  });

  it('selects a run whose lock is gone (the worker died)', () => {
    const runs = [run('r1', 'p1', 10 * MIN)];
    expect(selectAbandonedRuns(runs, [], NOW, 2 * MIN).map((r) => r.id)).toEqual(['r1']);
  });

  it('selects a run whose lock went stale', () => {
    const runs = [run('r1', 'p1', 10 * MIN)];
    const locks = [{ project_id: 'p1', acquired_at: ago(AGENT_LOCK_STALE_MS + MIN) }];
    expect(selectAbandonedRuns(runs, locks, NOW, 2 * MIN).map((r) => r.id)).toEqual(['r1']);
  });

  it('spares a just-started run even with no lock visible yet', () => {
    const runs = [run('r1', 'p1', 10_000)];
    expect(selectAbandonedRuns(runs, [], NOW, 2 * MIN)).toEqual([]);
  });

  it('spares a run with an unreadable start time rather than guessing', () => {
    const runs = [{ id: 'r1', project_id: 'p1', started_at: 'garbage' }];
    expect(selectAbandonedRuns(runs, [], NOW, 2 * MIN)).toEqual([]);
  });

  it('judges each project independently', () => {
    const runs = [run('alive', 'p1', 10 * MIN), run('dead', 'p2', 10 * MIN)];
    const locks = [{ project_id: 'p1', acquired_at: ago(10_000) }];
    expect(selectAbandonedRuns(runs, locks, NOW, 2 * MIN).map((r) => r.id)).toEqual(['dead']);
  });
});

describe('selectOrphanedSandboxes', () => {
  const dir = (projectId: string, runId: string, ageMs: number) => ({
    projectId, runId, sandboxPath: `/runs/${projectId}/${runId}`, mtimeMs: NOW - ageMs,
  });

  it('never deletes a sandbox belonging to a project with a live run', () => {
    const dirs = [dir('p1', 'r1', 90 * MIN)];
    expect(selectOrphanedSandboxes(dirs, new Set(['p1']), NOW, 30 * MIN)).toEqual([]);
  });

  it('never deletes a recently-written sandbox, even with no live lock', () => {
    const dirs = [dir('p1', 'r1', 5 * MIN)];
    expect(selectOrphanedSandboxes(dirs, new Set(), NOW, 30 * MIN)).toEqual([]);
  });

  it('deletes only when both conditions hold: no live lock and untouched', () => {
    const dirs = [
      dir('live', 'r1', 90 * MIN),
      dir('fresh', 'r2', 5 * MIN),
      dir('stranded', 'r3', 90 * MIN),
    ];
    const picked = selectOrphanedSandboxes(dirs, new Set(['live']), NOW, 30 * MIN);
    expect(picked.map((d) => d.runId)).toEqual(['r3']);
  });
});
