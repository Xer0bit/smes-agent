/**
 * list_files tool   list files in a directory of the project workspace.
 * Ported from server/src/agent/.../tools/list_files.ts (Electron removed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';

const schema = z.object({
  path: z.string().describe('Directory path relative to the project root (use "." for root)'),
  recursive: z.boolean().optional().describe('Whether to list files recursively'),
});

function listFilesRecursive(dir: string, base: string, results: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = path.relative(base, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      // Skip common noise dirs
      if (['node_modules', '.git', 'dist', 'build', '.dyad'].includes(entry.name)) continue;
      results.push(`${rel}/`);
      listFilesRecursive(path.join(dir, entry.name), base, results);
    } else {
      results.push(rel);
    }
  }
  return results;
}

export const listFilesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'list_files',
  description:
    'List files and directories in the project. Use "." for the root. Use recursive=true to see all files. Skips node_modules and .git.',
  inputSchema: schema,
  getConsentPreview: (args) => `List files in ${args.path}`,

  execute: async (args, ctx: AgentContext) => {
    const fullPath = safeJoin(ctx.appPath, args.path);

    if (!fs.existsSync(fullPath)) {
      return `Error: Directory does not exist: ${args.path}`;
    }

    if (args.recursive) {
      const files = listFilesRecursive(fullPath, fullPath);
      return files.length > 0 ? files.join('\n') : '(empty directory)';
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join('\n');
  },
};
