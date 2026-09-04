/**
 * read_file tool   read a file from the project workspace.
 * Ported from server/src/agent/.../tools/read_file.ts (Electron removed).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext, readProjectFile, escapeXmlAttr } from './types.js';
import { extractSymbols } from '../knowledgebase/symbolGraph.js';

const schema = z
  .object({
    path: z.string().describe('File path relative to the project root'),
    start_line_one_indexed: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-indexed start line (inclusive)'),
    end_line_one_indexed_inclusive: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-indexed end line (inclusive)'),
    full: z
      .boolean()
      .optional()
      .describe('Set true to force the COMPLETE file when a large file would otherwise return the truncated outline view. Use only when you genuinely need the whole file, not to locate something in it.'),
  })
  .refine(
    (d) => {
      if (d.start_line_one_indexed != null && d.end_line_one_indexed_inclusive != null) {
        return d.start_line_one_indexed <= d.end_line_one_indexed_inclusive;
      }
      return true;
    },
    { message: 'start_line_one_indexed must be <= end_line_one_indexed_inclusive' }
  );

export const readFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'read_file',
  description:
    'Read the content of a file from the project. You can call multiple tools in a single response   speculatively read multiple files as a batch when they are likely useful.',
  inputSchema: schema,
  getConsentPreview: (args) => `Read ${args.path}`,

  execute: async (args, ctx: AgentContext) => {
    const fileResult = readProjectFile(ctx, args.path);
    if ('error' in fileResult) {
      return `Error: ${fileResult.error}`;
    }

    const { content } = fileResult;
    if (!content) return '';

    const start = args.start_line_one_indexed;
    const end = args.end_line_one_indexed_inclusive;

    if (start == null && end == null) {
      // ── Truncated-view-first for large files (2026-08-10) ────────────────
      // Measured across 1,238 real runs: the agent locates code by reading
      // whole files (~4,000 whole-file reads vs ~430 searches of any kind;
      // find_symbol_usages never called once), and every full body rides
      // billed context on subsequent steps. For LARGE files on the small
      // tiers, the default response is now the head + a symbol outline with
      // explicit cheap next steps; `full: true` is the escape hatch when the
      // whole file is genuinely needed -- the model decides, nothing is
      // blocked, no paid output is ever bounced. Kill switch:
      // READ_TRUNCATION_DISABLED=true.
      const TRUNC_TIERS = new Set(['edit', 'fix']);
      const TRUNC_MIN_LINES = 300;
      const TRUNC_HEAD_LINES = 80;
      if (
        !args.full &&
        process.env.READ_TRUNCATION_DISABLED !== 'true' &&
        ctx.tier != null && TRUNC_TIERS.has(ctx.tier) &&
        !ctx.readFiles?.has(args.path) &&
        /\.(tsx?|jsx?|css|html|json|md)$/i.test(args.path)
      ) {
        const allLines = content.split('\n');
        if (allLines.length >= TRUNC_MIN_LINES) {
          let outline = '';
          try {
            const symbols = extractSymbols(content);
            if (symbols.length > 0) {
              outline =
                '\n--- SYMBOL OUTLINE (name @ line) ---\n' +
                symbols.map((s: any) => `  ${s.kind ?? 'symbol'} ${s.name} @ line ${s.line ?? '?'}`).join('\n');
            }
          } catch { /* outline is best-effort */ }
          const head = allLines.slice(0, TRUNC_HEAD_LINES).join('\n');
          return (
            `[TRUNCATED VIEW] ${args.path} is ${allLines.length} lines; showing lines 1-${TRUNC_HEAD_LINES} + outline.\n` +
            `To work efficiently: grep("<pattern>") for exact text, search_codebase("<what it does, in plain words>") ` +
            `to find code by MEANING (returns the file plus the matching lines), or find_symbol_usages for a symbol -- ` +
            `then read_file with start_line/end_line for just that region. Call read_file({path, full: true}) ONLY if you ` +
            `genuinely need the entire file.\n\n${head}\n${outline}`
          );
        }
      }
      return content;
    }

    const hasTrailingNewline = content.endsWith('\n');
    const lines = (hasTrailingNewline ? content.slice(0, -1) : content).split('\n');
    const totalLines = lines.length;
    const startIdx = Math.max(0, (start ?? 1) - 1);
    const endIdx = Math.min(totalLines, end ?? totalLines);
    const result = lines.slice(startIdx, endIdx).join('\n');
    const text = endIdx >= totalLines && hasTrailingNewline ? result + '\n' : result;
    // Notify agent if requested range exceeded actual file length
    if ((start != null && start > totalLines) || (end != null && end > totalLines)) {
      return `Note: file has only ${totalLines} line(s); showing lines ${startIdx + 1}–${endIdx}.\n${text}`;
    }
    return text;
  },
};
