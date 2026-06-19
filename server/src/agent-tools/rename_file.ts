/**
 * rename_file tool — rename or move a file within the project workspace.
 * Ported from server/src/agent/.../tools/rename_file.ts (Electron removed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr } from './types.js';

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

    // Ensure target directory exists
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.renameSync(fromPath, toPath);

    const xml = `<ecomgear-rename from="${escapeXmlAttr(args.from)}" to="${escapeXmlAttr(args.to)}"></ecomgear-rename>`;
    ctx.onXmlComplete(xml);

    return `Successfully renamed ${args.from} to ${args.to}`;
  },
};
