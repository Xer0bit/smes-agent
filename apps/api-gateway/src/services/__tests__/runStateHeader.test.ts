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

  it('says so explicitly when nothing was left half-applied', () => {
    // Silence would be ambiguous; the agent needs to be able to tell
    // "nothing outstanding" from "not measured".
    const out = renderRunStateHeader(base({ buildHealthy: true, orphanedEffects: [] }));
    expect(out).toMatch(/No earlier run was interrupted/);
  });

  it('reports an interrupted run and warns the work may be half-applied', () => {
    const out = renderRunStateHeader(base({
      buildHealthy: true,
      orphanedEffects: [{ kind: 'file_write', target: 'src/App.tsx', boundary: 'compensable' }],
    }));
    expect(out).toMatch(/INTERRUPTED/);
    expect(out).toMatch(/file_write src\/App\.tsx/);
    expect(out).toMatch(/half-applied/);
  });

  it('does NOT describe a completed run\'s writes as outstanding', () => {
    // The bug this replaced: every file_write stays un-reverted forever
    // because successful changes still stand, so the header grew a
    // permanently-increasing "N changes still in place" count. Only
    // interrupted runs reach this field now, so an empty list is the normal
    // case even on a project with thousands of past writes.
    const out = renderRunStateHeader(base({ buildHealthy: true, orphanedEffects: [] }));
    expect(out).not.toMatch(/still in place/);
    expect(out).not.toMatch(/[0-9]+ change/);
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
    const out = renderRunStateHeader(base({ orphanedEffects: [] }));
    expect(out).not.toMatch(/BUILDS CLEANLY|BUILD ERRORS/);
    expect(out).toMatch(/No earlier run was interrupted/);
  });
});
