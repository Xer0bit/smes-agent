/**
 * Project signature map — reconstruction #4 (context management).
 *
 * Files that don't fit the full-body context still need to be VISIBLE, or the
 * agent discovers the codebase by reading files one at a time (the "context is
 * a handful of files, then the model re-reads via tools anyway" problem: double
 * work, wrong files, wasted tokens).
 *
 * The previous cap was a flat 40 files, so on any real project everything past
 * #40 collapsed into "(and N more)" — invisible, and the only way to find
 * something there was exploratory reads. Callers pass files already sorted by
 * relevance, so the fix is to spend a CHARACTER BUDGET instead of a file count:
 * a signature line is ~60-120 chars, so a modest budget covers hundreds of
 * files. This lives in the prompt-cached dynamic context, so it is paid once
 * per run, not once per step.
 *
 * Signatures say WHAT exists, never HOW it works — the caller still instructs
 * the model to read_file before importing from or editing any of them.
 */
export interface SignatureMapResult {
  /** `path   name:kind, name:kind` per file (or just the path when no symbols). */
  lines: string[];
  included: number;
  omitted: number;
  chars: number;
}

export interface SignatureMapOptions {
  /** Character budget for the whole map. Default 20k (~5k tokens, cached per run). */
  charBudget?: number;
  /** Symbol extractor, injected so this stays pure and testable. */
  extract: (content: string) => Array<{ name: string; kind: string }>;
  /** Max symbols listed per file before eliding, keeps one huge file from eating the budget. */
  maxSymbolsPerFile?: number;
}

const CODE_FILE_RE = /\.(tsx?|jsx?)$/;

/**
 * Build the map from relevance-ordered `files`, spending at most `charBudget`.
 * Every file gets at least its path (cheap) — a path alone still tells the model
 * the file exists, which is what stops blind exploration.
 */
export function buildSignatureMap(
  files: Array<{ path: string; content: string }>,
  options: SignatureMapOptions,
): SignatureMapResult {
  const charBudget = options.charBudget ?? 20_000;
  const maxSymbols = options.maxSymbolsPerFile ?? 12;
  const lines: string[] = [];
  let chars = 0;

  for (const file of files) {
    let line = file.path;
    if (CODE_FILE_RE.test(file.path)) {
      try {
        const symbols = options.extract(file.content);
        if (symbols.length > 0) {
          const shown = symbols.slice(0, maxSymbols).map((s) => `${s.name}:${s.kind}`).join(', ');
          const more = symbols.length > maxSymbols ? `, +${symbols.length - maxSymbols} more` : '';
          line = `${file.path}   ${shown}${more}`;
        }
      } catch {
        // Unparseable file still gets its path -- existence is the point.
      }
    }
    if (chars + line.length + 1 > charBudget) break;
    lines.push(line);
    chars += line.length + 1;
  }

  return { lines, included: lines.length, omitted: files.length - lines.length, chars };
}
