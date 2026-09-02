/**
 * HTTP 200 from preview-service /update does not mean the files went live.
 *
 * This is a real user-visible failure, reported 2026-08-22: the agent rewrote
 * two files, preview-service found build errors and rolled the push back, and
 * the same reply contained BOTH the rollback warning and the agent announcing
 * "the problem is resolved". The run had recorded the rolled-back push as a
 * success purely because the status code was 200, so it never entered its
 * repair loop.
 *
 * The asymmetry these tests pin: a MISSING field means an older
 * preview-service and must read as landed (never fail a good push over a field
 * that was not sent), while an explicit `false`/`true` must be believed.
 */
import { describe, it, expect } from 'vitest';
import { interpretPreviewPush } from '../previewPushResult.js';

describe('interpreting a preview push response', () => {
  it('treats an explicit rollback as NOT landed', () => {
    const r = interpretPreviewPush(200, JSON.stringify({ promoted: false, rolledBack: true }));
    expect(r).toEqual({ landed: false, rolledBack: true });
  });

  it('treats promoted:false as not landed even without the rollback flag', () => {
    expect(interpretPreviewPush(200, JSON.stringify({ promoted: false })).landed).toBe(false);
  });

  it('carries a dependency install failure through, without un-landing the push', () => {
    const r = interpretPreviewPush(200, JSON.stringify({ promoted: true, rolledBack: false, deps: { extras: 1, installed: false, error: 'npm install failed for nope: E404' } }));
    expect(r.landed).toBe(true);
    expect(r.depsError).toBe('npm install failed for nope: E404');
  });

  it('treats a normal success as landed', () => {
    const r = interpretPreviewPush(200, JSON.stringify({ promoted: true, rolledBack: false }));
    expect(r).toEqual({ landed: true, rolledBack: false });
  });

  it('treats a 200 with no outcome fields as landed (older preview-service)', () => {
    // Must not fail a working push just because the deployed preview-service
    // predates these fields.
    expect(interpretPreviewPush(200, JSON.stringify({ session: 'x' })).landed).toBe(true);
  });

  it('treats an unparseable 200 body as landed', () => {
    expect(interpretPreviewPush(200, 'not json at all').landed).toBe(true);
    expect(interpretPreviewPush(200, '').landed).toBe(true);
  });

  it('never reports a non-200 as landed', () => {
    for (const status of [422, 500, 502, 401]) {
      expect(interpretPreviewPush(status, JSON.stringify({ promoted: true })).landed).toBe(false);
    }
  });
});
