/**
 * delete_file tool   delete a file from the project workspace.
 * Ported from server/src/agent/.../tools/delete_file.ts (Electron removed).
 */
import fs from 'node:fs';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr, findReferencesToPath } from './types.js';

const IMAGE_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

const schema = z.object({
  path: z.string().describe('File path relative to the project root'),
  force: z.boolean().optional().describe(
    'Set true to delete anyway when other files still reference this path. Omit/false on the first ' +
    'attempt: if references exist, the file is NOT deleted and you get the list back so you can update ' +
    'or remove those references first (or confirm the delete is intentional and retry with force: true).'
  ),
});

export const deleteFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'delete_file',
  description: 'Delete a file or empty directory from the project. Blocks on the first call if other files ' +
    'still import/reference it   pass force: true to delete anyway once you\'ve confirmed that\'s intended.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Delete ${args.path}`,

  execute: async (args, ctx: AgentContext) => {
    const fullPath = safeJoin(ctx.appPath, args.path);

    if (!fs.existsSync(fullPath)) {
      return `Warning: File does not exist: ${args.path}`;
    }

    // Check for referencing files BEFORE deleting   a referenced file is not
    // actually deleted on this call unless force is set (see below); this is
    // what makes the check load-bearing instead of just an after-the-fact note.
    let references: string[] = [];
    try {
      const stat = fs.lstatSync(fullPath);
      if (!stat.isDirectory()) {
        references = findReferencesToPath(ctx.appPath, args.path);
      }
    } catch { /* best-effort   don't block the delete on a scan failure */ }

    if (references.length > 0 && !args.force) {
      return (
        `BLOCKED: "${args.path}" is still referenced by ${references.length} file(s) and was NOT deleted:\n` +
        references.map((r) => `   • ${r}`).join('\n') +
        `\n\nEither update/remove those references first and then delete, or call delete_file again with ` +
        `force: true if deleting it anyway is actually what you intend.`
      );
    }

    // ── Asset-reference-rewrite gate (root cause #2 of the asset-replacement
    // audit) ──────────────────────────────────────────────────────────────
    // force:true is the one genuinely dangerous path through the block above:
    // it lets the model punch through without actually fixing anything,
    // leaving every one of these references dangling. If
    // replace_asset_references had already rewritten them correctly, the
    // `references` scan just above would already be empty and this branch
    // would never even be reached -- the normal non-force path deletes
    // cleanly. So this only fires when the model is trying to force past
    // references that are still genuinely unresolved. Scoped to image assets
    // only (not every file force-deleted in the project) since that's the
    // exact incident class this audit covers.
    if (references.length > 0 && args.force && IMAGE_ASSET_RE.test(args.path)) {
      const checked = ctx.assetReferencesChecked?.get(args.path);
      if (!checked || !checked.fullyResolved) {
        return (
          `BLOCKED: "${args.path}" is still referenced by ${references.length} file(s) and force:true does not ` +
          `bypass this for image assets:\n` + references.map((r) => `   • ${r}`).join('\n') +
          `\n\nIf you're replacing this asset, call replace_asset_references(oldAssetPath: "${args.path}", ` +
          `newAssetPath: "<the new asset's path>") first -- it rewrites these references for you -- then this ` +
          `delete will succeed without needing force at all.`
        );
      }
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

    const xml = `<SMEsAgent-delete path="${escapeXmlAttr(args.path)}"></SMEsAgent-delete>`;
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
