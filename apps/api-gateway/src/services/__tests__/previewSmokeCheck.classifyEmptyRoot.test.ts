/**
 * Guards the empty-#root decision that stopped the agent re-breaking its own
 * fixes. A bare empty mount with a CLEAN console is a preview-rebuild/render
 * race, not a crash, and must be skipped -- treating it as a failure triggers a
 * repair pass that re-edits a working app and undoes the landed fix (the CQ
 * jobs dashboard, reported 2026-08-31). A real crash always throws, so an empty
 * root WITH a captured console/page error is a true failure.
 */
import { describe, it, expect } from 'vitest';
import { classifyEmptyRoot } from '../previewSmokeCheck.service.js';

describe('classifyEmptyRoot', () => {
  it('empty root + clean console = skip-race (never triggers repair)', () => {
    expect(classifyEmptyRoot(0, 0)).toBe('skip-race');
    expect(classifyEmptyRoot(-1, 0)).toBe('skip-race');
  });

  it('empty root + a real console/page error = fail-empty (true crash)', () => {
    expect(classifyEmptyRoot(0, 1)).toBe('fail-empty');
    expect(classifyEmptyRoot(-1, 3)).toBe('fail-empty');
  });

  it('rendered during settle = ok, regardless of an earlier transient error', () => {
    expect(classifyEmptyRoot(2, 0)).toBe('ok');
    expect(classifyEmptyRoot(5, 2)).toBe('ok');
  });
});
