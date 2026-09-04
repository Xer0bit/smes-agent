/**
 * A revision's manifest is the project's source of truth. An entry pointing at
 * a file that was never uploaded resolves to a 404 for every later reader, and
 * a revision refused outright leaves the project with no manifest-v1 HEAD at
 * all -- which on 2026-09-01 silently disabled both HEAD-materialised sandboxes
 * and changeset pushes for a whole day, because of one 8.2 MiB JPEG.
 */
import { describe, expect, it } from 'vitest';
import { exceedsObjectLimit, reconcileManifestAfterFailures } from '../agentRevisionPersist.service.js';

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
