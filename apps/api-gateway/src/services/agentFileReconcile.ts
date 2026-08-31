/**
 * Server-authoritative reconciliation of client-supplied files (2026-08-31
 * incident).
 *
 * The agent run receives `existingFiles` from the CLIENT request body and used
 * to trust it wholesale over the server's own state. A stale or contaminated
 * browser tab (one that still held another project's files after a bad semantic-
 * cache hit) therefore re-injected those foreign files into every run, and the
 * post-run save persisted them -- CardPro kept turning back into CQjobs no
 * matter how many times the server was cleaned, because the poison lived in the
 * client's in-memory workspace and the server deferred to it.
 *
 * The authoritative record of what belongs to a project is its HEAD revision
 * manifest. This function filters the client's file list down to paths that
 * actually exist in HEAD: unchanged and user-edited files pass through (their
 * content is kept), but a client path that HEAD has never heard of is dropped
 * as a stale/contaminated resurrection. On this platform users do not hand-edit
 * code (they only see the preview), so client files legitimately mirror HEAD --
 * a client-only path is contamination, not user work.
 *
 * Fail-open: when there is no authoritative baseline (a new/empty project, or
 * the HEAD manifest could not be fetched) the client list is trusted unchanged,
 * so a first build is never blocked and a transient DB error never wipes input.
 */
export interface ClientFile {
  path: string;
  content: string;
}

export interface ReconcileResult {
  files: ClientFile[];
  /** Client paths dropped because HEAD does not contain them (likely contamination). */
  dropped: string[];
}

export function reconcileClientFilesToHead(
  clientFiles: ClientFile[],
  headPaths: ReadonlySet<string> | null | undefined,
): ReconcileResult {
  // No authoritative baseline -> trust the client (new project, or fetch failed).
  if (!headPaths || headPaths.size === 0) {
    return { files: clientFiles, dropped: [] };
  }
  const files: ClientFile[] = [];
  const dropped: string[] = [];
  for (const f of clientFiles) {
    if (headPaths.has(f.path)) files.push(f);
    else dropped.push(f.path);
  }
  return { files, dropped };
}

/**
 * Which on-disk source files to PRUNE when re-materializing the agent-runner
 * disk from the authoritative HEAD revision (2026-08-31 incident). The disk is
 * persistent and accumulates files across runs; a past contaminated run left
 * another project's source pages (GigDetailPage.tsx, JobsPage.tsx) there, and
 * collectDiskFiles then swept them into every output. This returns disk paths
 * that HEAD does not have -- but ONLY within the narrow, safe "user source"
 * space (src/ code/style files), never node_modules, config, assets, or
 * anything outside src/. Conservative by construction: unknown = keep.
 *
 * Safety floor: if HEAD has fewer than `minHeadSourceFiles` source files, the
 * manifest is too small to trust as an authority (a partial/broken revision),
 * so prune NOTHING -- overwriting content is still safe, deleting is not.
 */
const PRUNABLE_RE = /^src\/.*\.(tsx?|jsx?|css)$/;

export function computeStalePaths(
  headPaths: ReadonlySet<string>,
  diskPaths: Iterable<string>,
  minHeadSourceFiles = 20,
): string[] {
  const headSourceCount = [...headPaths].filter((p) => PRUNABLE_RE.test(p)).length;
  if (headSourceCount < minHeadSourceFiles) return []; // untrustworthy baseline: never delete
  const stale: string[] = [];
  for (const p of diskPaths) {
    if (PRUNABLE_RE.test(p) && !headPaths.has(p)) stale.push(p);
  }
  return stale;
}
