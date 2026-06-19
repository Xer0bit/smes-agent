/**
 * delete_file tool — delete a file from the project workspace.
 * Ported from server/src/agent/.../tools/delete_file.ts (Electron removed).
 */
import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr } from './types.js';

const schema = z.object({
  path: z.string().describe('File path relative to the project root'),
});

export const deleteFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'delete_file',
  description: 'Delete a file or empty directory from the project.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Delete ${args.path}`,

  execute: async (args, ctx: AgentContext) => {
    const fullPath = safeJoin(ctx.appPath, args.path);

    if (!fs.existsSync(fullPath)) {
      return `Warning: File does not exist: ${args.path}`;
    }

    let deletedCount = 1;
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) {
        // Count nested files so the agent knows the scope of deletion
        const countFiles = (dir: string): number => {
          let n = 0;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) n += countFiles(`${dir}/${entry.name}`);
            else n++;
          }
          return n;
        };
        deletedCount = countFiles(fullPath);
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: Failed to delete ${args.path}: ${msg}`;
    }

    const xml = `<ecomgear-delete path="${escapeXmlAttr(args.path)}"></ecomgear-delete>`;
    ctx.onXmlComplete(xml);

    const detail = deletedCount > 1 ? ` (removed ${deletedCount} files)` : '';
    return `Successfully deleted ${args.path}${detail}`;
  },
};
