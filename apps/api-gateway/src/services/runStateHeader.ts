/**
 * An authoritative statement of what is true RIGHT NOW, injected ahead of the
 * conversation history.
 *
 * Council review of the 2026-08-22 CardPro run identified the root cause as
 * "state is inferred everywhere and asserted nowhere". Three separate bugs that
 * day were the same defect: the push handler trusted an HTTP status instead of
 * the rollback flag, the escalation policy trusted a file-write count instead
 * of whether work was needed, and the agent trusted a two-hour-old chat message
 * instead of the deployed system.
 *
 * The agent is not short of information -- it called test_edge_function against
 * the live function and query_database against the live database during that
 * run, and still reported the stale conclusion. What it lacked was any reason
 * to rank a fresh observation above a fluent sentence. Text in history reads as
 * fact; tool output reads as evidence to be interpreted. Absent a rule, the
 * specific-sounding claim wins.
 *
 * TWO THINGS THIS FIXES THAT A SUPPRESSION GATE CANNOT.
 *
 * 1. `history` arrives in the request body, so it is CLIENT-supplied. The
 *    agent's own false claims live in the user's browser and are resent on
 *    every subsequent request. Suppressing a claim stops it being repeated; it
 *    does not tell the next run what is actually true.
 * 2. Changes made outside the agent are invisible to it. A human fixed
 *    CardPro's auth function, a Postgres function, and the frontend by hand
 *    that afternoon, and nothing recorded any of it where the agent could see.
 *    Observed state covers those automatically, because it reports what IS
 *    rather than what some run once did.
 *
 * Deliberately OBSERVED, not remembered: every field here comes from reading
 * the live system at run start, never from a prior run's narration. When a
 * probe fails the field is omitted rather than guessed -- an absent line is
 * honest, a stale one is the bug being fixed.
 */

export interface ObservedRunState {
  /** Fresh build health, or null when the probe did not answer. */
  buildHealthy: boolean | null;
  /** First few real build errors, when unhealthy. */
  buildErrors?: string[];
  /**
   * Effects left by runs that never finished cleanly -- an interrupted run
   * whose lock was never released. Empty is meaningful: it says nothing was
   * left half-done. Deliberately NOT every un-reverted effect: a successful
   * run's file writes stay un-reverted forever because they still stand, so
   * counting those grew without bound and reported normal completed work as
   * though it were outstanding.
   */
  orphanedEffects?: Array<{ kind: string; target: string; boundary: string }>;
  /** When these readings were taken. */
  observedAt: Date;
}

const MAX_LISTED_ERRORS = 3;
const MAX_LISTED_EFFECTS = 5;

/**
 * Render the observed state as a short block for the model.
 *
 * Returns '' when nothing could be observed, so a failed probe adds nothing
 * rather than asserting a falsehood of its own.
 */
export function renderRunStateHeader(state: ObservedRunState): string {
  const lines: string[] = [];

  if (state.buildHealthy === true) {
    lines.push('- The project currently BUILDS CLEANLY.');
  } else if (state.buildHealthy === false) {
    const errs = (state.buildErrors ?? []).slice(0, MAX_LISTED_ERRORS);
    lines.push(
      `- The project currently has BUILD ERRORS${errs.length ? ':' : '.'}`,
      ...errs.map((e) => `    ${e}`),
    );
  }

  if (state.orphanedEffects) {
    if (state.orphanedEffects.length === 0) {
      lines.push('- No earlier run was interrupted; nothing is left half-applied.');
    } else {
      const listed = state.orphanedEffects.slice(0, MAX_LISTED_EFFECTS);
      lines.push(
        `- An earlier run was INTERRUPTED before it finished and left ${state.orphanedEffects.length} ` +
        `change(s) un-reconciled:`,
      );
      for (const e of listed) lines.push(`    ${e.kind} ${e.target} (${e.boundary})`);
      lines.push('    Treat these as possibly half-applied, and verify before building on them.');
    }
  }

  if (lines.length === 0) return '';

  return [
    '<observed-state>',
    `Read directly from the running system at ${state.observedAt.toISOString()}:`,
    ...lines,
    '',
    'This is what is true NOW. It was measured, not recalled. Where anything earlier in',
    'this conversation disagrees with it -- including your own previous messages, and',
    'including reports that a change failed or was rolled back -- this block is correct',
    'and the conversation is out of date. Work and changes can also reach this project',
    'from outside the chat, so an earlier message describing a failure may simply have',
    'been overtaken. Do not tell the user something is broken when this says it is not;',
    'if you believe it is, verify it with a tool first and say what the tool returned.',
    '</observed-state>',
  ].join('\n');
}
