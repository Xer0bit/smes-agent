/**
 * Symbol-level graph: functions/components/hooks within a file, and the calls
 * between them. Extends graphStore.ts (file-level imports/exports) one level
 * down, so context assembly can traverse "which functions call/render X" —
 * not just "which files import X".
 *
 * Deliberately regex-based, matching the existing graphStore.ts style — no
 * tree-sitter dependency. This trades perfect accuracy for zero new native
 * deps and a same-day ship; a tree-sitter-based AST pass is a natural
 * follow-up once this shape proves useful in practice.
 *
 * Table: project_symbol_graph
 *   project_id, file_path, symbol_name, kind, calls (text[]), renders (text[])
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY || '';

function getClient() {
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

export type SymbolKind = 'function' | 'component' | 'hook' | 'type';

export interface SymbolNode {
  name: string;
  kind: SymbolKind;
  /** Other symbols (in this file or imported) this symbol calls. */
  calls: string[];
  /** JSX components rendered inside this symbol's body (component/hook only). */
  renders: string[];
}

// ── Static extraction ────────────────────────────────────────────────────────

// Top-level declarations: function Foo(...), const Foo = (...) => , export default function Foo(...)
const DECL_RE =
  /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g;

// A "call" reference: identifier immediately followed by ( — cheap, catches
// most real calls, false-positives on things like `if (` are filtered by
// requiring the identifier to start with a letter/underscore/$ and not be a
// JS/TS keyword.
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally',
  'throw', 'yield', 'await', 'async', 'super', 'this', 'constructor',
]);

// JSX component usage: <ComponentName ...> or <ComponentName/>. Only
// PascalCase tags are real components — lowercase tags are native DOM elements.
const JSX_RE = /<([A-Z][\w.]*)\b/g;

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/**
 * Extract top-level function/component/hook symbols and their call/render
 * edges from a single file's source. Best-effort static analysis — a
 * declaration this regex misses just means that symbol isn't graph-traversable,
 * not a crash or a wrong result.
 */
export function extractSymbols(content: string): SymbolNode[] {
  const nodes: SymbolNode[] = [];
  const declMatches: Array<{ name: string; start: number }> = [];

  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(content)) !== null) {
    const name = m[1] || m[2];
    if (name) declMatches.push({ name, start: m.index });
  }

  if (declMatches.length === 0) return nodes;

  // Approximate each symbol's body as the text from its declaration to the
  // next declaration (or end of file). Not a real parser, but good enough to
  // scope call/render extraction to roughly the right function.
  for (let i = 0; i < declMatches.length; i++) {
    const { name, start } = declMatches[i];
    const end = i + 1 < declMatches.length ? declMatches[i + 1].start : content.length;
    const body = content.slice(start, end);

    const calls = new Set<string>();
    CALL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CALL_RE.exec(body)) !== null) {
      const callee = cm[1];
      if (callee !== name && !JS_KEYWORDS.has(callee)) calls.add(callee);
    }

    const renders = new Set<string>();
    JSX_RE.lastIndex = 0;
    let jm: RegExpExecArray | null;
    while ((jm = JSX_RE.exec(body)) !== null) {
      if (jm[1] !== name) renders.add(jm[1]);
    }

    const kind: SymbolKind = isHookName(name) ? 'hook' : isComponentName(name) ? 'component' : 'function';

    nodes.push({
      name,
      kind,
      calls: [...calls].slice(0, 40), // cap — pathological files shouldn't blow up storage
      renders: [...renders].slice(0, 40),
    });
  }

  return nodes;
}

// ── DB operations ────────────────────────────────────────────────────────────

export async function upsertSymbolGraph(
  projectId: string,
  filePath: string,
  symbols: SymbolNode[],
): Promise<void> {
  const db = getClient();
  if (!db) return;

  // Replace this file's symbols wholesale — simpler and cheap enough at
  // file-write frequency than diffing individual symbol rows.
  await db.from('project_symbol_graph').delete().eq('project_id', projectId).eq('file_path', filePath);
  if (symbols.length === 0) return;

  const rows = symbols.map(s => ({
    project_id: projectId,
    file_path: filePath,
    symbol_name: s.name,
    kind: s.kind,
    calls: s.calls,
    renders: s.renders,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db.from('project_symbol_graph').insert(rows);
  if (error) console.warn('[kb/symbolGraph] insert error:', error.message);
}

export async function deleteSymbolGraph(projectId: string, filePath: string): Promise<void> {
  const db = getClient();
  if (!db) return;
  await db.from('project_symbol_graph').delete().eq('project_id', projectId).eq('file_path', filePath);
}

export interface SymbolRow {
  file_path: string;
  symbol_name: string;
  kind: SymbolKind;
  calls: string[];
  renders: string[];
}

/** Find the symbol row(s) matching a name (e.g. the symbol named in a build error). */
export async function findSymbol(projectId: string, symbolName: string): Promise<SymbolRow[]> {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db
    .from('project_symbol_graph')
    .select('file_path, symbol_name, kind, calls, renders')
    .eq('project_id', projectId)
    .eq('symbol_name', symbolName);
  if (error || !data) return [];
  return data as SymbolRow[];
}

/**
 * One-hop callers: symbols whose `calls` or `renders` array includes any of
 * the given symbol names. Used for blast-radius / "who uses this" queries.
 */
export async function getCallers(projectId: string, symbolNames: string[]): Promise<SymbolRow[]> {
  const db = getClient();
  if (!db || symbolNames.length === 0) return [];

  // Two separate .overlaps() queries (calls, renders) instead of one combined
  // .or() — .overlaps() is parameterized by the client (safe against symbol
  // names containing commas/braces), whereas building an .or() filter string
  // by hand would require manually escaping user-influenced symbol names.
  const [callsRes, rendersRes] = await Promise.all([
    db.from('project_symbol_graph')
      .select('file_path, symbol_name, kind, calls, renders')
      .eq('project_id', projectId)
      .overlaps('calls', symbolNames),
    db.from('project_symbol_graph')
      .select('file_path, symbol_name, kind, calls, renders')
      .eq('project_id', projectId)
      .overlaps('renders', symbolNames),
  ]);

  const rows = [...(callsRes.data ?? []), ...(rendersRes.data ?? [])];
  if (callsRes.error) console.warn('[kb/symbolGraph] getCallers (calls) error:', callsRes.error.message);
  if (rendersRes.error) console.warn('[kb/symbolGraph] getCallers (renders) error:', rendersRes.error.message);

  // Dedup by (file_path, symbol_name)
  const seen = new Set<string>();
  const deduped: SymbolRow[] = [];
  for (const r of rows as SymbolRow[]) {
    const key = `${r.file_path}::${r.symbol_name}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
  }
  return deduped;
}

/** One-hop callees: symbols named in `calls`/`renders` of the given symbol row(s). */
export function getCalleeNames(rows: SymbolRow[]): string[] {
  const names = new Set<string>();
  for (const r of rows) {
    for (const c of r.calls) names.add(c);
    for (const c of r.renders) names.add(c);
  }
  return [...names];
}

/**
 * Blast-radius traversal for the fix/edit tiers: given a symbol being edited,
 * return the one-hop callers (who breaks if this symbol's contract changes)
 * and one-hop callees (what this symbol depends on).
 */
export async function getBlastRadius(
  projectId: string,
  symbolName: string,
): Promise<{ target: SymbolRow[]; callers: SymbolRow[]; calleeNames: string[] }> {
  const target = await findSymbol(projectId, symbolName);
  const [callers] = await Promise.all([getCallers(projectId, [symbolName])]);
  const calleeNames = getCalleeNames(target);
  return { target, callers, calleeNames };
}
