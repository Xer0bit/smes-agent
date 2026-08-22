/**
 * Narration suppression.
 *
 * The suppressed cases are taken verbatim from the run reported on
 * 2026-08-22. The KEPT cases matter more: this filter sits on the only channel
 * the agent has to talk to the user, so a false positive silently swallows
 * something they needed. Every "keeps" test below is a thing that must survive.
 */
import { describe, it, expect } from 'vitest';
import { NarrationFilter, isProcessNarration, normalizeSentence } from '../narrationFilter.js';

/** Feed a whole string through as one delta and collect the output. */
function run(text: string): string {
  const f = new NarrationFilter();
  return f.push(text) + f.flush();
}

describe('classifying a sentence', () => {
  const suppressed = [
    "I'll investigate the login process immediately.",
    "I'll check that file now.",
    "I'll read the complete file now.",
    "I will now rewrite the auth-login-v2.js function.",
    "I am continuing to address the login issue.",
    "I've staged the fix for the login function.",
    "Let me read the necessary file.",
    "Now I'll deploy it.",
  ];
  for (const s of suppressed) {
    it(`suppresses: ${s}`, () => expect(isProcessNarration(s)).toBe(true));
  }

  const kept = [
    // Explains something -- the reason the INFORMATIVE guard exists.
    "I fixed the login because the password hash was null.",
    // A question must always reach the user.
    "Should I reset the password for that account?",
    // Reports a real outcome.
    "The database function was raising invalid_credentials for every request.",
    // Bad news must never be swallowed.
    "I could not deploy the function.",
    "This failed because the table does not exist.",
    // Not first-person at all.
    "The preview is healthy again.",
    // First-person but carries the finding.
    "I found the cause: the wrapper was treated as the row.",
    // These two reach PAST the opener check on purpose. Everything above is
    // rejected by SELF_OPENER before the other guards run, so without these the
    // INFORMATIVE and PROCESS_VERB guards are never exercised and could be
    // deleted with all tests still green (verified by mutation).
    //
    // Opener + process verb, saved ONLY by INFORMATIVE:
    "I've deployed the fix because the old function accepted any password.",
    // Opener, no process verb: must not be suppressed on the opener alone.
    "I have two options for you.",
  ];
  for (const s of kept) {
    it(`keeps: ${s}`, () => expect(isProcessNarration(s)).toBe(false));
  }
});

describe('streaming behaviour', () => {
  it('drops announcements but keeps the substance around them', () => {
    const out = run("I'll check that file now. The login function returns 200 for any password.");
    expect(out).not.toMatch(/check that file/);
    expect(out).toMatch(/returns 200 for any password/);
  });

  it('drops a repeated sentence even when it is not narration', () => {
    // "I am continuing to address the login issue" appeared three times in the
    // reported run. Restating is never informative.
    const out = run('The build is green. The build is green. The build is green.');
    expect(out.match(/The build is green/g) ?? []).toHaveLength(1);
  });

  it('buffers across deltas so a sentence split mid-token is still judged', () => {
    // Token streaming means a sentence arrives in fragments; judging per delta
    // is exactly why the old per-delta sanitizer could not catch this.
    const f = new NarrationFilter();
    let out = '';
    for (const piece of ["I'll ", 'check ', 'that ', 'file ', 'now', '. ', 'Done']) out += f.push(piece);
    out += f.flush();
    expect(out).not.toMatch(/check that file/);
    expect(out).toMatch(/Done/);
  });

  it('never withholds a trailing sentence that has no terminator', () => {
    // A final answer that does not end in punctuation must still be delivered.
    const f = new NarrationFilter();
    const streamed = f.push('The password has been reset to a new value');
    const flushed = f.flush();
    expect(streamed + flushed).toMatch(/password has been reset/);
  });

  it('counts what it withheld', () => {
    const f = new NarrationFilter();
    f.push("I'll check that now. I'll read it now. Real content here.");
    f.flush();
    expect(f.suppressed).toBe(2);
  });

  it('passes ordinary prose through untouched', () => {
    const prose = 'The login now works. Use admin@cardpro.club to sign in.';
    expect(run(prose)).toBe(prose);
  });
});

describe('normalisation', () => {
  it('treats punctuation and spacing differences as the same sentence', () => {
    expect(normalizeSentence('The  build is GREEN!')).toBe(normalizeSentence('the build is green.'));
  });
});
