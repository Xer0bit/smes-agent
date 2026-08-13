/**
 * Verifies databaseService.testDatabaseFunction -- the runtime-verification
 * helper added 2026-08-13 so the agent can test-call a SQL function it just
 * wrote inside a transaction that ALWAYS rolls back, catching bugs (like an
 * unqualified pgcrypto call) that CREATE FUNCTION itself never checks.
 * Mocked pg pool (no live Postgres in this environment) -- asserts on the
 * SEQUENCE of queries sent to the connection, since that's what proves the
 * rollback-always guarantee, not just the return value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.TENANT_DB_HOST = 'db.internal';
process.env.TENANT_DB_SUPERUSER_PASSWORD = 'test-pass';
process.env.TENANT_DB_JWT_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'https://api.ecomgear.dev';
process.env.SUPABASE_ANON_KEY = 'platform-anon-key';

const tenantDbRows = [
  { id: 'row-1', user_id: 'user-1', project_id: 'project-1', organization_id: null, schema_name: 'tenant_project1', status: 'active', error_message: null, created_at: new Date().toISOString() },
];

function makeQueryBuilder(table: string) {
  const filters: { field: string; op: string; value: unknown }[] = [];
  const builder: any = {
    select: () => builder,
    eq: (field: string, value: unknown) => { filters.push({ field, op: 'eq', value }); return builder; },
    is: () => builder,
    not: (field: string, _op: string, value: unknown) => { filters.push({ field, op: 'not', value }); return builder; },
    order: () => builder,
    limit: () => builder,
  };
  const resolve = () => {
    if (table !== 'tenant_databases') return { data: null, error: null };
    const matches = tenantDbRows.filter((row) =>
      filters.every((f) => {
        const rowVal = (row as any)[f.field];
        if (f.op === 'eq') return rowVal === f.value;
        if (f.op === 'not') return rowVal !== f.value;
        return true;
      })
    );
    return { data: matches[0] ?? null, error: null };
  };
  builder.maybeSingle = () => Promise.resolve(resolve());
  builder.single = () => Promise.resolve(resolve());
  builder.then = (fulfill: any) => fulfill(resolve());
  return builder;
}

vi.mock('../../config/database.js', () => ({
  supabase: { from: (table: string) => makeQueryBuilder(table) },
}));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Queued responses/behavior per query call -- lets each test script exactly
// what the mocked connection does for SET ROLE / BEGIN / SET LOCAL / the
// actual function call / ROLLBACK / RESET ROLE, in order.
let queryLog: string[] = [];
let functionCallShouldThrow: Error | null = null;
const pgQuery = vi.fn().mockImplementation((sql: string) => {
  queryLog.push(sql);
  if (sql.startsWith('SELECT * FROM') && functionCallShouldThrow) {
    return Promise.reject(functionCallShouldThrow);
  }
  if (sql.startsWith('SELECT * FROM')) {
    return Promise.resolve({ rows: [{ user_id: 'u-1', session_token: 'tok' }] });
  }
  return Promise.resolve({ rows: [] });
});
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    connect: () => Promise.resolve({ query: pgQuery, release: vi.fn() }),
  })),
}));

const { databaseService } = await import('../database.service.js');

beforeEach(() => {
  queryLog = [];
  functionCallShouldThrow = null;
  pgQuery.mockClear();
});

describe('databaseService.testDatabaseFunction', () => {
  it('runs the function inside BEGIN/ROLLBACK and returns ok:true on success', async () => {
    const result = await databaseService.testDatabaseFunction(
      'user-1', 'register_and_login', { p_email: 'test@example.com', p_password: 'x' }, 'project-1',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ user_id: 'u-1', session_token: 'tok' }]);

    // Rollback-always guarantee: BEGIN must appear, ROLLBACK must appear,
    // COMMIT must never appear -- this is a test, not a real call.
    expect(queryLog.some((q) => q === 'BEGIN')).toBe(true);
    expect(queryLog.some((q) => q === 'ROLLBACK')).toBe(true);
    expect(queryLog.some((q) => q === 'COMMIT')).toBe(false);

    // Named-parameter call syntax, scoped to the tenant schema.
    const callQuery = queryLog.find((q) => q.startsWith('SELECT * FROM'));
    expect(callQuery).toContain('register_and_login(p_email := $1, p_password := $2)');
  });

  it('returns ok:false with the real error message when the function throws, and STILL rolls back', async () => {
    functionCallShouldThrow = new Error('function extensions.gen_random_bytes(integer) does not exist');
    const result = await databaseService.testDatabaseFunction(
      'user-1', 'register_and_login', { p_email: 'test@example.com', p_password: 'x' }, 'project-1',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('gen_random_bytes');

    // The whole point: even on failure, this is rolled back, not left dangling.
    expect(queryLog.some((q) => q === 'ROLLBACK')).toBe(true);
  });

  it('rejects an invalid function name before ever touching the connection', async () => {
    await expect(
      databaseService.testDatabaseFunction('user-1', 'drop table users; --', {}, 'project-1'),
    ).rejects.toThrow('Invalid function name');
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid argument name before ever touching the connection', async () => {
    await expect(
      databaseService.testDatabaseFunction('user-1', 'register_and_login', { 'bad; drop table users': 'x' }, 'project-1'),
    ).rejects.toThrow('Invalid argument name');
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('throws "No active database" when no tenant DB is provisioned for the project', async () => {
    await expect(
      databaseService.testDatabaseFunction('user-1', 'register_and_login', {}, 'project-does-not-exist'),
    ).rejects.toThrow('No active database');
  });
});
