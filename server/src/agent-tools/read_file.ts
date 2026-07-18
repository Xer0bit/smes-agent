/**
 * read_file tool — read a file from the project workspace.
 * Ported from server/src/agent/.../tools/read_file.ts (Electron removed).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext, readProjectFile, escapeXmlAttr } from './types.js';

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
    'Read the content of a file from the project. You can call multiple tools in a single response — speculatively read multiple files as a batch when they are likely useful.',
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
