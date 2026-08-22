/**
 * Suppresses process narration from the user-facing stream.
 *
 * The prompt already forbids this in every tier ("When FIXING: Zero
 * narration", "Do not narrate. Do not explain. Just fix."). It is ignored,
 * because nothing enforces it and the instruction sits inside a 54,000
 * character prompt. Reported 2026-08-22 after a run that emitted, among
 * others:
 *
 *   "I'll investigate the login process immediately."
 *   "I'll check that file now."
 *   "I'll read the complete file now."
 *   "I will now rewrite the auth-login-v2.js function."
 *   "I am continuing to address the login issue."   <- three times
 *
 * None of that is information. The user sees tool activity chips already, and
 * a final summary at the end; the announcements in between are the model
 * talking to itself in public. Worse, every step's text is concatenated into
 * ONE assistant message client-side, so a ten-step run renders as a wall of
 * "I am doing this... I am doing this...".
 *
 * WHY SENTENCE BUFFERING. Text arrives as token deltas, so a per-delta filter
 * (sanitizeUserFacingDelta) cannot see a sentence to judge it. This buffers
 * until a sentence terminator, classifies the completed sentence, then emits or
 * drops it. Streaming granularity goes from token to sentence, which is a
 * deliberate trade: slightly chunkier output, no self-narration.
 *
 * DELIBERATELY CONSERVATIVE. Dropping something the user needed is worse than
 * leaving noise, so a sentence is only suppressed when it is BOTH first-person
 * self-reference AND built on a process verb (checking, reading, tracing).
 * Anything reporting an outcome, asking a question, or describing the user's
 * app survives untouched. Exact repeats are dropped regardless -- restating the
 * same sentence is never informative.
 */

/** Collapse to a comparable form so trivial rewording still counts as a repeat. */
export function normalizeSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// First-person openers the banned pattern always starts with.
const SELF_OPENER = /^(?:ok(?:ay)?[,.\s]+|right[,.\s]+|now[,.\s]+|next[,.\s]+|first[,.\s]+|alright[,.\s]+)?(?:i'?(?:ll|m|ve)|i\s+(?:will|am|have|was)|let\s+me|let's|i\s+need\s+to|i\s+should)\b/i;

// Verbs describing the act of working rather than any result of it.
const PROCESS_VERB = /\b(?:examin|check|read|look|inspect|trac|analyz|investigat|review|search|scan|explor|continu|proceed|start|begin|go(?:ing)?\s+(?:to|ahead)|dig|pinpoint|identif|determin|verif|confirm|address|work|attempt|try|rewrit|updat|appl|deploy|stage|fix|creat|add|run)\w*/i;

// Never suppress a sentence carrying real information for the user, even when
// it is phrased in the first person.
const INFORMATIVE = /\?|\b(?:because|since|however|but|so\s+that|which\s+means|the\s+(?:cause|reason|problem|issue|error|bug)\s+(?:is|was)|turns\s+out|note\s+that|warning|cannot|can't|could\s+not|failed|unable)\b/i;

/**
 * True when a completed sentence is pure process narration.
 *
 * Requires all three: a first-person opener, a process verb, and no
 * informative content. Any one alone is not enough -- "I fixed the login
 * because the hash was null" opens first-person and uses a process verb, but
 * explains something, so it stays.
 */
export function isProcessNarration(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;
  if (INFORMATIVE.test(s)) return false;
  if (!SELF_OPENER.test(s)) return false;
  return PROCESS_VERB.test(s);
}

/** Sentence terminator followed by whitespace/end, or a hard newline. */
const SENTENCE_END = /([.!?])(\s|$)|(\n)/;

export class NarrationFilter {
  private buffer = '';
  private readonly seen = new Set<string>();
  private suppressedCount = 0;

  /** Feed one delta; returns whatever is cleared for the user (often ''). */
  push(delta: string): string {
    this.buffer += delta;
    let out = '';

    // Emit only completed sentences; the tail stays buffered until it ends.
    for (;;) {
      const m = SENTENCE_END.exec(this.buffer);
      if (!m) break;
      const cut = m.index + m[0].length;
      const sentence = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      out += this.judge(sentence);
    }
    return out;
  }

  /** Release any trailing partial sentence at end of stream. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? this.judge(rest) : '';
  }

  /** How many sentences were withheld, for observability. */
  get suppressed(): number {
    return this.suppressedCount;
  }

  private judge(sentence: string): string {
    const trimmed = sentence.trim();
    if (!trimmed) return sentence; // whitespace/newlines pass through as layout

    const key = normalizeSentence(trimmed);
    if (key && this.seen.has(key)) {
      this.suppressedCount++;
      return '';
    }
    if (isProcessNarration(trimmed)) {
      this.suppressedCount++;
      // Remembered too, so a later verbatim repeat is also caught.
      if (key) this.seen.add(key);
      return '';
    }
    if (key) this.seen.add(key);
    return sentence;
  }
}
