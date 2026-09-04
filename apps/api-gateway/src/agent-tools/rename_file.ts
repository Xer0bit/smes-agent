/**
 * rename_file tool   rename or move a file within the project workspace.
 * Ported from server/src/agent/.../tools/rename_file.ts (Electron removed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr, findReferencesToPath } from './types.js';

const schema = z.object({
  from: z.string().describe('Current file path relative to the project root'),
  to: z.string().describe('New file path relative to the project root'),
});

export const renameFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'rename_file',
  description: 'Rename or move a file within the project.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Rename ${args.from} → ${args.to}`,

  execute: async (args, ctx: AgentContext) => {
    const fromPath = safeJoin(ctx.appPath, args.from);
    const toPath = safeJoin(ctx.appPath, args.to);

    if (!fs.existsSync(fromPath)) {
      return `Error: Source file does not exist: ${args.from}`;
    }

    // Check for referencing files BEFORE renaming — anything importing
    // `from './OldName'` or pointing at the old asset path breaks silently
    // once the file no longer exists there.
    let references: string[] = [];
    try {
      const stat = fs.lstatSync(fromPath);
      if (!stat.isDirectory()) {
        references = findReferencesToPath(ctx.appPath, args.from);
      }
    } catch { /* best-effort — don't block the rename on a scan failure */ }

    // Ensure target directory exists
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.renameSync(fromPath, toPath);

    const xml = `<SMEsAgent-rename from="${escapeXmlAttr(args.from)}" to="${escapeXmlAttr(args.to)}"></SMEsAgent-rename>`;
    ctx.onXmlComplete(xml);

    const refWarning = references.length > 0
      ? `\n\n⚠️  STILL REFERENCED: ${references.length} file(s) reference "${args.from}" and will now be broken:\n` +
        references.map((r) => `   • ${r}`).join('\n') +
        `\nUpdate those references to point at "${args.to}" now, in this same turn — don't leave a dangling import or asset path.`
      : '';

    return `Successfully renamed ${args.from} to ${args.to}${refWarning}`;
  },
};
