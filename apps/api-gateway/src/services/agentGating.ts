/**
 * Real-signal gating predicates (harness redesign, increment 1).
 *
 * These three gates decide, from the ONE real build-health signal
 * (`ctx.lastBuildErrorsHealthy`, set only by get_build_errors), whether the
 * agent loop should stop sooner or speak more honestly. They live here, pure
 * and separate from the 3000-line loop, so the flag's semantics are testable
 * and a refactor of the loop cannot silently flip them (the same reason the
 * env-bootstrap ordering has its own source-level test).
 *
 * `buildHealthy` is tri-state:
 *   true      -> a real build check PASSED this run
 *   false     -> a real build check CONFIRMED the build is broken
 *   undefined -> never checked, or invalidated by a later write (the default)
 *
 * Only an explicit `false` tightens a gate. `undefined` MUST behave exactly as
 * it did before the flag existed -- the never-regress rule these gates ship
 * under: a run that never called get_build_errors sees byte-identical behavior.
 */

/** Consecutive no-tool "I'm done" steps tolerated before the phantom-narration abort. */
export function phantomAbortThresholdFor(buildHealthy: boolean | undefined): number {
  return buildHealthy === false ? 2 : 3;
}

/** True when no write has landed for `threshold` steps AND the build is confirmed broken. */
export function isStuckAndBuildKnownBroken(
  stepsSinceLastWrite: number,
  threshold: number,
  buildHealthy: boolean | undefined,
): boolean {
  return stepsSinceLastWrite >= threshold && buildHealthy === false;
}

/** Honest closing note for an unfulfilled promise, sharper when the build is known broken. */
export function unfulfilledPromiseNote(buildHealthy: boolean | undefined): string {
  return buildHealthy === false
    ? `\n\n(Note: I described a change above but haven't actually made it yet, and the last build check showed real errors. Tell me to go ahead and I'll pick this back up.)`
    : `\n\n(Note: I described a change above but haven't actually made it yet. Let me know if you'd like me to go ahead.)`;
}

// ── Diagnose-before-fix (harness redesign, increment 3) ──────────────────────

/**
 * The ONLY tools the fix/edit-tier diagnosis pass may use. It is a read-only
 * set BY CONSTRUCTION -- no write_file/edit_file/delete_file/rename_file/
 * run_command/write_edge_function. That structural absence, not the prompt, is
 * why the pass cannot mutate a project however the model behaves. The test
 * enforces it: adding any mutation tool here fails CI, not production.
 */
export const DIAGNOSIS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'read_files', 'grep', 'glob_files', 'list_files', 'get_build_errors', 'think',
]);

/** Mutation tools that must never be reachable from the diagnosis pass. */
export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'delete_file', 'rename_file', 'run_command', 'write_edge_function',
]);

interface DiagnosisStep {
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
}

/**
 * Files the diagnosis pass actually READ, taken from tool-call arguments rather
 * than parsed from the model's prose -- the same "trust the calls, not the
 * narration" lesson the rest of the loop learned the hard way.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function extractImplicatedFiles(steps: ReadonlyArray<DiagnosisStep> | undefined): Set<string> {
  const files = new Set<string>();
  for (const step of steps ?? []) {
    for (const tc of step.toolCalls ?? []) {
      const input = tc.input;
      if (!isRecord(input)) continue;
      if (tc.toolName === 'read_file' && typeof input.path === 'string') files.add(input.path);
      if (tc.toolName === 'read_files' && Array.isArray(input.paths)) {
        for (const p of input.paths) if (typeof p === 'string') files.add(p);
      }
    }
  }
  return files;
}

/**
 * Seed scope only from a USABLE diagnosis: a focused, non-empty file set (<=10,
 * so a pass that read half the project doesn't lock everything) plus a real
 * closing message. Anything else falls through to today's unscoped behavior.
 */
export function shouldSeedScope(implicatedFiles: Set<string>, diagnosisText: string | undefined): boolean {
  return implicatedFiles.size > 0 && implicatedFiles.size <= 10 && Boolean(diagnosisText?.trim());
}
