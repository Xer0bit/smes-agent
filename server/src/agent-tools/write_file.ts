/**
 * write_file tool   create or overwrite a file in the project workspace.
 * Ported from server/src/agent/.../tools/write_file.ts (Electron removed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import ts from 'typescript';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr } from './types.js';
import { sanitizeFileContent, checkSyntaxBalance } from './sanitize.js';

// Paths that are pre-seeded by the base template   re-writing them wastes a step.
// These are always correct in a fresh project; skip silently if already on disk.
const PRE_BUILT_SCAFFOLD_PATHS = new Set([
  'src/lib/utils.ts',
  'src/main.tsx',
  'src/index.css',
  'src/components/ui/button.tsx',
  'src/components/ui/card.tsx',
  'src/components/ui/input.tsx',
  'src/components/ui/label.tsx',
  'src/components/ui/badge.tsx',
  'src/components/ui/textarea.tsx',
  'src/components/ui/separator.tsx',
  'src/components/ui/avatar.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/ui/select.tsx',
  'src/components/ui/tabs.tsx',
  'src/components/ui/table.tsx',
]);

/** Extract the first default or named export identifier for ledger labelling. */
function extractTopExports(content: string): string {
  const defaultMatch = content.match(/export\s+default\s+(?:function\s+|class\s+)?(\w+)/);
  if (defaultMatch) return `${defaultMatch[1]} (default)`;
  const namedMatches = [...content.matchAll(/export\s+(?:function|class|const|let|var)\s+(\w+)/g)].map(m => m[1]);
  return namedMatches.slice(0, 3).join(', ');
}

const schema = z.object({
  path: z.string().describe('File path relative to the project root'),
  content: z.string().describe('File content to write'),
  description: z.string().optional().describe('Brief description of the change'),
});

export const writeFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'write_file',
  description:
    'Create a NEW file or COMPLETELY rebuild an existing file from scratch. ' +
    '**EXISTING FILES: use edit_file instead.** Only call write_file on an existing file when you are ' +
    'rebuilding its entire structure   not when adding a feature, fixing a bug, or changing a few lines. ' +
    'For any targeted change to an existing file, use edit_file with SEARCH/REPLACE blocks   it touches ' +
    'only what needs to change and cannot accidentally delete unread code. ' +
    'The content must be ONLY valid source code   never include chat text, markdown, or XML tags inside.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Write to ${args.path}`,

  execute: async (args, ctx: AgentContext) => {
    // ── Sandbox: block writes to directories that must never be touched by the agent ──
    const normalizedPath = args.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const topSegment = normalizedPath.split('/')[0];
    const BLOCKED_DIRS = ['node_modules', '.git', 'dist', 'build', '.cache', '.vite-cache', '.src-snapshot'];
    if (BLOCKED_DIRS.includes(topSegment)) {
      return `ERROR: Cannot write to "${args.path}"   writes to "${topSegment}/" are not permitted. ` +
        `Only src/, public/, and root config files are writable.`;
    }

    // ── Guard: skip pre-built scaffold files that are already on disk ────────────
    // Re-writing these wastes an agent step and overwrites working template code.
    // Allow overwrite only if the file is missing (e.g., new project not yet seeded).
    if (PRE_BUILT_SCAFFOLD_PATHS.has(normalizedPath)) {
      const fullPathCheck = safeJoin(ctx.appPath, normalizedPath);
      if (fs.existsSync(fullPathCheck)) {
        return (
          `⛔ SKIPPED   ${args.path} is a pre-built scaffold file already present on disk. ` +
          `Do NOT write this file again   it wastes a step and overwrites working code. ` +
          `Import from it directly and move on to the next file in your plan.`
        );
      }
    }

    // ── Sandbox: file size cap (500 KB)   prevents runaway large file writes ──────
    const MAX_FILE_BYTES = 500 * 1024;
    if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) {
      return `ERROR: Cannot write ${args.path}   content exceeds the 500 KB per-file limit ` +
        `(${Math.round(Buffer.byteLength(args.content, 'utf8') / 1024)} KB). ` +
        `Split this into multiple smaller files.`;
    }

    const fullPath = safeJoin(ctx.appPath, args.path);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });

    // Gate: reject non-JSON content written to .json files
    if (/\.json$/i.test(args.path)) {
      try {
        JSON.parse(args.content);
      } catch (e: unknown) {
        return `ERROR: Cannot write ${args.path}   content is not valid JSON: ${e instanceof Error ? e.message : String(e)}. Please provide valid JSON content.`;
      }
    }

    const { content, fixes } = sanitizeFileContent(args.path, args.content);

    // Gate 1: reject source files with ANY bracket imbalance after sanitization.
    // sanitize.ts Phase B auto-repairs truncated code; if imbalance remains, the
    // file is structurally broken in a way that can't be auto-fixed.
    if (/\.(tsx?|jsx?)$/.test(args.path)) {
      const balance = checkSyntaxBalance(content);
      if (balance.score >= 1) {
        return (
          `ERROR: Cannot write ${args.path}   code has unbalanced brackets ` +
          `(${balance.braces} net braces, ${balance.parens} net parens, ${balance.brackets} net square brackets, score ${balance.score}). ` +
          `The file was NOT written. Your code is incomplete or has extra closing brackets. ` +
          `Please rewrite the COMPLETE file with properly balanced brackets and try again. Keep it under 200 lines.`
        );
      }

      // Gate 2: TypeScript syntax check   catches JSX errors that bracket counting misses
      // (unclosed JSX tags, mismatched tags, invalid expressions, etc.)
      try {
        const isJsx = /\.tsx$/.test(args.path);
        const tsResult = ts.transpileModule(content, {
          compilerOptions: {
            jsx: isJsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
          },
          reportDiagnostics: true,
          fileName: args.path,
        });
        if (tsResult.diagnostics && tsResult.diagnostics.length > 0) {
          const errors = tsResult.diagnostics
            .slice(0, 3)
            .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
            .join('; ');
          return (
            `ERROR: Cannot write ${args.path}   TypeScript/JSX syntax error: ${errors}. ` +
            `The file was NOT written. Common causes: unclosed JSX tags, mismatched tags, missing return expression. ` +
            `Rewrite the COMPLETE file with valid syntax.`
          );
        }
      } catch (_) {
        // transpileModule exceptions are rare   don't block writes on them
      }
    }

    fs.writeFileSync(fullPath, content, 'utf8');

    // Record in ledger so the Change Journal reflects this write
    const lineCount = content.split('\n').length;
    const topExports = /\.(tsx?|jsx?)$/.test(args.path) ? extractTopExports(content) : '';
    ctx.ledger?.recordWrite(args.path, lineCount, topExports);

    // Warn agent about existing importers (only meaningful when overwriting an existing file)
    const importers = ctx.reverseGraph?.get(args.path);
    const depWarning = importers && importers.size > 0
      ? `⚠️  DEPENDENCY ALERT: ${importers.size} file(s) import from ${args.path}:\n` +
        Array.from(importers).map(p => `   • ${p}`).join('\n') +
        `\nVerify those files still compile after your changes.\n\n`
      : '';

    const xml = `<ecomgear-write path="${escapeXmlAttr(args.path)}" description="${escapeXmlAttr(args.description ?? '')}">\n${content}\n</ecomgear-write>`;
    ctx.onXmlComplete(xml);

    // ── Buffer for deferred preview sync ─────────────────────────────────────
    // Accumulate the file in pendingPreviewFiles instead of pushing immediately.
    // get_build_errors flushes the buffer before checking, and the agent loop
    // does one final fullSync push after all steps complete. This prevents the
    // preview from flickering through broken intermediate states mid-run.
    if (ctx.pendingPreviewFiles) {
      ctx.pendingPreviewFiles.set(args.path, content);
    }

    const fixNote = fixes.length > 0 ? `\nAuto-fixed: ${fixes.join('; ')}` : '';

    // Post-write: check if @/ or relative project imports resolve to files on disk.
    // This catches missing dependencies IMMEDIATELY instead of waiting for get_build_errors.
    const importWarnings: string[] = [];
    if (/\.(tsx?|jsx?)$/.test(args.path)) {
      const importRe = /(?:import\s+.*?\s+from\s+['"]|import\s*\(\s*['"])((?:@\/|\.\.?\/)[^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const importPath = m[1];
        // Resolve @/ to src/ from project root
        const resolvedRelative = importPath.startsWith('@/')
          ? importPath.replace('@/', 'src/')
          : path.posix.join(path.dirname(args.path), importPath);
        // Check with common extensions
        const exts = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
        const found = exts.some(ext => fs.existsSync(path.join(ctx.appPath, resolvedRelative + ext)));
        if (!found) {
          importWarnings.push(importPath);
        }
      }
    }

    if (importWarnings.length > 0) {
      const warnNote = `\n\n⚠️  ACTION REQUIRED   MISSING DEPENDENCIES:\n` +
        importWarnings.map(p => `  • ${p}  ← does not exist on disk`).join('\n') +
        `\n\nYou MUST write these files NEXT before calling get_build_errors. ` +
        `If you do not, the build will fail with "Cannot find module" errors.`;
      return `${depWarning}Wrote ${args.path}${fixNote}${warnNote}`;
    }

    return `${depWarning}Successfully wrote ${args.path}${fixNote}`;
  },
};
