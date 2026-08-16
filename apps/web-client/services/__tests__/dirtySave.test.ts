import { describe, expect, it } from 'vitest';
import { selectDirtySave } from '../dirtySave';
import type { WorkspaceFile } from '@/eCG/Workspace/types';

// M1: a client save must upload ONLY user-edited files and carry everything
// else by manifest reference from the head. The old behaviour -- serializing
// the tab's entire workspace map -- is how a stale tab republished broken
// code over a newer fix (2026-08-16 05:27 clobber incident).

const wf = (path: string, isDirty: boolean): WorkspaceFile => ({
  path,
  content: `content of ${path}`,
  isDirty,
  lastModified: new Date(),
  type: 'tsx',
});

describe('selectDirtySave', () => {
  it('uploads only dirty files, carries the clean ones', () => {
    const { dirtyFiles, carryPaths } = selectDirtySave([
      wf('src/App.tsx', false),
      wf('src/pages/Home.tsx', true),
      wf('src/components/Header.tsx', false),
    ]);
    expect(dirtyFiles.map(f => f.path)).toEqual(['src/pages/Home.tsx']);
    expect([...carryPaths].sort()).toEqual(['src/App.tsx', 'src/components/Header.tsx']);
  });

  it('returns no dirty files for an all-clean workspace (save becomes a no-op)', () => {
    const { dirtyFiles } = selectDirtySave([wf('a.tsx', false), wf('b.tsx', false)]);
    expect(dirtyFiles).toHaveLength(0);
  });

  it('merges pending lazy paths into the carry set', () => {
    const { carryPaths } = selectDirtySave(
      [wf('a.tsx', false)],
      new Set(['lazy/unloaded1.tsx', 'lazy/unloaded2.tsx']),
    );
    expect(carryPaths.has('lazy/unloaded1.tsx')).toBe(true);
    expect(carryPaths.has('lazy/unloaded2.tsx')).toBe(true);
    expect(carryPaths.has('a.tsx')).toBe(true);
  });

  it('a dirty file wins over its own lazy-carry entry', () => {
    const { dirtyFiles, carryPaths } = selectDirtySave(
      [wf('src/edited.tsx', true)],
      new Set(['src/edited.tsx']),
    );
    expect(dirtyFiles.map(f => f.path)).toEqual(['src/edited.tsx']);
    expect(carryPaths.has('src/edited.tsx')).toBe(false);
  });

  it('a deleted file appears in neither list, so it drops from the manifest', () => {
    // Deletion = absence from the workspace. Not uploaded, not carried.
    const { dirtyFiles, carryPaths } = selectDirtySave([wf('kept.tsx', false)]);
    expect(dirtyFiles.find(f => f.path === 'deleted.tsx')).toBeUndefined();
    expect(carryPaths.has('deleted.tsx')).toBe(false);
    expect(carryPaths.has('kept.tsx')).toBe(true);
  });
});
