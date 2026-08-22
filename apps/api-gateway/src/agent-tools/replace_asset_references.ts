/**
 * replace_asset_references   after an asset has been placed (via place_asset)
 * to REPLACE an existing one, find and rewrite every reference to the OLD
 * asset path across the project so it points at the NEW one, before the old
 * file is deleted.
 *
 * Root cause #2 of the 2026-08-06 asset-replacement audit: the model
 * previously did this via free-form edit_file calls with no dedicated scan,
 * reliably catching the obvious reference (an <img> in a header component)
 * and reliably missing the rest (CSS background-image/url(), manifest.json
 * icon entries, favicon/og:image <link>/<meta> tags in index.html). There
 * was no tool, no grep-all-reference-types step, and no verification --
 * confirmed by the audit as a genuine zero-coverage gap, not a tuning issue.
 *
 * Corrected workflow (supersedes place_asset.ts's older "delete_file FIRST"
 * instruction, which fights the two-phase-delete gate -- see that tool's
 * docstring): place_asset(new) -> replace_asset_references(old, new) ->
 * delete_file(old). By the time delete_file runs, findReferencesToPath finds
 * zero references (this tool already rewrote them), so deletion succeeds
 * cleanly without needing force:true.
 *
 * Reuses the exact scan boundaries (skip dirs, scanned extensions, file cap,
 * import-specifier resolution) already proven for delete_file's reference
 * check in types.ts, rather than a parallel implementation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeProjectFileSync } from '../services/projectFileWriter.js';
import { z } from 'zod';
import {
  ToolDefinition,
  AgentContext,
  safeJoin,
  REF_SCAN_SKIP_DIRS,
  REF_SCAN_TEXT_EXTS,
  REF_SCAN_MAX_FILES,
  IMPORT_SPECIFIER_RE,
  resolveImportSpecifier,
  escapeXmlAttr,
} from './types.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB   skip larger text files, same order of magnitude as agentLoopService's own cap

type RefType = 'img-src' | 'css-url' | 'html-link' | 'meta-content' | 'manifest-icon' | 'js-import' | 'generic-string-match';

interface FoundEntry {
  file: string;
  line: number;
  type: RefType;
  oldValue: string;
  newValue: string;
  rewritten: boolean;
  context?: string;
  reason?: string;
}

interface SkippedEntry {
  file: string;
  reason: 'unreadable' | 'too-large';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Boundary-safe: matches `needle` only when not part of a longer filename (e.g. "logo.png" must not match inside "new-logo.png" or "logo.png.bak"). */
function needleRegex(needle: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegex(needle)}(?![A-Za-z0-9._-])`, 'g');
}

function buildNeedlePairs(oldAssetPath: string, newAssetPath: string): Array<{ old: string; new: string }> {
  const oldWeb = oldAssetPath.replace(/^public\//, '');
  const newWeb = newAssetPath.replace(/^public\//, '');
  const oldBasename = path.basename(oldAssetPath);
  const newBasename = path.basename(newAssetPath);
  const raw: Array<{ old: string; new: string }> = [
    { old: oldWeb, new: newWeb },
    { old: `/${oldWeb}`, new: `/${newWeb}` },
    { old: oldAssetPath, new: newAssetPath },
    { old: oldBasename, new: newBasename },
  ];
  const seen = new Set<string>();
  return raw.filter((p) => {
    if (seen.has(p.old)) return false;
    seen.add(p.old);
    return true;
  });
}

/** Finds the first needle pair that occurs (boundary-safe) in `text`. Returns the matched old/new needle, or null. */
function findNeedleMatch(text: string, pairs: Array<{ old: string; new: string }>): { old: string; new: string } | null {
  for (const pair of pairs) {
    needleRegex(pair.old).lastIndex = 0;
    if (needleRegex(pair.old).test(text)) return pair;
  }
  return null;
}

function classifyLine(line: string, ext: string, baseName: string): RefType | null {
  if (ext === '.html' && /<link\b/i.test(line) && /\bhref=/i.test(line)) return 'html-link';
  if (ext === '.html' && /<meta\b/i.test(line) && /\bcontent=/i.test(line) && /property=["']?og:image/i.test(line)) return 'meta-content';
  if (/<img\b/i.test(line) && /\bsrc=/i.test(line)) return 'img-src';
  if (/url\(/i.test(line)) return 'css-url';
  if ((baseName === 'manifest.json' || baseName.endsWith('.webmanifest')) && /"[^"]*"/.test(line)) return 'manifest-icon';
  return null;
}

function scanAndRewrite(
  writeCtx: { appPath: string; projectId?: string; runId?: string },
  oldAssetPath: string,
  newAssetPath: string
): { found: FoundEntry[]; skipped: SkippedEntry[]; filesScanned: number } {
  const appPath = writeCtx.appPath;
  const pairs = buildNeedlePairs(oldAssetPath, newAssetPath);
  const found: FoundEntry[] = [];
  const skipped: SkippedEntry[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    if (scanned >= REF_SCAN_MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned >= REF_SCAN_MAX_FILES) return;
      if (entry.isDirectory()) {
        if (REF_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!REF_SCAN_TEXT_EXTS.has(ext)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(appPath, fullPath).replace(/\\/g, '/');
      if (relPath === oldAssetPath || relPath === newAssetPath) continue;

      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { skipped.push({ file: relPath, reason: 'unreadable' }); continue; }
      if (stat.size > MAX_FILE_SIZE) { skipped.push({ file: relPath, reason: 'too-large' }); continue; }

      scanned++;
      let content: string;
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch { skipped.push({ file: relPath, reason: 'unreadable' }); continue; }

      let fileFound: FoundEntry[] = [];
      let rewrittenContent = content;

      // ── js-import: reuse the same specifier resolution used by delete_file's scan ──
      if (/\.(tsx?|jsx?)$/.test(relPath)) {
        IMPORT_SPECIFIER_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = IMPORT_SPECIFIER_RE.exec(content)) !== null) {
          const resolved = resolveImportSpecifier(m[1], relPath);
          if (!resolved) continue;
          const oldWeb = oldAssetPath.replace(/^public\//, '');
          const matches = resolved === oldWeb || resolved.endsWith(`/${oldWeb}`) || resolved.endsWith(path.basename(oldAssetPath));
          if (matches) {
            const lineNum = content.slice(0, m.index).split('\n').length;
            const newWeb = newAssetPath.replace(/^public\//, '');
            fileFound.push({
              file: relPath, line: lineNum, type: 'js-import',
              oldValue: m[1], newValue: m[1].replace(path.basename(oldAssetPath), path.basename(newAssetPath)),
              rewritten: false,
              context: content.split('\n')[lineNum - 1]?.trim(),
              reason: matches ? undefined : undefined,
            });
            void newWeb;
          }
        }
      }

      // ── Line-based typed matchers (img-src, css-url, html-link, meta-content, manifest-icon) + generic fallback ──
      const lines = content.split('\n');
      const baseName = path.basename(relPath);
      const rewrittenLines = lines.map((line, idx) => {
        const match = findNeedleMatch(line, pairs);
        if (!match) return line;
        const type = classifyLine(line, ext, baseName) ?? 'generic-string-match';
        const newLine = line.replace(needleRegex(match.old), match.new);
        fileFound.push({
          file: relPath,
          line: idx + 1,
          type,
          oldValue: match.old,
          newValue: match.new,
          rewritten: true,
          context: line.trim(),
        });
        return newLine;
      });

      if (fileFound.length > 0) {
        found.push(...fileFound);
        const anyLineRewrite = fileFound.some((f) => f.rewritten);
        if (anyLineRewrite) {
          rewrittenContent = rewrittenLines.join('\n');
          if (rewrittenContent !== content) {
            try {
              // Single-owner write path -- see projectFileWriter.ts.
              writeProjectFileSync(writeCtx, relPath, rewrittenContent);
            } catch {
              for (const f of fileFound) { if (f.rewritten) { f.rewritten = false; f.reason = 'write failed'; } }
            }
          }
        }
      }
    }
  };
  walk(appPath);
  return { found, skipped, filesScanned: scanned };
}

const schema = z.object({
  oldAssetPath: z.string().describe(
    'Project-relative path of the asset being replaced, e.g. "public/assets/old-logo.png". Must be the exact path passed to (or that would be passed to) delete_file.',
  ),
  newAssetPath: z.string().describe(
    'Project-relative path of the new asset that just replaced it, e.g. "public/assets/logo.png" (the destName you gave place_asset, prefixed with public/assets/).',
  ),
});

export const replaceAssetReferencesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'replace_asset_references',
  description:
    'After place_asset has placed a NEW asset that REPLACES an existing one, call this to find and rewrite every ' +
    'reference to the OLD asset path (img src, CSS url(), favicon/og:image <link>/<meta> tags, manifest.json icon ' +
    'entries, JS imports) so they point at the new asset. Call this BEFORE delete_file on the old path -- delete_file ' +
    'will otherwise block on the very references this tool rewrites. Do not skip this for a "just update the header" ' +
    'request if the old asset is referenced elsewhere; the returned list tells you exactly what was found so you can ' +
    'verify nothing was missed instead of assuming it.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Rewrite references: ${args.oldAssetPath} → ${args.newAssetPath}`,

  execute: async (args, ctx: AgentContext) => {
    const oldAssetPath = args.oldAssetPath.replace(/^\/+/, '');
    const newAssetPath = args.newAssetPath.replace(/^\/+/, '');

    if (!ctx.assetReferencesChecked) ctx.assetReferencesChecked = new Map();

    if (oldAssetPath === newAssetPath) {
      ctx.assetReferencesChecked.set(oldAssetPath, { fullyResolved: true, unresolvedCount: 0 });
      return (
        `No reference rewrite needed: old and new paths are identical (${oldAssetPath}) -- this is a same-filename ` +
        `overwrite, not a rename. NOTE: this tool does not address browser-side image caching for an overwritten ` +
        `filename; that is a separate, unconfirmed concern this tool does not check or fix.`
      );
    }

    let scan: ReturnType<typeof scanAndRewrite>;
    try {
      scan = scanAndRewrite({ appPath: ctx.appPath, projectId: ctx.projectId, runId: ctx.runId }, oldAssetPath, newAssetPath);
    } catch (err: unknown) {
      return `ERROR: reference scan failed -- ${err instanceof Error ? err.message : String(err)}`;
    }

    const rewritten = scan.found.filter((f) => f.rewritten);
    const notRewritten = scan.found.filter((f) => !f.rewritten);
    ctx.assetReferencesChecked.set(oldAssetPath, {
      fullyResolved: notRewritten.length === 0,
      unresolvedCount: notRewritten.length,
    });

    // Register every file this actually rewrote with the tracked-write
    // pathway (same mechanism write_file/place_asset use), instead of
    // relying on scanAndRewrite's direct fs.writeFileSync calls to be picked
    // up only as a side effect of place_asset also running in the same turn.
    // Without this, a hypothetical run that called this tool without a
    // co-occurring tracked write left agentWroteFiles false: the reference
    // rewrites landed on disk correctly, but the end-of-turn preview-sync
    // push never ran, so none of it reached the live preview. Real files
    // (confirmed on disk by the scan itself), so -- unlike
    // provision_database.ts's non-file case -- an open/close tag here is
    // exactly the place_asset.ts/confirm_edge_function_deploy.ts fix, not a
    // bogus-file risk.
    const rewrittenFiles = [...new Set(rewritten.map((f) => f.file))];
    for (const relPath of rewrittenFiles) {
      let content = '';
      try {
        content = fs.readFileSync(safeJoin(ctx.appPath, relPath), 'utf8');
      } catch { /* full-disk-walk sync will still pick up the real content from disk */ }
      ctx.onXmlComplete?.(
        `<ecomgear-write path="${escapeXmlAttr(relPath)}" description="${escapeXmlAttr(`Updated asset reference: ${oldAssetPath} -> ${newAssetPath}`)}">${content}</ecomgear-write>`
      );
    }

    const lines: string[] = [];
    lines.push(`Scanned ${scan.filesScanned} file(s) for references to ${oldAssetPath}.`);
    if (scan.found.length === 0) {
      lines.push(`No references found to ${oldAssetPath} (besides the file itself). Nothing to rewrite.`);
    } else {
      lines.push(`Found ${scan.found.length} reference(s), rewrote ${rewritten.length}, could not rewrite ${notRewritten.length}:`);
      for (const f of scan.found) {
        lines.push(`  [${f.rewritten ? 'rewritten' : 'FAILED'}] ${f.file}:${f.line} (${f.type}) "${f.oldValue}" -> "${f.newValue}"${f.reason ? ` -- ${f.reason}` : ''}`);
      }
    }
    if (scan.skipped.length > 0) {
      lines.push(`Skipped ${scan.skipped.length} file(s) that could not be scanned (unreadable or too large) -- these were NOT checked:`);
      for (const s of scan.skipped) lines.push(`  ${s.file} (${s.reason})`);
    }
    lines.push(
      `\nCOVERAGE NOTE (read before claiming this is fully replaced): this scan covers img src, CSS url(), ` +
      `favicon/og:image <link>/<meta> tags, manifest.json/.webmanifest icon entries, and static JS/TS imports, across ` +
      `${[...REF_SCAN_TEXT_EXTS].join(', ')} files only. It does NOT cover: dynamically constructed paths built at ` +
      `runtime (e.g. a template literal with a variable filename), references inside comments or unrelated strings ` +
      `that happen to match, or anything outside the project tree (npm packages, edge functions calling an absolute ` +
      `asset URL). Do not tell the user "replaced everywhere" as a blanket claim -- report what this list actually shows.`
    );

    return lines.join('\n');
  },
};
