/**
 * The invoke body envelope.
 *
 * Documented shape is {"params": {...}}. Generated frontends have shipped
 * POSTing the payload FLAT instead -- {"action":"fetchCards"} rather than
 * {"params":{"action":"fetchCards"}}. That reached the function as params={},
 * so a router answered "Unknown action: undefined", the runner wrapped it as
 * HTTP 200 {result:{error:...}}, the frontend's top-level `error` check passed,
 * and it then called .map() on the error object. Verified live on CardPro
 * (2026-08-22) before the fallback below existed.
 *
 * This pins the resolution rule so the fallback cannot regress into shadowing a
 * correct caller.
 */
import { describe, it, expect } from 'vitest';
// Imported, never re-implemented: server.js calls this exact function, so the
// test cannot keep passing while the server drifts away from the rule.
// (server.js itself can't be imported here -- it opens a port on load.)
import { resolveInvokeParams as resolveParams } from '../invokeParams.js';

describe('invoke body envelope resolution', () => {
  it('uses params when the caller sends the documented envelope', () => {
    expect(resolveParams({ params: { action: 'login', email: 'a@b.c' } }))
      .toEqual({ action: 'login', email: 'a@b.c' });
  });

  it('does not let the fallback shadow a correct caller', () => {
    // The documented envelope wins even when sibling keys exist alongside it.
    expect(resolveParams({ params: { action: 'real' }, action: 'decoy' }))
      .toEqual({ action: 'real' });
  });

  it('accepts a flat body -- the CardPro shape that used to yield {}', () => {
    expect(resolveParams({ action: 'fetchCards', payload: {} }))
      .toEqual({ action: 'fetchCards', payload: {} });
  });

  it('still yields an empty object for a missing body', () => {
    expect(resolveParams(undefined)).toEqual({});
    expect(resolveParams(null)).toEqual({});
  });

  it('an explicitly empty documented envelope stays empty', () => {
    // {"params":{}} must NOT fall through to the whole body.
    expect(resolveParams({ params: {} })).toEqual({});
  });

  it('does not treat an array body as a params object', () => {
    expect(resolveParams([1, 2, 3])).toEqual({});
  });
});
