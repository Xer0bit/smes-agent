/**
 * search_codebase tool — semantic + graph search over the project's own files,
 * for mid-run lookups the agent can't answer from files already in context.
 *
 * Reuses the same vector+graph engine (server/src/knowledgebase/retrieval.ts)
 * that already selects initial context files before a run starts — this just
 * exposes it as an on-demand tool call, so a mid-run "where does X live" no
 * longer has to fall back to blind grep/read_file loops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { retrieveRelevantFiles, type WorkspaceFile } from '../knowledgebase/index.js';

const schema = z.object({
  query: z.string().describe('Natural-language description of what you\'re looking for, e.g. "auth login logic" or "cart checkout state"'),
  max_results: z.number().optional().describe('Max files to return (default 8)'),
});

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.dyad', '.vite', 'coverage']);
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
const SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production']);

function collectWorkspaceFiles(root: string): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      const fp = path.join(dir, entry.name);
      try {
        const content = fs.readFileSync(fp, 'utf8');
        out.push({ path: path.relative(root, fp), content });
      } catch { /* unreadable — skip */ }
    }
  };
  walk(root);
  return out;
}

export const searchCodebaseTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'search_codebase',
  description:
    'Semantic + graph search over the project\'s own files — finds files relevant to a natural-language description (e.g. "where is the cart total calculated") without needing to know exact file names. Prefer this over repeated grep/read_file guessing when looking for functionality rather than an exact string. Returns matched file paths with a short preview; use read_file for full content.',
  inputSchema: schema,
  getConsentPreview: (args) => `Search codebase: "${args.query}"`,

  execute: async (args, ctx: AgentContext) => {
    const files = collectWorkspaceFiles(ctx.appPath);
    if (files.length === 0) return 'No files found in project.';

    const maxFiles = Math.min(Math.max(args.max_results ?? 8, 1), 15);
    const results = await retrieveRelevantFiles(ctx.projectId, args.query, files, {
      maxFiles,
      graphExpansion: true,
    });

    if (results.length === 0) return 'No relevant files found for that query.';

    const byPath = new Map(files.map(f => [f.path, f.content]));
    return results.map(r => {
      const content = byPath.get(r.path) ?? '';
      const preview = content.slice(0, 250).replace(/\s+/g, ' ').trim();
      return `${r.path}  (${r.reason}, score ${r.score.toFixed(2)})\n  ${preview}${content.length > 250 ? '...' : ''}`;
    }).join('\n\n');
  },
};
