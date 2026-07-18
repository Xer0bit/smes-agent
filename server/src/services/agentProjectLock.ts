// ─── Per-project agent lock ──────────────────────────────────────────────────
// Prevents concurrent agent runs on the same project from interleaving file writes.
const projectAgentLocks = new Map<string, Promise<void>>();

export function acquireProjectLock(projectId: string): { release: () => void; ready: Promise<void> } {
  const prev = projectAgentLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  projectAgentLocks.set(projectId, prev.then(() => gate));
  return { release, ready: prev };
}

/** Removes the lock-chain entry once nothing else is queued behind it, so the
 *  Map doesn't grow unbounded across the process's lifetime. Call after
 *  releasing the lock returned by acquireProjectLock. */
export function cleanupProjectLock(projectId: string): void {
  const current = projectAgentLocks.get(projectId);
  if (current) current.then(() => {
    // If nothing else queued after us, remove the entry to avoid memory leak
    projectAgentLocks.delete(projectId);
  }).catch(() => projectAgentLocks.delete(projectId));
}
