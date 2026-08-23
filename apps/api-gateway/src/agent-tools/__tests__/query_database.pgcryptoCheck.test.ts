/**
 * Verifies findPgcryptoCalls -- this database has no extensions installed at
 * all (stock Postgres, not even pgcrypto), so ANY crypt/gen_salt/etc call is
 * a bug regardless of schema-qualification. Advisory-only, surfaced at
 * DDL-staging time in query_database.ts.
 *
 * Renamed from findUnqualifiedPgcryptoCalls: the original check only flagged
 * an UNQUALIFIED call, on the theory that qualifying it into `extensions.`
 * was the fix. It isn't -- the extension was never installed on this
 * instance, so a qualified call fails identically at runtime.
 */
import { describe, it, expect, vi } from 'vitest';

// query_database.ts -> database.service.ts -> config/database.js throws at
// module load if SUPABASE_URL/etc are unset -- not exercised by this pure
// regex helper, same stub pattern used elsewhere in this test suite.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { findPgcryptoCalls } from '../query_database.js';

describe('findPgcryptoCalls', () => {
  it('flags an unqualified call', () => {
    const sql = `SELECT crypt('a', gen_salt('bf'));`;
    const found = findPgcryptoCalls(sql);
    expect(found).toContain('crypt');
    expect(found).toContain('gen_salt');
  });

  it('also flags an extensions.-qualified call -- the extension is not installed at all', () => {
    const sql = `
      SELECT extensions.crypt('pw', extensions.gen_salt('bf')),
             extensions.digest('x', 'sha256'),
             extensions.hmac('x', 'key', 'sha256');
    `;
    const found = findPgcryptoCalls(sql);
    expect(found).toContain('crypt');
    expect(found).toContain('gen_salt');
    expect(found).toContain('digest');
    expect(found).toContain('hmac');
  });

  it('returns empty for SQL with no pgcrypto calls at all', () => {
    expect(findPgcryptoCalls('CREATE TABLE widgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid())')).toEqual([]);
  });

  it('flags multiple distinct pgcrypto functions in one statement', () => {
    const sql = `SELECT crypt('a', gen_salt('bf')), digest('b', 'sha256');`;
    const found = findPgcryptoCalls(sql);
    expect(found).toContain('crypt');
    expect(found).toContain('gen_salt');
    expect(found).toContain('digest');
  });
});
