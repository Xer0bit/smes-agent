import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real incident (2026-08-04): the local dev frontend's Supabase URL silently
// pointed at production (a committed .env.local override) while the local
// backend/agent-loop wrote projects to local Supabase. When the agent
// finished, revisionService.createRevision() tried to save against
// production, where the project_id didn't exist -- RLS rejected the insert,
// and the failure went nowhere but a browser console.error. A real, paid
// agent run ($0.71, 609K tokens, 32 files) looked like it produced nothing.
//
// This test guards the contract that made the fix possible: createRevision
// must THROW on a failed insert, never swallow it, so every caller's
// .catch() (Editor.tsx's onFilesGenerated, which now also shows a toast)
// actually fires instead of silently doing nothing.

const insertMock = vi.fn();
const selectMock = vi.fn();
const singleMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: insertMock,
    })),
  },
}));

import { revisionService } from '../revisionService';

describe('revisionService.createRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReturnValue({ select: selectMock });
    selectMock.mockReturnValue({ single: singleMock });
  });

  it('throws when the insert is rejected (e.g. RLS: project not found in this Supabase)', async () => {
    singleMock.mockResolvedValue({
      data: null,
      error: { message: 'new row violates row-level security policy for table "revisions"' },
    });

    await expect(
      revisionService.createRevision({
        project_id: 'does-not-exist-here',
        prompt: 'test',
        generated_code: '',
        generated_files: { files: [{ path: 'App.tsx', content: 'x' }] },
        user_id: 'user-1',
      }),
    ).rejects.toBeTruthy();
  });

  it('resolves with the revision id on success', async () => {
    singleMock.mockResolvedValue({ data: { id: 'rev-123' }, error: null });

    const id = await revisionService.createRevision({
      project_id: 'real-project',
      prompt: 'test',
      generated_code: '',
      user_id: 'user-1',
    });

    expect(id).toBe('rev-123');
  });
});
