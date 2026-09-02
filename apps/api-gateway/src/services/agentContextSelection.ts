/**
 * Which files get their bodies into the prompt, and how much of each.
 *
 * Second extraction of `_runAgentLoopInner`'s Group A (#2). This is the decision
 * that determines what the model can see without spending a tool call, and it
 * lived as an inline loop with four ambient budget constants and a
 * pick-at-least-one fallback stitched on after it.
 *
 * Worth testing on its own terms: measured live, retrieval ranks ~199 files,
 * returns its top 10, and this stage then admitted 4 of them (now 10) while
 * spending 2.9-3.7 KB of an 8 KB budget -- so the caps here, not retrieval,
 * decided what the agent knew.
 */

export interface ContextCandidate {
  path: string;
  content: string;
}

export interface CappedContextFile extends ContextCandidate {
  /** What actually goes in the prompt: full content, or a truncated peek. */
  contextContent: string;
  truncated: boolean;
}

export interface ContextBudget {
  maxFiles: number;
  maxTotalChars: number;
  maxFileChars: number;
  /** A file the user named by path earns a larger slice. */
  maxMentionedFileChars: number;
}

/**
 * A truncated file is explicitly labelled as a peek, because a partial file
 * read as whole is how the model invents implementation details it never saw.
 */
function peek(path: string, content: string, cap: number): string {
  return `${content.slice(0, cap)}\n\n/* peek only   call read_file("${path}") before editing */`;
}

function shape(file: ContextCandidate, cap: number): CappedContextFile {
  const truncated = file.content.length > cap;
  return {
    path: file.path,
    content: file.content,
    contextContent: truncated ? peek(file.path, file.content, cap) : file.content,
    truncated,
  };
}

/**
 * Fill the context budget from `sortedFiles`, which must already be in
 * relevance order.
 *
 * A file that would overflow the character budget is SKIPPED rather than
 * ending the loop, so one large low-priority file cannot shut out the smaller
 * relevant ones behind it.
 *
 * If nothing fits at all, the single most relevant file is admitted anyway:
 * sending the model a prompt with no file context on a project that has files
 * is worse than exceeding the budget once.
 */
export function capContextFiles(
  sortedFiles: readonly ContextCandidate[],
  directlyMentioned: ReadonlySet<string>,
  budget: ContextBudget,
): { files: CappedContextFile[]; totalChars: number } {
  const files: CappedContextFile[] = [];
  let totalChars = 0;

  for (const file of sortedFiles) {
    if (files.length >= budget.maxFiles) break;
    const perFileCap = directlyMentioned.has(file.path)
      ? budget.maxMentionedFileChars
      : budget.maxFileChars;
    const shaped = shape(file, perFileCap);
    const entryChars = shaped.contextContent.length + file.path.length + 10;
    if (totalChars + entryChars > budget.maxTotalChars) continue;
    files.push(shaped);
    totalChars += entryChars;
  }

  if (files.length === 0 && sortedFiles.length > 0) {
    const first = sortedFiles[0];
    const perFileCap = directlyMentioned.has(first.path)
      ? budget.maxMentionedFileChars
      : budget.maxFileChars;
    files.push(shape(first, perFileCap));
  }

  return { files, totalChars };
}

/** Rendered form: `=== path ===` then the file's admitted content. */
export function renderContextFiles(files: readonly CappedContextFile[]): string {
  return files.map((f) => `=== ${f.path} ===\n${f.contextContent}`).join('\n\n');
}

/** Relevance signals gathered before ranking; each contributes a fixed weight. */
export interface RankingSignals {
  /** Paths the user named outright. Outrank everything. */
  directlyMentioned: ReadonlySet<string>;
  /** Files a mentioned file imports. */
  relatedByImport: ReadonlySet<string>;
  /** Files that import a mentioned file. */
  importersOfMentioned: ReadonlySet<string>;
  /** Entry points and other always-relevant files. */
  criticalFiles: ReadonlySet<string>;
  /** Semantic-retrieval bonus per path, already scaled. */
  kbScores: ReadonlyMap<string, number>;
}

/**
 * Relevance weight for one path.
 *
 * The KB bonus is scaled so a strong hit (0.8 -> 64) outranks the criticalFiles
 * baseline of 60 and can therefore actually change the selection; below that it
 * only breaks ties among equals.
 */
export function scoreCandidate(path: string, signals: RankingSignals): number {
  const base =
    signals.directlyMentioned.has(path) ? 100
    : signals.relatedByImport.has(path) ? 80
    : signals.importersOfMentioned.has(path) ? 70
    : signals.criticalFiles.has(path) ? 60
    : path.startsWith('src/pages/') ? 40
    : path.startsWith('src/components/') && !path.includes('/ui/') ? 30
    : 0;
  return base + (signals.kbScores.get(path) ?? 0);
}

/**
 * Order candidates by relevance, shorter files first on a tie.
 *
 * The tie-break matters: with a fixed character budget, preferring the smaller
 * of two equally-relevant files fits more distinct files into the prompt.
 *
 * Previously an inline comparator that computed the same six-branch ladder twice
 * per comparison, once for each side -- two copies that had to stay identical by
 * hand.
 */
export function rankContextCandidates<T extends ContextCandidate>(
  files: readonly T[],
  signals: RankingSignals,
): T[] {
  return files.slice().sort((a, b) => {
    const diff = scoreCandidate(b.path, signals) - scoreCandidate(a.path, signals);
    if (diff !== 0) return diff;
    return a.content.length - b.content.length;
  });
}
