/**
 * Rendering observed state.
 *
 * The one rule that must never break: an unmeasured field is OMITTED, never
 * guessed. This block exists because the agent believed a stale sentence over a
 * live tool result; a header that asserts something it did not actually measure
 * would be the same bug wearing the fix's clothes.
 */
import { describe, it, expect } from 'vitest';
import { renderRunStateHeader, type ObservedRunState } from '../runStateHeader.js';

const at = new Date('2026-08-23T09:00:00.000Z');
const base = (over: Partial<ObservedRunState> = {}): ObservedRunState =>
  ({ buildHealthy: null, observedAt: at, ...over });

describe('rendering observed state', () => {
  it('states a healthy build plainly', () => {
    const out = renderRunStateHeader(base({ buildHealthy: true }));
    expect(out).toMatch(/BUILDS CLEANLY/);
    expect(out).toMatch(/2026-08-23T09:00:00.000Z/);
  });

  it('lists real build errors when unhealthy', () => {
    const out = renderRunStateHeader(base({
      buildHealthy: false,
      buildErrors: ['src/App.tsx:3:1 missing import', 'src/x.ts:9 type error'],
    }));
    expect(out).toMatch(/BUILD ERRORS/);
    expect(out).toMatch(/missing import/);
  });

  it('says so explicitly when no earlier run left anything behind', () => {
    // Silence would be ambiguous; the agent needs to be able to tell
    // "nothing outstanding" from "not measured".
    const out = renderRunStateHeader(base({ buildHealthy: true, standingEffects: [] }));
    expect(out).toMatch(/No earlier run left any un-reverted changes/);
  });

  it('lists effects still in place', () => {
    const out = renderRunStateHeader(base({
      buildHealthy: true,
      standingEffects: [{ kind: 'file_write', target: 'src/App.tsx', boundary: 'compensable' }],
    }));
    expect(out).toMatch(/still in place/);
    expect(out).toMatch(/file_write src\/App\.tsx/);
  });

  it('tells the model this outranks the conversation', () => {
    // The whole point: history is client-supplied and can carry the agent's own
    // stale claims forward forever.
    const out = renderRunStateHeader(base({ buildHealthy: true }));
    expect(out).toMatch(/out of date/i);
    expect(out).toMatch(/rolled back/i);
  });

  it('mentions that changes can arrive from outside the chat', () => {
    // Covers the drift case: a human fixing things by hand.
    expect(renderRunStateHeader(base({ buildHealthy: true }))).toMatch(/from\s+outside the chat/i);
  });

  it('renders NOTHING when nothing could be observed', () => {
    // A failed probe must add no claims at all.
    expect(renderRunStateHeader(base())).toBe('');
  });

  it('omits the build line entirely when health is unknown', () => {
    const out = renderRunStateHeader(base({ standingEffects: [] }));
    expect(out).not.toMatch(/BUILDS CLEANLY|BUILD ERRORS/);
    expect(out).toMatch(/No earlier run left/);
  });
});
