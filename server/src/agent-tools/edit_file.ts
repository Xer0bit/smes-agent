/**
 * edit_file / search_replace tool   apply targeted edits to an existing file.
 * Ported from server/src/agent/.../tools/search_replace.ts and edit_file.ts.
 *
 * Uses the SEARCH/REPLACE block format from the Dyad draft agent:
 *   <<<<<<< SEARCH
 *   old content
 *   =======
 *   new content
 *   >>>>>>> REPLACE
 */
import fs from 'node:fs';
import { z } from 'zod';
import ts from 'typescript';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';
import { sanitizeFileContent, checkSyntaxBalance } from './sanitize.js';

const schema = z.object({
  path: z.string().describe('File path relative to the project root'),
  diff: z
    .string()
    .describe(
      'One or more SEARCH/REPLACE blocks in the format:\n<<<<<<< SEARCH\nold content\n=======\nnew content\n>>>>>>> REPLACE'
    ),
});

/** Normalize whitespace for fuzzy matching: trim trailing ws per line, collapse blank lines */
function normalizeWs(text: string): string {
  return text.split('\n').map(l => l.trimEnd()).join('\n');
}

/** Build cumulative character-offset table for line-start positions. */
function buildOffsets(lines: string[]): number[] {
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1); // +1 for \n
  }
  return offsets;
}

/**
 * Binary search: return the largest line index whose offset <= idx.
 * Replaces the previous char-counting loop that missed when idx fell mid-line,
 * causing the wrong line to be selected as the replacement start.
 */
function offsetToLine(offsets: number[], idx: number): number {
  let lo = 0;
  let hi = offsets.length - 2; // last valid line index
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Try to find `needle` in `haystack` with progressively looser matching.
 *  Returns the ORIGINAL substring that matched (so replacement preserves formatting). */
function fuzzyFind(haystack: string, needle: string): { found: boolean; original: string } {
  // 1. Exact match
  if (haystack.includes(needle)) return { found: true, original: needle };

  // 2. Whitespace-trimmed match (trailing spaces/tabs differ)
  const normHay = normalizeWs(haystack);
  const normNeedle = normalizeWs(needle);
  const idx = normHay.indexOf(normNeedle);
  if (idx !== -1) {
    // Map normalized index back to original string using binary-search offset table
    const hayLines = haystack.split('\n');
    const normLines = normHay.split('\n');
    const needleLineCount = normNeedle.split('\n').length;
    const normOffsets = buildOffsets(normLines);
    const startLine = offsetToLine(normOffsets, idx);
    const endLine = Math.min(hayLines.length, startLine + needleLineCount);
    const originalSlice = hayLines.slice(startLine, endLine).join('\n');
    return { found: true, original: originalSlice };
  }

  // 3. Indentation-agnostic match (different indent levels)
  const stripIndent = (t: string) => t.split('\n').map(l => l.replace(/^[ \t]+/, '')).join('\n');
  const stripHay = stripIndent(haystack);
  const stripNeedle = stripIndent(needle);
  const idxStrip = stripHay.indexOf(stripNeedle);
  if (idxStrip !== -1) {
    // Map de-indented index back to original using binary-search offset table
    const hayLines = haystack.split('\n');
    const stripLines = stripHay.split('\n');
    const needleLineCount = stripNeedle.split('\n').length;
    const stripOffsets = buildOffsets(stripLines);
    const startLine = offsetToLine(stripOffsets, idxStrip);
    const endLine = Math.min(hayLines.length, startLine + needleLineCount);
    const originalSlice = hayLines.slice(startLine, endLine).join('\n');
    return { found: true, original: originalSlice };
  }

  return { found: false, original: '' };
}

function applySearchReplace(original: string, diff: string): { success: boolean; content?: string; error?: string } {
  const blockRegex =
    /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

  let result = original;
  let match: RegExpExecArray | null;
  let applied = 0;

  while ((match = blockRegex.exec(diff)) !== null) {
    const searchText = match[1];
    const replaceText = match[2];

    const { found, original: matchedOriginal } = fuzzyFind(result, searchText);
    if (!found) {
      return { success: false, error: `SEARCH block not found in file:\n${searchText.slice(0, 200)}` };
    }

    result = result.replace(matchedOriginal, replaceText);
    applied++;
  }

  if (applied === 0) {
    return { success: false, error: 'No valid SEARCH/REPLACE blocks found in diff.' };
  }

  return { success: true, content: result };
}

export const editFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'edit_file',
  description:
    'Apply targeted search-and-replace edits to an existing file without rewriting it entirely. ' +
    'ALWAYS call read_file first to see the exact current content   then copy the search text verbatim from there. ' +
    'If the SEARCH block fails to match, you will get the current file content back to help you correct it. ' +
    'If it fails twice on the same file, switch to write_file with the full corrected content instead.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Edit ${args.path}`,

  execute: async (args, ctx: AgentContext) => {
    const fullPath = safeJoin(ctx.appPath, args.path);

    let original: string;
    try {
      original = fs.readFileSync(fullPath, 'utf8');
    } catch {
      return `Error: File does not exist or is unreadable: ${args.path}. Check the file tree   use write_file (ecomgear-write) to create it first.`;
    }
    const result = applySearchReplace(original, args.diff);

    if (!result.success || result.content == null) {
      // Record the failed edit in the ledger so the journal shows ❌ at the next step
      const firstSearchLine = args.diff.match(/<<<<<<< SEARCH\n([\s\S]*?)\n=======/)?.[1] ?? '';
      ctx.ledger?.recordEditFailed(args.path, firstSearchLine, result.error ?? 'unknown error');

      // Include the first 100 lines of the current file so the agent can see
      // the exact content and correct the SEARCH text without an extra read_file call.
      const previewLines = original.split('\n').slice(0, 100).join('\n');
      const filePreview = original.split('\n').length > 100
        ? `${previewLines}\n… (${original.split('\n').length - 100} more lines   call read_file for the full content)`
        : previewLines;
      return `Error applying edit to ${args.path}: ${result.error}\n\nCurrent file content (first 100 lines):\n\`\`\`\n${filePreview}\n\`\`\`\n\nFix your SEARCH text to exactly match the content above.`;
    }

    const { content: sanitized, fixes } = sanitizeFileContent(args.path, result.content);

    // Guard: if the edit made bracket balance significantly worse, reject it.
    // This catches cases where the fuzzy match replaced the wrong block or the
    // agent provided an incomplete replacement, preventing broken files from
    // reaching disk and triggering the expensive auto-repair loop.
    if (/\.(tsx?|jsx?)$/.test(args.path)) {
      const beforeBalance = checkSyntaxBalance(original);
      const afterBalance = checkSyntaxBalance(sanitized);
      // Reject if the edit introduced ANY imbalance into a previously balanced file,
      // or significantly worsened an already-imbalanced file.
      const balanceThreshold = beforeBalance.score === 0 ? 1 : 2;
      if (afterBalance.score > beforeBalance.score && afterBalance.score >= balanceThreshold) {
        const previewLines = original.split('\n').slice(0, 100).join('\n');
        const filePreview = original.split('\n').length > 100
          ? `${previewLines}\n… (${original.split('\n').length - 100} more lines   call read_file for the full content)`
          : previewLines;
        return (
          `Error: edit_file produced unbalanced code (${afterBalance.braces} unclosed braces, ${afterBalance.parens} unclosed parens). ` +
          `The file was NOT written. Your replacement text is incomplete or matched the wrong section. ` +
          `Use \`write_file\` with the complete corrected file content instead.\n\n` +
          `Current file content (first 100 lines):\n\`\`\`\n${filePreview}\n\`\`\``
        );
      }
    }

    // Gate 2: TypeScript syntax check   catches JSX errors that bracket counting misses
    if (/\.tsx?$/.test(args.path)) {
      try {
        const isJsx = /\.tsx$/.test(args.path);
        const tsResult = ts.transpileModule(sanitized, {
          compilerOptions: {
            jsx: isJsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
          },
          reportDiagnostics: true,
          fileName: args.path,
        });
        if (tsResult.diagnostics && tsResult.diagnostics.length > 0) {
          const errors = tsResult.diagnostics
            .slice(0, 3)
            .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
            .join('; ');
          const previewLines = original.split('\n').slice(0, 100).join('\n');
          const filePreview = original.split('\n').length > 100
            ? `${previewLines}\n… (${original.split('\n').length - 100} more lines)`
            : previewLines;
          return (
            `Error: edit_file produced invalid TypeScript/JSX syntax: ${errors}. ` +
            `The file was NOT written. Use \`write_file\` with the complete corrected file.\n\n` +
            `Current file content (first 100 lines):\n\`\`\`\n${filePreview}\n\`\`\``
          );
        }
      } catch (_) {
        // transpileModule exceptions are rare   don't block writes on them
      }
    }

    // Record successful edit in ledger before writing
    const firstSearchLine = args.diff.match(/<<<<<<< SEARCH\n([\s\S]*?)\n=======/)?.[1] ?? '';
    ctx.ledger?.recordEdit(args.path, firstSearchLine);

    // Warn agent about files that import from this one (downstream regression risk)
    const importers = ctx.reverseGraph?.get(args.path);
    const depWarning = importers && importers.size > 0
      ? `⚠️  DEPENDENCY ALERT: ${importers.size} file(s) import from ${args.path}:\n` +
        Array.from(importers).map(p => `   • ${p}`).join('\n') +
        `\nIf you changed exports or props, those files may need updating too.\n\n`
      : '';

    fs.writeFileSync(fullPath, sanitized, 'utf8');
    // Emit SSE tool-output so the frontend shows an activity chip
    ctx.onXmlComplete(`<ecomgear-edit path="${args.path}"></ecomgear-edit>`);

    // Incremental live push   same as write_file, keeps preview in sync mid-run
    // Buffer for deferred preview sync   same pattern as write_file.
    if (ctx.pendingPreviewFiles) {
      ctx.pendingPreviewFiles.set(args.path, sanitized);
    }

    const fixNote = fixes.length > 0 ? `\nAuto-fixed: ${fixes.join('; ')}` : '';
    return `${depWarning}Successfully edited ${args.path}${fixNote}`;
  },
};
