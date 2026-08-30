/**
 * The case this exists for: a delete that removed nothing and said nothing.
 *
 * PostgREST returns `{ error: null }` for a DELETE matching zero rows, so the
 * only way to tell a real deletion from an RLS-blocked one is to look again.
 * The test that matters most is the survivor case throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const maybeSingle = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  },
}));

import { confirmRowDeleted, DeletionNotConfirmedError } from '../confirmDeletion';

beforeEach(() => vi.clearAllMocks());

describe('confirming a delete', () => {
  it('reports gone when the row is absent', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(confirmRowDeleted('projects', 'p1')).resolves.toBe('gone');
  });

  it('THROWS when the row survived — the silent-failure case', async () => {
    // This is the RLS-blocked delete: no error, row still there.
    maybeSingle.mockResolvedValue({ data: { id: 'p1' }, error: null });
    await expect(confirmRowDeleted('projects', 'p1')).rejects.toBeInstanceOf(DeletionNotConfirmedError);
  });

  it('says nothing was changed, so the user does not retry blindly', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'p1' }, error: null });
    await expect(confirmRowDeleted('projects', 'p1')).rejects.toThrow(/still there/i);
    await expect(confirmRowDeleted('projects', 'p1')).rejects.toThrow(/[Nn]othing was changed/);
  });
});

describe('when verification itself fails', () => {
  it('returns unverified rather than claiming either outcome', async () => {
    // A read error cannot distinguish "deleted" from "blocked". Asserting
    // failure here would be exactly as wrong as asserting success.
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'network' } });
    await expect(confirmRowDeleted('projects', 'p1')).resolves.toBe('unverified');
  });

  it('does not throw on a read error even though data is absent', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(confirmRowDeleted('projects', 'p1')).resolves.not.toThrow;
  });
});

describe('addressing the right row', () => {
  it('supports a non-default id column', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(confirmRowDeleted('project_members', 'u1', 'user_id')).resolves.toBe('gone');
  });

  it('carries the table and id on the error for logging', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'o9' }, error: null });
    await confirmRowDeleted('organizations', 'o9').catch((e) => {
      expect(e.table).toBe('organizations');
      expect(e.id).toBe('o9');
    });
  });
});
