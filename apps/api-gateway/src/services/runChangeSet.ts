/**
 * What the agent actually changed this run, recorded from tool execution.
 *
 * Two things previously answered this question and both were wrong:
 *
 *  - The preview payload came from `collectDiskFiles`, a walk of the entire
 *    project directory. The run's "output" was therefore *the project*, not
 *    *the change*, so anything sitting on disk (contamination, residue from a
 *    previous run) was swept in and republished as if the agent produced it.
 *
 *  - `agent_runs.files_written` came from `filesToWrite ∪ filesEdited`, and
 *    those are populated by `parseXmlResponse` over the model's FINAL TEXT.
 *    The source says so outright: "filesEdited below are only populated from XML
 *    tags in the model's FINAL text, which is empty on an aborted run even if
 *    native write_file/edit_file tool calls already succeeded earlier in the
 *    same run." So the persisted record of what changed was derived from the
 *    model's closing narration.
 *
 * This records mutations where they actually happen -- at the tool result -- so
 * it is correct on an aborted run, cannot be inflated by a directory walk, and
 * cannot be invented by a sentence.
 *
 * It is deliberately NOT a replacement for `diffFilesAgainstHead`. That diffs
 * the produced tree against HEAD and is a *reconstruction*; this is a *record*.
 * Keeping both is the point: when they disagree, something touched the disk that
 * was not a tool call, which is the contamination signal nothing currently has.
 */

export type ChangeKind = 'written' | 'edited' | 'deleted' | 'renamed';

export interface ChangeSetSummary {
  written: string[];
  edited: string[];
  deleted: string[];
  renamed: string[];
  /** Distinct paths touched by any successful mutation. */
  touched: string[];
}

/** Tool name -> the kind of change a successful call represents. */
const TOOL_KINDS: ReadonlyMap<string, ChangeKind> = new Map([
  ['write_file', 'written'],
  ['place_asset', 'written'],
  ['edit_file', 'edited'],
  ['delete_file', 'deleted'],
  ['rename_file', 'renamed'],
]);

export class RunChangeSet {
  private readonly byKind = new Map<ChangeKind, Set<string>>();

  /**
   * Record one SUCCESSFUL mutation.
   *
   * Callers must apply the loop's existing success predicate before calling --
   * there must be exactly one definition of "did a write happen", and it already
   * lives in agentLoopService (`hadSuccessfulWriteThisStep`). Two definitions is
   * how the 2026-07-21 stuck-counter bug survived three investigations.
   */
  record(tool: string, path: string): void {
    const kind = TOOL_KINDS.get(tool);
    if (!kind || !path) return;
    if (!this.byKind.has(kind)) this.byKind.set(kind, new Set());
    this.byKind.get(kind)!.add(path);
  }

  private of(kind: ChangeKind): string[] {
    return [...(this.byKind.get(kind) ?? [])];
  }

  /** Distinct paths touched by any mutation -- the honest `files_written`. */
  get touchedCount(): number {
    const all = new Set<string>();
    for (const set of this.byKind.values()) for (const p of set) all.add(p);
    return all.size;
  }

  get isEmpty(): boolean {
    return this.touchedCount === 0;
  }

  summary(): ChangeSetSummary {
    const all = new Set<string>();
    for (const set of this.byKind.values()) for (const p of set) all.add(p);
    return {
      written: this.of('written'),
      edited: this.of('edited'),
      deleted: this.of('deleted'),
      renamed: this.of('renamed'),
      touched: [...all],
    };
  }
}

/** True when a tool name represents a file mutation this set tracks. */
export function isTrackedMutation(tool: string | undefined): boolean {
  return tool !== undefined && TOOL_KINDS.has(tool);
}
