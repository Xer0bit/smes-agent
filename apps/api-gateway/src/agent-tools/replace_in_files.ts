/**
 * replace_in_files: one call, many exact hunks, across many files, all or nothing.
 *
 * Why it exists (2026-09-03, Learning tree run 5f439d01): the model needed to
 * swap `supabase.from(...)` calls for `api.call(...)` in a 501-line page. It
 * tried write_file with the whole file five times; each body came back
 * truncated and was rejected, the circuit breaker fired, the run timed out at
 * $1.13 with nothing landed. The right tool was a handful of small hunks. This
 * is that tool: every hunk is located (exact, then whitespace-tolerant) and
 * every resulting file is syntax-checked BEFORE anything is written, so a
 * batch either lands completely or reports exactly which hunk failed and why.
 */
import fs from 'node:fs';
import { z } from 'zod';
import ts from 'typescript';
import { ToolDefinition, AgentContext, safeJoin, extractAnonFetchTables } from './types.js';
import { writeProjectFile } from '../services/projectFileWriter.js';
import { sanitizeFileContent, checkSyntaxBalance } from './sanitize.js';
import { fuzzyFind } from './edit_file.js';
import { staleViewNotice } from './searchMissDiagnostics.js';

const hunkSchema = z.object({
  path: z.string().describe('Project-relative file path, e.g. src/pages/admin/AdminPaymentsPage.tsx'),
  search: z.string().min(1).describe('Exact text to find (copy it from read_file output). Whitespace at line ends is tolerated.'),
  replace: z.string().describe('Replacement text. Empty string deletes the matched text.'),
  all: z.boolean().optional().describe('Replace every occurrence in the file (default: first occurrence only).'),
});

const schema = z.object({
  edits: z.array(hunkSchema).min(1).max(40).describe('Hunks to apply. Several hunks may target the same file; they apply in order.'),
});

export type ReplaceHunk = z.infer<typeof hunkSchema>;

export interface ApplyResult {
  ok: boolean;
  files: Map<string, string>;
  applied: Array<{ path: string; occurrences: number }>;
  error?: string;
}

/** Pure: apply every hunk to the given file contents; nothing touches disk. */
export function applyHunks(original: Map<string, string>, edits: ReplaceHunk[]): ApplyResult {
  const files = new Map(original);
  const applied: Array<{ path: string; occurrences: number }> = [];
  for (const [i, h] of edits.entries()) {
    const current = files.get(h.path);
    if (current === undefined) return { ok: false, files, applied, error: `hunk ${i + 1}: ${h.path} does not exist` };
    let occurrences = 0;
    let next = current;
    if (h.all) {
      let guard = 0;
      for (;;) {
        const hit = fuzzyFind(next, h.search);
        if (!hit.found || guard++ > 500) break;
        next = next.slice(0, hit.start) + h.replace + next.slice(hit.end);
        occurrences++;
        if (h.replace.includes(h.search)) break; // replacement contains the search text; one pass is the only sane semantics
      }
    } else {
      const hit = fuzzyFind(next, h.search);
      if (hit.found) {
        next = next.slice(0, hit.start) + h.replace + next.slice(hit.end);
        occurrences = 1;
      }
    }
    if (occurrences === 0) {
      const firstLine = h.search.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
      return { ok: false, files, applied, error: `hunk ${i + 1}: SEARCH text not found in ${h.path} (starts with "${firstLine.slice(0, 80)}"). Nothing was written. read_file the region and copy the exact text.` };
    }
    files.set(h.path, next);
    applied.push({ path: h.path, occurrences });
  }
  return { ok: true, files, applied };
}

function syntaxProblem(path: string, before: string, after: string): string | null {
  if (!/\.(tsx?|jsx?)$/.test(path)) return null;
  const b = checkSyntaxBalance(before);
  const a = checkSyntaxBalance(after);
  if (a.score > b.score && a.score >= (b.score === 0 ? 1 : 2)) {
    return `${path}: result has unbalanced brackets (${a.braces} braces, ${a.parens} parens net)`;
  }
  if (/\.tsx?$/.test(path)) {
    try {
      const isJsx = /\.tsx$/.test(path);
      const r = ts.transpileModule(after, {
        compilerOptions: { ...(isJsx ? { jsx: ts.JsxEmit.ReactJSX } : {}), module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        reportDiagnostics: true,
        fileName: path,
      });
      const d = (r.diagnostics ?? []).find((x) => x.file);
      if (d && d.file && d.start !== undefined) {
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        return `${path}: line ${line + 1} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      }
    } catch { /* transpile itself failed; the balance check above is the signal */ }
  }
  return null;
}

export const replaceInFilesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'replace_in_files',
  description:
    'Apply many exact SEARCH→REPLACE hunks across one or more existing files in ONE call, all or nothing. ' +
    'Use it for the same change in several files (rename an import, swap an API call, change a prop) and for ' +
    'any change to a long file: change only the lines that must change instead of rewriting the file. ' +
    'Every hunk is located and every resulting file is syntax-checked before anything is written; on failure it ' +
    'names the hunk and nothing changes. Copy SEARCH text from read_file output; keep each hunk under ~30 lines.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Replace in ${new Set(args.edits.map((e) => e.path)).size} file(s), ${args.edits.length} hunk(s)`,
  execute: async (args, ctx: AgentContext) => {
    const paths = [...new Set(args.edits.map((e) => e.path))];
    const original = new Map<string, string>();
    for (const p of paths) {
      const full = safeJoin(ctx.appPath, p);
      if (!fs.existsSync(full)) return `ERROR: ${p} does not exist. replace_in_files only edits existing files; use write_file to create one.`;
      original.set(p, fs.readFileSync(full, 'utf8'));
    }

    const result = applyHunks(original, args.edits);
    if (!result.ok) return `ERROR: ${result.error}`;

    const sanitized = new Map<string, { content: string; fixes: string[] }>();
    for (const p of paths) {
      const after = result.files.get(p)!;
      const s = sanitizeFileContent(p, after);
      const problem = syntaxProblem(p, original.get(p)!, s.content);
      if (problem) return `ERROR: ${problem}. Nothing was written. The hunk that touched this file produced invalid code; fix the replacement text and retry the whole call.`;
      sanitized.set(p, { content: s.content, fixes: s.fixes });
    }

    for (const p of paths) {
      const { content } = sanitized.get(p)!;
      await writeProjectFile({ appPath: ctx.appPath, projectId: ctx.projectId, runId: ctx.runId }, p, content);
      ctx.onXmlComplete(`<SMEsAgent-edit path="${p}"></SMEsAgent-edit>`);
      ctx.pendingPreviewFiles?.set(p, content);
      ctx.ledger?.recordEdit(p, args.edits.find((e) => e.path === p)?.search ?? '');
      if (/\.(tsx?|jsx?)$/.test(p)) {
        for (const t of extractAnonFetchTables(content)) {
          if (!ctx.anonFetchTables) ctx.anonFetchTables = new Map();
          if (!ctx.anonFetchTables.has(t)) ctx.anonFetchTables.set(t, p);
        }
      }
    }

    const summary = result.applied.map((a) => `${a.path} (${a.occurrences})`).join(', ');
    const fixes = [...sanitized.entries()].filter(([, v]) => v.fixes.length > 0).map(([p, v]) => `${p}: ${v.fixes.join('; ')}`);
    return `Replaced in ${paths.length} file(s): ${summary}.${fixes.length ? `\nAuto-fixed: ${fixes.join(' | ')}` : ''}${paths.map(staleViewNotice).join('')}`;
  },
};
