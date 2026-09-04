/**
 * A revision's manifest is the project's source of truth. An entry pointing at
 * a file that was never uploaded resolves to a 404 for every later reader, and
 * a revision refused outright leaves the project with no manifest-v1 HEAD at
 * all -- which on 2026-09-01 silently disabled both HEAD-materialised sandboxes
 * and changeset pushes for a whole day, because of one 8.2 MiB JPEG.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { exceedsObjectLimit, reconcileManifestAfterFailures, planRevisionUploads } from '../agentRevisionPersist.service.js';

const entry = (path: string, rev = 'rev-new') => ({ path, hash: `h-${path}`, source_revision: rev });

describe('reconcileManifestAfterFailures', () => {
  it('leaves the manifest untouched when everything uploaded', () => {
    const m = [entry('a.ts'), entry('b.ts')];
    const r = reconcileManifestAfterFailures(m, [], new Map());
    expect(r.manifest).toEqual(m);
    expect(r.skipped).toEqual([]);
  });

  it('carries a failed file forward from the previous revision instead of losing it', () => {
    const m = [entry('src/App.tsx'), entry('public/hero.jpg')];
    const prev = new Map([['public/hero.jpg', { hash: 'h-old', source_revision: 'rev-old' }]]);
    const r = reconcileManifestAfterFailures(m, ['public/hero.jpg'], prev);

    expect(r.skipped).toEqual([]);
    expect(r.manifest).toEqual([
      entry('src/App.tsx'),
      // points at the revision that actually holds the bytes, not at this one
      { path: 'public/hero.jpg', hash: 'h-old', source_revision: 'rev-old' },
    ]);
  });

  it('drops a failed file that has no earlier copy, and reports it', () => {
    const m = [entry('src/App.tsx'), entry('public/new-hero.jpg')];
    const r = reconcileManifestAfterFailures(m, ['public/new-hero.jpg'], new Map());

    expect(r.manifest).toEqual([entry('src/App.tsx')]);
    expect(r.skipped).toEqual(['public/new-hero.jpg']);
  });

  it('never leaves an entry pointing at a revision that lacks the bytes', () => {
    const m = [entry('a.jpg'), entry('b.jpg')];
    const prev = new Map([['a.jpg', { hash: 'h-old', source_revision: 'rev-old' }]]);
    const r = reconcileManifestAfterFailures(m, ['a.jpg', 'b.jpg'], prev);

    for (const e of r.manifest) expect(e.source_revision).not.toBe('rev-new');
    expect(r.skipped).toEqual(['b.jpg']);
  });

  it('keeps the good files when one asset fails, which is the CardPro case', () => {
    const m = [entry('index.html'), entry('src/App.tsx'), entry('public/assets/about-hero.jpg')];
    const r = reconcileManifestAfterFailures(m, ['public/assets/about-hero.jpg'], new Map());
    // The old behaviour returned ok:false here and wrote no manifest at all.
    expect(r.manifest.map((e) => e.path)).toEqual(['index.html', 'src/App.tsx']);
    expect(r.skipped).toEqual(['public/assets/about-hero.jpg']);
  });
});

describe('exceedsObjectLimit', () => {
  it('measures the encoded bytes the bucket will actually receive', () => {
    const limit = 10 * 1024 * 1024;
    // 8.2 MiB of raw image becomes ~11 MiB once base64'd, which is what the
    // bucket refused. The check must catch it before the upload attempt.
    const base64OfEightPointTwoMiB = 'A'.repeat(Math.ceil((8.2 * 1024 * 1024) / 3) * 4);
    expect(exceedsObjectLimit(base64OfEightPointTwoMiB, limit)).toBe(true);
    expect(exceedsObjectLimit('small file', limit)).toBe(false);
  });
});

describe('planRevisionUploads', () => {
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const prev = (path: string, content: string, rev = 'rev-old') =>
    ({ path, hash: h(content), source_revision: rev }) as const;

  it('carries a file the user edited mid-run instead of reverting it with the stale sandbox copy', () => {
    // Sandbox holds run-start content for a.ts; the agent never touched it.
    // The user saved a newer revision (rev-user) WHILE the run was in flight.
    const base = new Map([['src/App.tsx', h('run-start content')]]);
    const prevByPath = new Map([['src/App.tsx', { hash: h('user edit mid-run'), source_revision: 'rev-user' }]]);
    const plan = planRevisionUploads(
      [{ path: 'src/App.tsx', content: 'run-start content' }],
      prevByPath,
      base,
    );

    // The stale sandbox copy must NOT be uploaded: the entry is carried from
    // the user's revision (no `content`, so persist never uploads it).
    expect(plan.collected).toEqual([
      { path: 'src/App.tsx', hash: h('run-start content'), source_revision: 'rev-user' },
    ]);
    expect(plan.carryPrev).toEqual([]);
  });

  it('uploads a file the run actually changed', () => {
    const base = new Map([['src/App.tsx', h('old')]]);
    const prevByPath = new Map([['src/App.tsx', { hash: h('old'), source_revision: 'rev-old' }]]);
    const plan = planRevisionUploads(
      [{ path: 'src/App.tsx', content: 'agent new version' }],
      prevByPath,
      base,
    );

    expect(plan.collected).toEqual([
      { path: 'src/App.tsx', hash: h('agent new version'), content: 'agent new version' },
    ]);
  });

  it('dedups a file identical to the previous revision when no base is known (legacy behavior)', () => {
    // baseByPath null/undefined = scaffold-seeded sandbox / template remix /
    // rollback: whole tree is the output, dedup only against prev.
    const prevByPath = new Map([['a.ts', { hash: h('same'), source_revision: 'rev-old' }]]);
    const plan = planRevisionUploads([{ path: 'a.ts', content: 'same' }], prevByPath, null);

    expect(plan.collected).toEqual([{ path: 'a.ts', hash: h('same'), source_revision: 'rev-old' }]);
    expect(plan.carryPrev).toEqual([]);

    const noPrev = planRevisionUploads([{ path: 'a.ts', content: 'same' }], new Map(), undefined);
    expect(noPrev.collected).toEqual([{ path: 'a.ts', hash: h('same'), content: 'same' }]);
  });

  it('carries a file the USER added mid-run (absent from the sandbox and from the run-start base)', () => {
    const base = new Map([['src/App.tsx', h('base')]]);
    const prevByPath = new Map([
      ['src/App.tsx', { hash: h('base'), source_revision: 'rev-base' }],
      ['notes.md', { hash: h('user notes'), source_revision: 'rev-user' }], // added mid-run
    ]);
    const plan = planRevisionUploads(
      [{ path: 'src/App.tsx', content: 'base' }],
      prevByPath,
      base,
    );

    expect(plan.carryPrev).toEqual([prev('notes.md', 'user notes', 'rev-user')]);
    // and the untouched app file is carried, not uploaded
    expect(plan.collected).toEqual([{ path: 'src/App.tsx', hash: h('base'), source_revision: 'rev-base' }]);
  });

  it('does NOT carry a file the run deleted (present in base, absent from the tree)', () => {
    const base = new Map([['gone.ts', h('base'), ], ['keep.ts', h('k')]]);
    const prevByPath = new Map([
      ['gone.ts', { hash: h('base'), source_revision: 'rev-base' }],
      ['keep.ts', { hash: h('k'), source_revision: 'rev-base' }],
    ]);
    const plan = planRevisionUploads(
      [{ path: 'keep.ts', content: 'k' }],
      prevByPath,
      base,
    );

    expect(plan.carryPrev).toEqual([]);
    expect(plan.collected.map((c) => c.path)).toEqual(['keep.ts']);
  });

  it('returns no carryPrev when there is no run-start base (legacy whole-tree persist)', () => {
    const prevByPath = new Map([['notes.md', { hash: h('user notes'), source_revision: 'rev-user' }]]);
    const plan = planRevisionUploads([], prevByPath, null);
    expect(plan.carryPrev).toEqual([]);
    expect(plan.collected).toEqual([]);
  });
});
