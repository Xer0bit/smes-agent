/**
 * Wait for the preview to SETTLE after a push, instead of sampling it.
 *
 * The old code slept 600ms, read the preview's status, and if it was not
 * healthy declared the push failed and handed the run to the repair pipeline;
 * a second read at 1.2s total was the only tolerance. But a push kicks off an
 * asynchronous Vite rebuild whose duration scales with the payload, and the
 * payload used to be the entire project. A run that pushed 199 files was still
 * rebuilding well past 1.2s, so a perfectly good run read as broken and the
 * repair pass edited files that were never wrong. That is the "false positives
 * that re-broke landed fixes" failure, and its cause is sampling an operation
 * that has not finished.
 *
 * The distinction that matters is not healthy vs unhealthy, it is SETTLED vs
 * still-moving. An unhealthy reading only means something when the preview has
 * stopped changing: a transient mid-rebuild error and a real broken build look
 * identical in a single sample and are trivially distinguishable by whether
 * they persist. So an unhealthy verdict requires the same failure to be read
 * consecutively, and running out of budget yields `settled: false`, which
 * callers must treat as "no verdict" rather than as failure. Never trigger a
 * destructive repair on an unsettled reading.
 */

export interface PreviewStatus {
  healthy: boolean;
  errors: string[];
  diagnosticKind?: string;
}

export interface SettleResult extends PreviewStatus {
  /** False when the budget ran out before a stable reading. Not a failure verdict. */
  settled: boolean;
  reads: number;
  elapsedMs: number;
}

export interface SettleOptions {
  /** Total time to allow before giving up without a verdict. */
  budgetMs?: number;
  intervalMs?: number;
  /** Consecutive identical unhealthy reads required before calling it real. */
  stableReads?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors compared as a set: order varies between reads for the same underlying fault. */
function sameFailure(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

export async function awaitPreviewSettled(
  getStatus: () => Promise<PreviewStatus>,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const {
    budgetMs = 20_000,
    intervalMs = 750,
    stableReads = 2,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  const started = now();
  let reads = 0;
  let last: PreviewStatus | null = null;
  let repeats = 0;

  // Healthy is accepted on the first read: a preview that serves a good page is
  // not going to become broken by waiting longer, and making every run pay the
  // full stabilisation window would put this back on the critical path.
  for (;;) {
    const status = await getStatus();
    reads++;

    if (status.healthy) {
      return { ...status, settled: true, reads, elapsedMs: now() - started };
    }

    repeats = last && sameFailure(last.errors, status.errors) ? repeats + 1 : 1;
    last = status;

    if (repeats >= stableReads) {
      return { ...status, settled: true, reads, elapsedMs: now() - started };
    }

    if (now() - started + intervalMs >= budgetMs) {
      // Out of time with the reading still moving. Report what we saw but mark
      // it unsettled so no destructive action is taken on it.
      return { ...status, settled: false, reads, elapsedMs: now() - started };
    }
    await sleep(intervalMs);
  }
}
