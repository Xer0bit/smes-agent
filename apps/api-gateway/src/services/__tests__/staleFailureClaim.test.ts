/**
 * Arbitrating a claimed failure against observation.
 *
 * The verbatim case, from 2026-08-22: a run investigated with live tools,
 * correctly wrote nothing, and reported that its earlier changes "were not
 * applied because of a build issue" and that "the login issue still exists".
 * Both statements were false and came from a two-hour-old rollback sitting in
 * client-supplied chat history.
 *
 * The tests that matter most are the ones asserting a claim SURVIVES. Silencing
 * a true failure report is far worse than leaving a false one, so every
 * condition that makes the harness less than certain must let the text through.
 */
import { describe, it, expect } from 'vitest';
import { arbitrateFailureClaim } from '../staleFailureClaim.js';

const REAL_CASE =
  "The last set of changes I made, which were unfortunately not applied because of a build issue, " +
  "were designed to fix the login process end to end. Since those changes didn't go through, the " +
  "login issue still exists. I can try applying the fixes again for you.";

const observedClean = { wroteNothing: true, buildHealthy: true };

describe('when the harness knows better', () => {
  it('strips the reported false claim', () => {
    const r = arbitrateFailureClaim(REAL_CASE, observedClean);
    expect(r.stripped).toBeGreaterThan(0);
    expect(r.text).not.toMatch(/not applied because of a build issue/i);
    expect(r.text).not.toMatch(/login issue still exists/i);
  });

  it('substitutes an honest statement when the false story was the whole message', () => {
    const r = arbitrateFailureClaim(
      "The changes were not applied because of a build issue. The problem still exists.",
      observedClean,
    );
    expect(r.text).toMatch(/checked the current state/i);
    expect(r.text).not.toMatch(/build issue/i);
  });

  it('keeps surrounding real content instead of blanking the reply', () => {
    const r = arbitrateFailureClaim(
      'The login function now rejects invalid credentials correctly and the account is active. ' +
      'The changes were not applied because of a build issue.',
      observedClean,
    );
    expect(r.text).toMatch(/rejects invalid credentials/);
    expect(r.text).not.toMatch(/build issue/i);
  });
});

describe('when the harness does NOT know better -- claim must survive', () => {
  it('leaves it alone when the build is actually broken', () => {
    // A real build failure reported honestly.
    const r = arbitrateFailureClaim(REAL_CASE, { wroteNothing: true, buildHealthy: false });
    expect(r.stripped).toBe(0);
    expect(r.text).toBe(REAL_CASE);
  });

  it('leaves it alone when the run DID write files', () => {
    // Then "the changes were rolled back" may be entirely true.
    const r = arbitrateFailureClaim(REAL_CASE, { wroteNothing: false, buildHealthy: true });
    expect(r.stripped).toBe(0);
    expect(r.text).toBe(REAL_CASE);
  });

  it('leaves ordinary text untouched', () => {
    const ok = 'I reset the password and verified the login works.';
    expect(arbitrateFailureClaim(ok, observedClean).text).toBe(ok);
  });

  it('does not fire on a question about failure', () => {
    const q = 'Do you want me to check whether the deploy succeeded?';
    expect(arbitrateFailureClaim(q, observedClean).stripped).toBe(0);
  });

  it('does not fire on a plan describing what could go wrong', () => {
    const plan = 'If the table is missing, the function will return an error at runtime.';
    expect(arbitrateFailureClaim(plan, observedClean).stripped).toBe(0);
  });
});
