import { describe, expect, it } from 'vitest';

// Mirrors the UNFULFILLED_PROMISE_RE built in agentLoopService.ts. It is
// constructed inline there (inside the run closure) so it can't be imported;
// this test pins the BEHAVIOUR so the pattern can't silently narrow again.
//
// History: the original detector used a closed 17-verb whitelist and matched
// only 13 of 197 real zero-file production run summaries (2026-08-16) -- the
// model paraphrases its promises freely ("I will take the concrete actions",
// "I will resolve this immediately", "I'll install it now"), so any fixed verb
// list loses. The current pattern matches any first-person future-tense
// commitment and excludes continuations that don't promise a file change.
const NON_ACTION_CONTINUATIONS = [
  'know', 'need', 'be', 'not', 'never', 'require', 'wait', 'leave', 'avoid', 'stop', 'assume', 'clarify', 'explain',
  'check', 'read', 'review', 'look', 'examine', 'inspect', 'see', 'find', 'search',
  'verify', 'confirm', 'list', 'show', 'walk', 'describe',
  String.raw`analyz\w*`, String.raw`analys\w*`, String.raw`summariz\w*`, String.raw`summaris\w*`,
].join('|');

const UNFULFILLED_PROMISE_RE = new RegExp(
  String.raw`\b(?:I(?:'|’)ll|I will|I(?:'|’)m going to|I am going to|let me|going to (?:go ahead and|now))\s+(?!(?:${NON_ACTION_CONTINUATIONS})\b)\w+`,
  'i',
);

describe('UNFULFILLED_PROMISE_RE', () => {
  // Verbatim phrasings taken from real production runs that wrote zero files
  // and were missed by the old verb whitelist.
  it.each([
    'I will take the concrete actions now.',
    'I will resolve this immediately.',
    'I will execute the full correction.',
    "I'll install it now.",
    "I'll replace the logo.",
    'I will begin the first phase of the overhaul.',
    "I'll correct the mismatch.",
    'I will adjust the permissions and that should resolve the error.',
    'Let me stage the corrected code for both functions now.',
    "I'll run the migration.",
  ])('flags a real unkept promise: %s', (text) => {
    expect(UNFULFILLED_PROMISE_RE.test(text)).toBe(true);
  });

  // Read-only work is legitimately finished without writing a file; firing a
  // corrective turn here would force a pointless extra step.
  it.each([
    'I will check the login page to confirm it uses your auth.',
    'I will read that file and summarize the features.',
    'Let me verify the current build status.',
    'Let me review the discounts page.',
    'I will analyze the failing request.',
    'Let me summarize what changed.',
  ])('ignores read-only intent: %s', (text) => {
    expect(UNFULFILLED_PROMISE_RE.test(text)).toBe(false);
  });

  // Handing control back to the user is a valid way to end without writing.
  it.each([
    "Let me know if you'd like any changes.",
    "I'll need the API key before I can continue.",
    'I will not change the schema without confirmation.',
    "I'll be happy to adjust the colours once you decide.",
  ])('ignores user-directed phrasing: %s', (text) => {
    expect(UNFULFILLED_PROMISE_RE.test(text)).toBe(false);
  });

  it('matches the curly apostrophe the models actually emit', () => {
    expect(UNFULFILLED_PROMISE_RE.test('I’ll rebuild the header.')).toBe(true);
  });

  it('still catches every verb the original whitelist covered', () => {
    const originals = ['build', 'implement', 'create', 'add', 'rebuild', 'update', 'change', 'fix', 'restore', 'write', 'make', 'refactor'];
    for (const verb of originals) {
      expect(UNFULFILLED_PROMISE_RE.test(`I will ${verb} the component.`)).toBe(true);
    }
  });
});
