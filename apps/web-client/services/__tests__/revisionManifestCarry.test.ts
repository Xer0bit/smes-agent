import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lazy editor (2026-08-10): a save fired while lazily-unloaded files are still
// pending must carry their previous-manifest entries VERBATIM into the new
// revision -- no fetch, no re-hash, no upload -- and must NOT resurrect a
// path the caller excluded (deleted files). Getting this wrong silently drops
// or corrupts every file the user never opened, so it gets a real test.

const sha256Hex = async (content: string): Promise<string> => {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

const insertSingleMock = vi.fn();
const prevRevQueryMock = vi.fn();
const updateMock = vi.fn();
const updateEqMock = vi.fn();
const uploadMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: insertSingleMock })) })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          neq: vi.fn(() => ({
            order: vi.fn(() => ({ limit: prevRevQueryMock })),
          })),
        })),
      })),
      update: updateMock,
    })),
  },
}));

vi.mock('../storageService', () => ({
  storageService: { saveProjectFiles: uploadMock },
}));

import { revisionService } from '../revisionService';

describe('createRevision manifest-carry (lazy editor)', () => {
  let hashA: string, hashB: string, hashC: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    hashA = await sha256Hex('old-a');
    hashB = await sha256Hex('old-b');
    hashC = await sha256Hex('old-c');
    insertSingleMock.mockResolvedValue({ data: { id: 'rev-new' }, error: null });
    prevRevQueryMock.mockResolvedValue({
      data: [{
        id: 'rev-old',
        generated_files: {
          format: 'manifest-v1',
          files: [
            { path: 'a.tsx', hash: hashA, source_revision: 'rev-old' },
            { path: 'b.tsx', hash: hashB, source_revision: 'rev-older' },
            { path: 'c.tsx', hash: hashC, source_revision: 'rev-old' },
          ],
        },
      }],
    });
    updateMock.mockImplementation(() => ({ eq: updateEqMock }));
    updateEqMock.mockResolvedValue({ error: null });
    uploadMock.mockResolvedValue({ success: true });
  });

  const finalManifest = () => {
    // last update() call carries the lean manifest
    const arg = updateMock.mock.calls.at(-1)?.[0];
    return arg?.generated_files;
  };

  it('carries unloaded entries verbatim and uploads only the changed file', async () => {
    await revisionService.createRevision({
      project_id: 'p1',
      prompt: 'save',
      generated_code: '',
      generated_files: { files: [{ path: 'a.tsx', content: 'CHANGED' }] },
      user_id: 'u1',
      carry_paths: new Set(['b.tsx', 'c.tsx']),
    });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][2]).toEqual([{ path: 'a.tsx', content: 'CHANGED' }]);

    const manifest = finalManifest();
    expect(manifest.files).toHaveLength(3);
    const byPath = new Map(manifest.files.map((f: any) => [f.path, f]));
    expect(byPath.get('a.tsx')).toMatchObject({ source_revision: 'rev-new' });
    // Carried VERBATIM, including the deduped older source revision
    expect(byPath.get('b.tsx')).toEqual({ path: 'b.tsx', hash: hashB, source_revision: 'rev-older' });
    expect(byPath.get('c.tsx')).toEqual({ path: 'c.tsx', hash: hashC, source_revision: 'rev-old' });
    // file_count reflects the FULL manifest, not just provided files
    expect(updateMock.mock.calls.at(-1)?.[0].file_count).toBe(3);
  });

  it('does not resurrect a path excluded from carry_paths (deleted file)', async () => {
    await revisionService.createRevision({
      project_id: 'p1',
      prompt: 'save',
      generated_code: '',
      generated_files: { files: [{ path: 'a.tsx', content: 'CHANGED' }] },
      user_id: 'u1',
      carry_paths: new Set(['b.tsx']), // c.tsx deleted -> excluded
    });

    const manifest = finalManifest();
    const paths = manifest.files.map((f: any) => f.path).sort();
    expect(paths).toEqual(['a.tsx', 'b.tsx']);
  });

  it('provided content wins when a path is both provided and carried', async () => {
    await revisionService.createRevision({
      project_id: 'p1',
      prompt: 'save',
      generated_code: '',
      generated_files: { files: [{ path: 'b.tsx', content: 'NEW-B' }] },
      user_id: 'u1',
      carry_paths: new Set(['b.tsx', 'a.tsx']),
    });

    const manifest = finalManifest();
    const bEntries = manifest.files.filter((f: any) => f.path === 'b.tsx');
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0].source_revision).toBe('rev-new');
  });

  it('unchanged provided file still dedups against previous revision (no upload)', async () => {
    await revisionService.createRevision({
      project_id: 'p1',
      prompt: 'save',
      generated_code: '',
      generated_files: { files: [{ path: 'a.tsx', content: 'old-a' }] },
      user_id: 'u1',
      carry_paths: new Set(['b.tsx', 'c.tsx']),
    });

    expect(uploadMock).not.toHaveBeenCalled();
    const byPath = new Map(finalManifest().files.map((f: any) => [f.path, f]));
    expect(byPath.get('a.tsx')).toMatchObject({ source_revision: 'rev-old', hash: hashA });
  });
});
