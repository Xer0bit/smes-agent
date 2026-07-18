import fs from 'node:fs';
import path from 'node:path';

// ─── File tree builder ────────────────────────────────────────────────────────

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '.dyad']);

export function buildFileTree(dir: string, base: string, prefix = ''): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const filtered = entries.filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
  const lines: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      const sub = buildFileTree(path.join(dir, entry.name), base, prefix + childPrefix);
      if (sub) lines.push(sub);
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }

  return lines.join('\n');
}

export function getProjectFileTree(appPath: string): string {
  if (!fs.existsSync(appPath)) return '';
  const tree = buildFileTree(appPath, appPath);
  return tree ? `./\n${tree}` : './\n(empty)';
}
