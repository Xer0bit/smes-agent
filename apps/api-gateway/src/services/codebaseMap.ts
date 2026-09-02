/**
 * The codebase map: what the generated app is made of, as one knowledge chunk.
 *
 * How the agent sees a project's code today is invisible to the owner: per
 * file embeddings and an import graph rank files, a character budget admits a
 * few bodies into the prompt, and the rest is reached through read tools.
 * None of that is a description a person (or the next run) can read.
 *
 * This is that description: routes from the route table, pages, components,
 * contexts/hooks/services, edge functions, plus counts. Rebuilt at the end of
 * every run that changed files and upserted as the `codebase` knowledge chunk
 * (source_ref `codebase:map`), so Settings → Knowledge shows it and every run
 * carries it. Deterministic and cheap: no model call, a few KB at most.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CODEBASE_MAP_REF = 'codebase:map';
export const CODEBASE_MAP_HEADING = 'Codebase map';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.vite-cache', '.cache', 'coverage']);
const SOURCE_EXT = /\.(tsx?|jsx?|css|json|html|md)$/;
const MAX_LIST = 40;

export interface CodebaseFile {
  path: string;
  /** Only the route table needs its body; everything else is path-only. */
  content?: string;
}

/** Walk the project on disk into the path list the map is built from. */
export function listProjectFiles(appPath: string): CodebaseFile[] {
  const out: CodebaseFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(appPath, full).replace(/\\/g, '/');
      if (!SOURCE_EXT.test(rel) && !rel.startsWith('__edge_functions__/')) continue;
      const wantsBody = /^src\/App\.(tsx|jsx)$/.test(rel);
      let content: string | undefined;
      if (wantsBody) { try { content = fs.readFileSync(full, 'utf8'); } catch { /* path-only */ } }
      out.push({ path: rel, content });
    }
  };
  walk(appPath);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** `<Route path="/admin" element={<AdminPage />} />` -> "/admin -> AdminPage" */
export function extractRoutes(appTsx: string): string[] {
  const routes: string[] = [];
  // One window per <Route ...>: the element's own `>` makes a single tag
  // regex unreliable, so cut at the next <Route instead.
  const parts = appTsx.split(/<Route\b/).slice(1);
  for (const part of parts) {
    const p = /\bpath=["']([^"']+)["']/.exec(part);
    if (!p) continue;
    const el = /\belement=\{\s*<\s*([A-Za-z0-9_.]+)/.exec(part) ?? /\bcomponent=\{\s*([A-Za-z0-9_.]+)/.exec(part);
    routes.push(el ? `${p[1]} -> ${el[1]}` : p[1]);
  }
  return [...new Set(routes)];
}

function baseName(p: string): string {
  return p.split('/').pop()!.replace(/\.(tsx?|jsx?)$/, '');
}

function section(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_LIST);
  const more = items.length - shown.length;
  return [`${title} (${items.length}): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`];
}

/**
 * The map text. Pure over the file list so it can be tested without a disk.
 */
export function buildCodebaseMap(files: readonly CodebaseFile[], extras: { edgeFunctions?: readonly string[]; tables?: readonly string[] } = {}): string {
  const src = files.filter((f) => f.path.startsWith('src/'));
  const app = files.find((f) => /^src\/App\.(tsx|jsx)$/.test(f.path));
  const routes = app?.content ? extractRoutes(app.content) : [];
  const pages = src.filter((f) => /^src\/(pages|views|screens)\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)).map((f) => baseName(f.path));
  const components = src.filter((f) => /^src\/components\//.test(f.path) && !/\/ui\//.test(f.path) && /\.(tsx|jsx)$/.test(f.path)).map((f) => baseName(f.path));
  const uiKit = src.filter((f) => /^src\/components\/ui\//.test(f.path)).length;
  const contexts = src.filter((f) => /^src\/(contexts?|store|state)\//.test(f.path)).map((f) => baseName(f.path));
  const hooks = src.filter((f) => /^src\/hooks\//.test(f.path)).map((f) => baseName(f.path));
  const services = src.filter((f) => /^src\/(services|api|lib)\//.test(f.path) && /\.(tsx?|jsx?)$/.test(f.path)).map((f) => f.path.replace(/^src\//, ''));
  const edgeFns = extras.edgeFunctions?.length
    ? [...extras.edgeFunctions]
    : files.filter((f) => f.path.startsWith('__edge_functions__/')).map((f) => baseName(f.path));
  const tables = extras.tables ?? [];

  const lines: string[] = [];
  lines.push(`Source files: ${src.length}${uiKit ? ` (plus ${uiKit} ui-kit components)` : ''}.`);
  lines.push(...section('Routes', routes));
  lines.push(...section('Pages', pages));
  lines.push(...section('Components', components));
  lines.push(...section('State / contexts', contexts));
  lines.push(...section('Hooks', hooks));
  lines.push(...section('Services / lib', services));
  lines.push(...section('Edge functions', edgeFns));
  lines.push(...section('Database tables', [...tables]));
  if (routes.length === 0 && pages.length === 0) lines.push('No pages or routes yet: this project is at the scaffold.');
  return lines.join('\n');
}
