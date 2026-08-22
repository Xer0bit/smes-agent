/**
 * Arbitrates a claimed FAILURE against what the harness actually observed.
 *
 * The mirror of the existing resolution-claim gate. That one catches the model
 * claiming success while the build is broken. This catches the opposite, which
 * is what happened on 2026-08-22: a run investigated with live tools, correctly
 * wrote nothing, and then told the user
 *
 *   "The last set of changes I made ... were not applied because of a build
 *    issue ... Since those changes didn't go through, the login issue still
 *    exists."
 *
 * every word of which was false. The login had been fixed and verified hours
 * earlier. The claim came from an EARLIER run, two hours prior, that genuinely
 * did fail to build and get rolled back -- and that failure was still sitting
 * in the chat history the client sends up with every request.
 *
 * WHY A HARNESS GATE AND NOT A PROMPT RULE. The agent had tools that read live
 * reality (test_edge_function invokes the deployed function for real,
 * query_database runs live SQL) and it CALLED them, then reported the stale
 * conclusion anyway. Nothing in the system ranks a fresh observation above a
 * fluent sentence in history, and no instruction inside a 54,000 character
 * prompt is going to. Arbitration has to live where the facts are.
 *
 * WHY THE HISTORY CANNOT SIMPLY BE CLEANED. `history` arrives from the request
 * body, so the agent's own false claim now lives in the user's browser and is
 * resent on every subsequent request. Left alone it re-poisons every future
 * run. Suppressing the claim at the point of utterance is what stops the loop.
 *
 * DELIBERATELY NARROW. This only fires when the harness positively knows
 * better: the run changed nothing AND a real get_build_errors call reported
 * healthy. A genuine failure report, or any run where the build is broken or
 * unknown, passes through untouched -- silencing a true failure would be far
 * worse than leaving a false one.
 */

/**
 * Asserts that previous work did not land. Matches the shapes an agent reaches
 * for when explaining why it produced nothing, not general negative sentiment.
 */
const STALE_FAILURE_RE = new RegExp(
  [
    // "were not applied", "didn't go through", "weren't saved"
    String.raw`\b(?:were|was|weren't|wasn't|were\s+not|was\s+not)\s+(?:ever\s+)?(?:applied|saved|persisted|deployed|written)\b`,
    String.raw`\b(?:did\s*n['’]?t|did\s+not)\s+(?:go\s+through|apply|land|save|persist|take\s+effect)\b`,
    // "because of a build issue", "failed to build"
    String.raw`\bbecause\s+of\s+a\s+build\s+(?:issue|error|failure)\b`,
    String.raw`\bfailed\s+to\s+build\b`,
    // "the issue still exists", "the problem remains"
    String.raw`\b(?:issue|problem|bug|error)\s+(?:still\s+(?:exists|persists|remains)|remains)\b`,
    String.raw`\bstill\s+(?:broken|failing|not\s+working)\b`,
    // "changes were left out / rolled back / reverted"
    String.raw`\b(?:changes|edits|fixes)\s+(?:were\s+)?(?:left\s+out|rolled\s+back|reverted|discarded)\b`,
  ].join('|'),
  'i',
);

/** Split on sentence boundaries, keeping the terminator with its sentence. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.length > 0);
}

export interface StaleFailureArbitration {
  /** The text to actually show the user. */
  text: string;
  /** How many sentences were removed as contradicted by observation. */
  stripped: number;
}

/**
 * Remove failure claims the harness knows to be false.
 *
 * `wroteNothing` and `buildHealthy` are the observed facts. Both must hold:
 * if the run DID change something, "the changes were rolled back" may well be
 * true, and if the build is broken or was never checked, a failure report is
 * plausibly accurate and must survive.
 */
export function arbitrateFailureClaim(
  text: string,
  observed: { wroteNothing: boolean; buildHealthy: boolean },
): StaleFailureArbitration {
  if (!observed.wroteNothing || !observed.buildHealthy) return { text, stripped: 0 };
  if (!STALE_FAILURE_RE.test(text)) return { text, stripped: 0 };

  const kept: string[] = [];
  let stripped = 0;
  for (const sentence of splitSentences(text)) {
    if (STALE_FAILURE_RE.test(sentence)) { stripped++; continue; }
    kept.push(sentence);
  }
  if (stripped === 0) return { text, stripped: 0 };

  const remainder = kept.join(' ').trim();
  // Removing the claim can leave nothing meaningful, because the false story
  // often IS the whole message. Substitute what the harness actually observed
  // rather than handing back an empty reply.
  const replacement =
    'I checked the current state rather than relying on earlier messages: the project builds ' +
    'cleanly and I found nothing that needed changing. If something still looks wrong to you, ' +
    'tell me what you are seeing and I will look at that specifically.';

  return { text: remainder.length >= 40 ? remainder : replacement, stripped };
}
