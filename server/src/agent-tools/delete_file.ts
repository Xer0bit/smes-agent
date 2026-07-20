/**
 * delete_file tool   delete a file from the project workspace.
 * Ported from server/src/agent/.../tools/delete_file.ts (Electron removed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr } from './types.js';

const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '__edge_functions__']);
const TEXT_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css', '.scss', '.html', '.json']);
const MAX_SCAN_FILES = 2000;

/**
 * Finds other project files that still reference the file being deleted  
 * either as a code import (`from './logo'`) or as an asset path string
 * (`src="/assets/logo.png"`, `url(...)`). Unlike write_file's reverseGraph
 * (which only tracks JS import statements), this also catches image/asset
 * references   the case that actually mattered here: deleting a logo image
 * left Header.tsx's <img src="..."> pointing at a file that no longer
 * existed, with nothing telling the agent (or the user) that had happened  
 * the deletion "succeeded" while silently breaking the build.
 */
function findReferences(appPath: string, deletedRelPath: string): string[] {
  const basename = path.basename(deletedRelPath);
  const needles = [basename, `/${deletedRelPath}`, deletedRelPath].filter((n, i, arr) => arr.indexOf(n) === i);
  const referencing: string[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    if (scanned >= MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) return;
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(appPath, fullPath).replace(/\\/g, '/');
      if (relPath === deletedRelPath) continue;
      scanned++;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (needles.some((n) => content.includes(n))) {
          referencing.push(relPath);
        }
      } catch { /* unreadable   skip */ }
    }
  };
  walk(appPath);
  return referencing;
}

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
        references = findReferences(ctx.appPath, args.path);
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
