/**
 * Static preflight on staged SQL.
 *
 * Every blocking/warning case below is taken from a statement that actually
 * reached a human's confirm button on 2026-08-22 and then failed. The false
 * positive tests matter just as much: a preflight that refuses valid SQL stops
 * real work, which is worse than the confirm-time failure it replaces.
 */
import { describe, it, expect } from 'vitest';
import { preflightSql, maskSqlLiterals, findUnqualifiedPgcryptoCalls } from '../sqlPreflight.js';

describe('blocking: public schema', () => {
  it('blocks the exact statement that failed twice', () => {
    const r = preflightSql('CREATE OR REPLACE FUNCTION public.create_secure_user(p_full_name text) RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;');
    expect(r.blocking.map((b) => b.code)).toContain('public_schema');
    expect(r.blocking[0].message).toMatch(/permission denied for schema public/);
  });

  it('blocks a public-qualified table reference too', () => {
    expect(preflightSql('SELECT * FROM public.users;').blocking).toHaveLength(1);
  });

  it('does NOT block a policy merely NAMED with a public_ prefix', () => {
    // The real statement: CREATE POLICY "public_read_categories" ... -- the
    // name contains "public" but qualifies nothing.
    const sql = 'DROP POLICY IF EXISTS "public_read_categories" ON categories; CREATE POLICY "public_read_categories" ON categories FOR SELECT USING (true);';
    expect(preflightSql(sql).blocking).toHaveLength(0);
  });

  it('does NOT block the word public inside a string or comment', () => {
    expect(preflightSql("-- put this in public.foo later\nSELECT 1;").blocking).toHaveLength(0);
    expect(preflightSql("INSERT INTO notes (body) VALUES ('see public.users');").blocking).toHaveLength(0);
  });

  it('does NOT block unqualified DDL, which is the correct form', () => {
    expect(preflightSql('CREATE TABLE orders (id uuid PRIMARY KEY);').blocking).toHaveLength(0);
  });
});

describe('warning: unqualified pgcrypto', () => {
  it('warns on the call that broke registration in production', () => {
    const r = preflightSql("SELECT crypt('pw', gen_salt('bf'));");
    expect(r.warnings.map((w) => w.code)).toContain('unqualified_pgcrypto');
    expect(r.blocking).toHaveLength(0); // a warning, never a block
  });

  it('stays quiet when properly qualified', () => {
    const r = preflightSql("SELECT extensions.crypt('pw', extensions.gen_salt('bf'));");
    expect(r.warnings.filter((w) => w.code === 'unqualified_pgcrypto')).toHaveLength(0);
  });

  it('ignores the function name inside a string literal', () => {
    const r = preflightSql("INSERT INTO logs (msg) VALUES ('called crypt(x) once');");
    expect(r.warnings.filter((w) => w.code === 'unqualified_pgcrypto')).toHaveLength(0);
  });
});

describe('warning: CREATE POLICY without a drop', () => {
  it('warns on the statement that hit "already exists"', () => {
    const r = preflightSql('CREATE POLICY "public_read_categories" ON categories FOR SELECT USING (true);');
    expect(r.warnings.map((w) => w.code)).toContain('policy_no_drop');
  });

  it('stays quiet when the policy is dropped first', () => {
    const sql = 'DROP POLICY IF EXISTS "public_read_categories" ON categories;\nCREATE POLICY "public_read_categories" ON categories FOR SELECT USING (true);';
    expect(preflightSql(sql).warnings.filter((w) => w.code === 'policy_no_drop')).toHaveLength(0);
  });
});

describe('literal masking', () => {
  it('preserves length so offsets are unchanged', () => {
    const sql = "SELECT 'abc' FROM t;";
    expect(maskSqlLiterals(sql)).toHaveLength(sql.length);
  });

  it('masks dollar-quoted function bodies', () => {
    const masked = maskSqlLiterals("CREATE FUNCTION f() AS $$ SELECT public.x; $$ LANGUAGE sql;");
    expect(masked).not.toMatch(/public\.x/);
  });
});

describe('clean SQL passes untouched', () => {
  it('reports nothing for ordinary correct DDL', () => {
    const r = preflightSql('CREATE TABLE IF NOT EXISTS carts (id uuid PRIMARY KEY, total numeric);');
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('keeps one implementation of the pgcrypto scan', () => {
    expect(findUnqualifiedPgcryptoCalls("SELECT crypt('a','b')")).toEqual(['crypt']);
  });
});
