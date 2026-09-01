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
