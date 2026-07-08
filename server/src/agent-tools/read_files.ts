/**
 * read_files tool — read multiple files in one step.
 * Collapses N sequential read_file calls into a single step,
 * saving N-1 agent steps on multi-file exploration.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';

const schema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('Array of file paths to read (relative to project root). Max 10 per call.'),
});

export const readFilesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'read_files',
  description:
    'Read multiple files in one step. Use this instead of calling read_file repeatedly ' +
    'when you need the contents of 2+ files before editing. Returns each file\'s content ' +
    'separated by a header. All successfully read files are marked as read for the ' +
    'read-before-write guard.',
  inputSchema: schema,
  getConsentPreview: (args) => `Read ${args.paths.length} files: ${args.paths.join(', ')}`,

  execute: async (args, ctx: AgentContext) => {
    const results: string[] = [];

    for (const relPath of args.paths) {
      try {
        const fullPath = safeJoin(ctx.appPath, relPath);
        if (!fs.existsSync(fullPath)) {
          results.push(`=== ${relPath} ===\nError: File does not exist`);
          continue;
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').length;
        ctx.ledger?.recordRead(relPath, lines);
        if (ctx.readFiles) ctx.readFiles.add(relPath);
        results.push(`=== ${relPath} ===\n${content}`);
      } catch (err: unknown) {
        results.push(`=== ${relPath} ===\nError: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return results.join('\n\n');
  },
};
