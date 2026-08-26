/**
 * Deciding what a secrets-sync response means.
 *
 * Extracted so the retry rule is testable, for the same reason
 * previewPushResult/pushOutcome were: the route that uses it is not importable,
 * and a retry rule that silently classifies wrongly is invisible until it costs
 * a run.
 *
 * The rule that matters: retry only what a retry can fix. On 2026-08-24 a
 * PREVIEW_UPDATE_SECRET mismatch made preview-service answer 401 to every push
 * for 18 hours across 5 projects. The FILE push retries on any non-200/422, so
 * it re-sent an unauthorised request three times at 120s each, ran the agent
 * into AGENT_TIMEOUT_MS, and the timeout salvage then reverted the run's work.
 * Blind retry turned a config fault into lost work. A 4xx is a definitive
 * answer about the request itself; repeating it verbatim cannot change it.
 */

/**
 * Transport failure (status 0 -- no HTTP response at all) or a server-side
 * error. These are the only shapes where the same request may succeed later.
 *
 * 408 and 429 are included deliberately: both are 4xx but both explicitly mean
 * "try this again", unlike the rest of the class.
 */
export function isRetryableSyncStatus(status: number): boolean {
  if (status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * preview-service answers `{ success, secretsWritten, restarted }`. It has
 * always reported the count and nothing has ever read it, so a call that
 * returned 200 while writing fewer keys than were sent looked identical to a
 * complete one. The .env.local write is a full replace rather than a merge, so
 * a short write does not just omit keys -- it removes the ones already there.
 *
 * Returns null when the body carries no usable count, so a caller can tell
 * "not reported" apart from "reported zero".
 */
export function readSecretsWrittenCount(body: string): number | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'secretsWritten' in parsed) {
      const n = (parsed as { secretsWritten: unknown }).secretsWritten;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
  } catch {
    // Not JSON -- an nginx error page, a proxy timeout body, an empty string.
  }
  return null;
}
