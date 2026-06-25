/**
 * Import graph storage and traversal.
 * Table: project_file_graph
 *
 * Parses TypeScript/JavaScript import statements to build a dependency graph.
 * Used to expand vector search results to include directly related files
 * (e.g. if Navbar.tsx is relevant, also include its direct imports).
 */

import { createClient } from '@supabase/supabase-js';
import path from 'path';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY || '';

function getClient() {
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

// ─── Import parsing ──────────────────────────────────────────────────────────

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gm;
const REQUIRE_RE = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/gm;

/** Resolve an import path to a project-relative path.
 *  Handles: relative (./foo), path aliases (@/foo → src/foo), bare node_modules (skipped).
 */
function resolveImportPath(fromFile: string, importPath: string): string | null {
  // Skip node_modules bare specifiers (e.g. 'react', 'lodash')
  if (!importPath.startsWith('.') && !importPath.startsWith('@/')) return null;

  // Path alias @/ → src/
  if (importPath.startsWith('@/')) {
    return 'src/' + importPath.slice(2);
  }

  const dir = path.dirname(fromFile);
  let resolved = path.join(dir, importPath).replace(/\\/g, '/');

  // Strip leading slash to get project-relative path
  if (resolved.startsWith('/')) resolved = resolved.slice(1);

  return resolved;
}

export function parseImports(filePath: string, content: string): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const resolved = resolveImportPath(filePath, raw);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      imports.push(resolved);
    }
  };

  let m: RegExpExecArray | null;

  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) add(m[1]);

  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(content)) !== null) add(m[1]);

  return imports;
}

export function parseExports(content: string): string[] {
  const exports: string[] = [];
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content)) !== null) {
    exports.push(m[1]);
  }
  return exports;
}

// ─── DB operations ───────────────────────────────────────────────────────────

export interface FileGraphRow {
  project_id: string;
  file_path: string;
  imports: string[];
  exports: string[];
}

export async function upsertFileGraph(
  projectId: string,
  filePath: string,
  imports: string[],
  exports: string[],
): Promise<void> {
  const db = getClient();
  if (!db) return;

  const { error } = await db.from('project_file_graph').upsert(
    {
      project_id: projectId,
      file_path:  filePath,
      imports,
      exports,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,file_path' },
  );

  if (error) {
    console.warn('[kb/graphStore] upsert error:', error.message);
  }
}

/** Get all files that the given files import (1 level deep). */
export async function getDirectImports(
  projectId: string,
  filePaths: string[],
): Promise<string[]> {
  const db = getClient();
  if (!db) return [];

  const { data, error } = await db
    .from('project_file_graph')
    .select('imports')
    .eq('project_id', projectId)
    .in('file_path', filePaths);

  if (error || !data) return [];

  const all = data.flatMap((row: any) => row.imports as string[]);
  return [...new Set(all)].filter(p => !filePaths.includes(p));
}

/** Get all files that import any of the given files (reverse edges). */
export async function getDirectDependents(
  projectId: string,
  filePaths: string[],
): Promise<string[]> {
  const db = getClient();
  if (!db) return [];

  // Use overlap operator: imports && ARRAY[...paths]
  const { data, error } = await db
    .from('project_file_graph')
    .select('file_path')
    .eq('project_id', projectId)
    .overlaps('imports', filePaths);

  if (error || !data) return [];

  return (data as any[])
    .map(row => row.file_path as string)
    .filter(p => !filePaths.includes(p));
}

export async function deleteFileGraph(
  projectId: string,
  filePath: string,
): Promise<void> {
  const db = getClient();
  if (!db) return;

  await db
    .from('project_file_graph')
    .delete()
    .eq('project_id', projectId)
    .eq('file_path', filePath);
}
