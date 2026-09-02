/**
 * Interpreting a preview-service /update response.
 *
 * The trap this exists for: HTTP 200 from /update does NOT mean the files went
 * live. When preview-service detects build errors it rolls src/ back to the
 * last stable version and still answers 200, reporting the outcome in the body
 * as `{ promoted: false, rolledBack: true }` (see pushOutcome.js and the
 * /update handler). agentLoopService only ever checked the status code, so a
 * rolled-back push was recorded as a successful one -- the run skipped its
 * repair loop and told the user the work was done while the preview had
 * discarded it. Users saw a rollback warning and a success message in the same
 * reply.
 *
 * Kept as a separate pure function, like preview-service's own
 * decidePushOutcome, so the rule can be tested without standing up the agent
 * loop -- and so the two sides of this contract are each pinned by a test
 * rather than by a status-code assumption.
 */

export interface PreviewPushResult {
  /** True only when the files are actually serving. */
  landed: boolean;
  /** True when preview-service explicitly discarded this push. */
  rolledBack: boolean;
  /** Set when the preview could not install the project's package.json extras. */
  depsError?: string;
}

export function interpretPreviewPush(status: number, body: string): PreviewPushResult {
  if (status !== 200) return { landed: false, rolledBack: false };

  let rolledBack = false;
  let depsError: string | undefined;
  let promoted = true;
  try {
    const parsed = JSON.parse(body || '{}') as { promoted?: unknown; rolledBack?: unknown; deps?: { error?: unknown } };
    depsError = typeof parsed?.deps?.error === 'string' ? parsed.deps.error : undefined;
    rolledBack = parsed?.rolledBack === true;
    // Absent means an older preview-service that predates these fields; treat
    // that as promoted so a good push is never failed over a missing field.
    promoted = parsed?.promoted !== false;
  } catch {
    // Unparseable body on a 200: assume promoted, matching the behaviour before
    // these fields existed. A parse error must not fail a working push.
    return { landed: true, rolledBack: false, depsError };
  }

  return { landed: promoted && !rolledBack, rolledBack, depsError };
}
