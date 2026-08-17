/**
 * glob_files tool — find files by name/path pattern without dumping the whole tree.
 * Claude-Code-style Glob: "**\/*.test.ts", "src/**\/Header.tsx", etc.
 * In-process walk + regex match (no `find`/shell dependency), sorted by mtime desc.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache']);
const MAX_RESULTS = 100;
const MAX_SCAN_FILES = 20000;

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches across path separators (including zero segments)
        i++;
        if (glob[i + 1] === '/') i++;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const schema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.test.ts", "src/**/Header.tsx", "*.config.js"'),
  path: z.string().optional().describe('Directory to search from (default: project root)'),
});

export const globFilesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'glob_files',
  description:
    'Find files by name/path pattern (e.g. "**/*.test.ts" or "**/Header.tsx") without listing the whole tree. ' +
    'Prefer this over list_files(recursive=true) when you know roughly what the filename looks like — cheaper, ' +
    'and results are sorted newest-first so recently touched files surface first.',
  inputSchema: schema,
  getConsentPreview: (args) => `Find files matching "${args.pattern}"`,

  execute: async (args, ctx: AgentContext) => {
    const root = args.path ? safeJoin(ctx.appPath, args.path) : ctx.appPath;
    if (!fs.existsSync(root)) {
      return `Error: Path does not exist: ${args.path ?? '.'}`;
    }
    const regex = globToRegExp(args.pattern);
    const matches: { rel: string; mtime: number }[] = [];
    let scanned = 0;

    const walk = (dir: string): void => {
      if (scanned >= MAX_SCAN_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (scanned >= MAX_SCAN_FILES) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
          continue;
        }
        scanned++;
        const rel = path.relative(ctx.appPath, fullPath).replace(/\\/g, '/');
        if (regex.test(rel) || regex.test(entry.name)) {
          let mtime = 0;
          try { mtime = fs.statSync(fullPath).mtimeMs; } catch { /* skip */ }
          matches.push({ rel, mtime });
        }
      }
    };
    walk(root);

    if (matches.length === 0) {
      return `No files matched "${args.pattern}".`;
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    const truncated = matches.length > MAX_RESULTS;
    const shown = matches.slice(0, MAX_RESULTS).map((m) => m.rel);
    return shown.join('\n') + (truncated ? `\n… (${matches.length - MAX_RESULTS} more, narrow the pattern)` : '');
  },
};
