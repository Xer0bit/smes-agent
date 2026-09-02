/**
 * collectSandboxFiles is the run's output boundary — if it drops a real file,
 * the commit loses it; if it sweeps a skip-dir, revisions bloat with
 * node_modules. These assert the walker's contract directly (no DB needed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSandboxFiles } from '../runSandbox.js';

const BINARY_SENTINEL = '__ECOMGEAR_BIN64__';
let dir: string;

function seed(files: Record<string, Buffer | string>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  }
  return dir;
}

afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ } });

describe('collectSandboxFiles', () => {
  it('collects text and binary files, encoding binaries as sentinel+base64', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
    const sandbox = seed({
      'src/App.tsx': 'export const App = () => null;',
      'public/logo.png': png,
    });
    const files = collectSandboxFiles(sandbox);
    const byPath = new Map(files.map((f) => [f.path, f.content]));
    expect(byPath.get('src/App.tsx')).toBe('export const App = () => null;');
    expect(byPath.get('public/logo.png')).toBe(`${BINARY_SENTINEL}${png.toString('base64')}`);
  });

  it('skips build/dep dirs and ignored files entirely', () => {
    const sandbox = seed({
      'src/index.ts': 'x',
      'node_modules/react/index.js': 'never',
      'dist/bundle.js': 'never',
      '.git/HEAD': 'never',
      'package-lock.json': 'never',
      '.env': 'SECRET=never',
    });
    const paths = collectSandboxFiles(sandbox).map((f) => f.path).sort();
    expect(paths).toEqual(['src/index.ts']);
  });

  it('drops oversized text files but keeps normal ones', () => {
    const sandbox = seed({
      'src/ok.ts': 'small',
      'src/huge.ts': 'a'.repeat(512 * 1024 + 1),
    });
    const paths = collectSandboxFiles(sandbox).map((f) => f.path).sort();
    expect(paths).toEqual(['src/ok.ts']);
  });

  it('returns [] for an empty sandbox (new project first build writes into it)', () => {
    expect(collectSandboxFiles(seed({}))).toEqual([]);
  });
});

import { createHash } from 'node:crypto';
import { diffFilesAgainstHead } from '../runSandbox.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('diffFilesAgainstHead (real changeset vs whole-tree sweep)', () => {
  it('classifies added / changed / unchanged / deleted against HEAD hashes', () => {
    const head = new Map([
      ['src/App.tsx', sha('OLD')],
      ['src/keep.ts', sha('SAME')],
      ['src/gone.ts', sha('BYE')],
    ]);
    const files = [
      { path: 'src/App.tsx', content: 'NEW' },   // changed
      { path: 'src/keep.ts', content: 'SAME' },  // unchanged
      { path: 'src/new.ts',  content: 'HI' },    // added
    ];
    const d = diffFilesAgainstHead(files, head);
    expect(d.changed.map(f => f.path)).toEqual(['src/App.tsx']);
    expect(d.added.map(f => f.path)).toEqual(['src/new.ts']);
    expect(d.deleted).toEqual(['src/gone.ts']);
    expect(d.unchanged).toBe(1);
  });

  it('a run that touched nothing produces an empty changeset', () => {
    const head = new Map([['a.ts', sha('x')]]);
    const d = diffFilesAgainstHead([{ path: 'a.ts', content: 'x' }], head);
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it('treats everything as added when the project has no HEAD yet', () => {
    const d = diffFilesAgainstHead([{ path: 'a.ts', content: 'x' }], new Map());
    expect(d.added.map(f => f.path)).toEqual(['a.ts']);
    expect(d.deleted).toEqual([]);
  });
});

import { pickReadableHead } from '../runSandbox.js';

/**
 * HEAD selection decides whether a project has a usable source of truth at all.
 * When it answers null, openSandbox falls back to copying the shared project dir
 * (the contamination reservoir) and the changeset diff loses its baseline, so
 * every push becomes a whole-tree fullSync. Both failures are silent, which is
 * why the "skip an unreadable row" behaviour needs its own assertions.
 */
describe('pickReadableHead', () => {
  const manifest = (n = 1) => ({ format: 'manifest-v1', files: Array.from({ length: n }, (_, i) => ({ path: `f${i}.ts`, hash: 'h', source_revision: 'r' })) });

  it('takes the newest revision when it is readable', () => {
    const head = pickReadableHead([
      { id: 'new', generated_files: manifest() },
      { id: 'old', generated_files: manifest() },
    ]);
    expect(head?.revisionId).toBe('new');
  });

  it('skips a half-written revision and falls back to the last good manifest', () => {
    // The deferred-write shape: the row exists, the manifest never landed.
    const head = pickReadableHead([
      { id: 'interrupted', generated_files: null },
      { id: 'good', generated_files: manifest() },
    ]);
    expect(head?.revisionId).toBe('good');
  });

  it('skips a legacy non-manifest revision (the snapshot-rollback shape)', () => {
    const head = pickReadableHead([
      { id: 'legacy', generated_files: { files: [{ path: 'a.ts', content: 'x' }] } }, // no format key
      { id: 'good', generated_files: manifest() },
    ]);
    expect(head?.revisionId).toBe('good');
  });

  it('skips an empty manifest, which describes no project', () => {
    const head = pickReadableHead([
      { id: 'empty', generated_files: { format: 'manifest-v1', files: [] } },
      { id: 'good', generated_files: manifest(3) },
    ]);
    expect(head?.revisionId).toBe('good');
  });

  it('returns null when nothing in the window is readable', () => {
    expect(pickReadableHead([
      { id: 'a', generated_files: null },
      { id: 'b', generated_files: { files: [] } },
    ])).toBe(null);
  });

  it('returns null for an empty project with no revisions', () => {
    expect(pickReadableHead([])).toBe(null);
  });
});
