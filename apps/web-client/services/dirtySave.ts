import type { WorkspaceFile } from '@/eCG/Workspace/types';

/**
 * M1 (agent-v2-architecture.md): decide what a client save actually sends.
 *
 * A save used to serialize the tab's ENTIRE workspace map -- ~190 files of
 * whatever age that tab happened to hold -- so any trigger republished a full
 * stale snapshot as the newest revision. A save now uploads only the files
 * the user actually edited in this tab (isDirty), and every other current
 * path is carried by manifest reference from the head revision, so its
 * content comes from the head, not from this tab's possibly-stale memory.
 *
 * Deletions need no explicit representation: a deleted file is neither in
 * `files` nor in `carryPaths`, so it drops out of the new manifest.
 */
export function selectDirtySave(
  workspaceFiles: WorkspaceFile[],
  pendingLazyPaths?: Set<string>,
): {
  dirtyFiles: Array<{ path: string; content: string }>;
  carryPaths: Set<string>;
} {
  const dirtyFiles: Array<{ path: string; content: string }> = [];
  const carryPaths = new Set<string>(pendingLazyPaths ?? []);

  for (const f of workspaceFiles) {
    if (f.isDirty) {
      dirtyFiles.push({ path: f.path, content: f.content });
      carryPaths.delete(f.path); // provided content wins over a carry
    } else {
      carryPaths.add(f.path);
    }
  }

  return { dirtyFiles, carryPaths };
}
