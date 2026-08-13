/**
 * Verifies findUnqualifiedPgcryptoCalls -- the static check added 2026-08-13
 * after a real incident: register_and_login correctly qualified
 * extensions.crypt/extensions.gen_salt but called a bare gen_random_bytes(32)
 * two lines later, which failed at runtime ("function ... does not exist")
 * since pgcrypto isn't on this role's search_path. Advisory-only, surfaced at
 * DDL-staging time in query_database.ts before confirm_database_change runs it.
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

import { findUnqualifiedPgcryptoCalls } from '../query_database.js';

describe('findUnqualifiedPgcryptoCalls', () => {
  it('flags the exact incident pattern: qualified crypt/gen_salt, unqualified gen_random_bytes', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION register_and_login(p_email text, p_password text)
      RETURNS TABLE(session_token text) AS $$
      BEGIN
        hashed := extensions.crypt(p_password, extensions.gen_salt('bf'));
        new_token_raw := encode(gen_random_bytes(32), 'hex');
      END;
      $$ LANGUAGE plpgsql;
    `;
    const found = findUnqualifiedPgcryptoCalls(sql);
    expect(found).toContain('gen_random_bytes');
    expect(found).not.toContain('crypt');
    expect(found).not.toContain('gen_salt');
  });

  it('returns empty for fully-qualified pgcrypto calls', () => {
    const sql = `
      SELECT extensions.crypt('pw', extensions.gen_salt('bf')),
             extensions.digest('x', 'sha256'),
             extensions.hmac('x', 'key', 'sha256');
    `;
    expect(findUnqualifiedPgcryptoCalls(sql)).toEqual([]);
  });

  it('returns empty for SQL with no pgcrypto calls at all', () => {
    expect(findUnqualifiedPgcryptoCalls('CREATE TABLE widgets (id uuid PRIMARY KEY)')).toEqual([]);
  });

  it('flags multiple distinct unqualified functions', () => {
    const sql = `SELECT crypt('a', gen_salt('bf')), digest('b', 'sha256');`;
    const found = findUnqualifiedPgcryptoCalls(sql);
    expect(found).toContain('crypt');
    expect(found).toContain('gen_salt');
    expect(found).toContain('digest');
  });
});
