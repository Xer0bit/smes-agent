/**
 * delete_file tool   delete a file from the project workspace.
 * Ported from server/src/agent/.../tools/delete_file.ts (Electron removed).
 */
import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr, findReferencesToPath } from './types.js';

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

    // Check for referencing files BEFORE deleting   not after, so the
    // warning can still be acted on if the agent decides to back out.
    let references: string[] = [];
    try {
      const stat = fs.lstatSync(fullPath);
      if (!stat.isDirectory()) {
        references = findReferencesToPath(ctx.appPath, args.path);
      }
    } catch { /* best-effort   don't block the delete on a scan failure */ }

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
    const refWarning = references.length > 0
      ? `\n\n⚠️  STILL REFERENCED: ${references.length} file(s) reference "${args.path}" and will now be broken:\n` +
        references.map((r) => `   • ${r}`).join('\n') +
        `\nUpdate or remove those references now, in this same turn   don't stop with a dangling reference. ` +
        `If the user is about to supply a replacement file, either wait to delete until you have it, or update ` +
        `the reference to point at the new file as part of this change instead of leaving it broken in between.`
      : '';
    return `Successfully deleted ${args.path}${detail}${refWarning}`;
  },
};
