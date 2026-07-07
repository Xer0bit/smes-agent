/**
 * Verifies the VITE_DB_API_URL/VITE_DB_ANON_KEY project_secrets sync added to
 * getCredentials() (write) and deprovision() (cleanup) in database.service.ts.
 * Drives the real service functions against a mocked Supabase client + pg pool
 * (no live hosted Postgres/Supabase available in this environment).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.TENANT_DB_HOST = 'db.internal';
process.env.TENANT_DB_SUPERUSER_PASSWORD = 'test-pass';
process.env.TENANT_DB_JWT_SECRET = 'test-secret';

const upsertCalls: any[] = [];
const deleteCalls: any[] = [];

function makeQueryBuilder(table: string, resolvedData: any = null) {
  const calls: Record<string, any[]> = {};
  const record = (name: string, args: any[]) => { (calls[name] ||= []).push(args); };

  const builder: any = {
    select: (...a: any[]) => { record('select', a); return builder; },
    eq: (...a: any[]) => { record('eq', a); return builder; },
    not: (...a: any[]) => { record('not', a); return builder; },
    in: (...a: any[]) => { record('in', a); return builder; },
    order: (...a: any[]) => { record('order', a); return builder; },
    limit: (...a: any[]) => { record('limit', a); return builder; },
    maybeSingle: () => Promise.resolve({ data: resolvedData, error: null }),
    single: () => Promise.resolve({ data: resolvedData, error: null }),
    update: (...a: any[]) => { record('update', a); return builder; },
    upsert: (rows: any[], opts: any) => { upsertCalls.push({ table, rows, opts }); return Promise.resolve({ data: rows, error: null }); },
    delete: (...a: any[]) => { deleteCalls.push({ table, args: a }); return builder; },
    then: (resolve: any) => resolve({ data: resolvedData, error: null }),
  };
  return builder;
}

vi.mock('../../config/database.js', () => ({
  supabase: {
    from: (table: string) => makeQueryBuilder(table, {
      id: 'row-1',
      user_id: 'user-1',
      project_id: 'project-1',
      organization_id: null,
      schema_name: 'tenant_project1',
      status: 'active',
      error_message: null,
      created_at: new Date().toISOString(),
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const pgQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    connect: () => Promise.resolve({ query: pgQuery, release: vi.fn() }),
  })),
}));

// Import AFTER mocks are registered.
const { databaseService } = await import('../database.service.js');

beforeEach(() => {
  upsertCalls.length = 0;
  deleteCalls.length = 0;
});

describe('databaseService.getCredentials — VITE_DB_* secret sync', () => {
  it('upserts VITE_DB_API_URL and VITE_DB_ANON_KEY for the project', async () => {
    const creds = await databaseService.getCredentials('user-1', 'project-1');
    expect(creds).not.toBeNull();
    expect(creds!.api_url).toBe('https://db.ecomgear.app');

    // upsert is fired async (not awaited) — flush microtasks.
    await new Promise((r) => setImmediate(r));

    const secretsUpsert = upsertCalls.find((c) => c.table === 'project_secrets');
    expect(secretsUpsert).toBeTruthy();
    expect(secretsUpsert.opts).toEqual({ onConflict: 'project_id,key_name' });

    const keyNames = secretsUpsert.rows.map((r: any) => r.key_name).sort();
    expect(keyNames).toEqual(['VITE_DB_ANON_KEY', 'VITE_DB_API_URL']);

    const apiUrlRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_DB_API_URL');
    expect(apiUrlRow.project_id).toBe('project-1');
    expect(apiUrlRow.key_value).toBe(creds!.api_url);

    const anonKeyRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_DB_ANON_KEY');
    expect(anonKeyRow.key_value).toBe(creds!.anon_key);
    expect(typeof anonKeyRow.key_value).toBe('string');
    expect(anonKeyRow.key_value.split('.')).toHaveLength(3); // header.body.sig JWT shape
  });

  it('does not touch project_secrets when no projectId is given (legacy path)', async () => {
    await databaseService.getCredentials('user-1');
    await new Promise((r) => setImmediate(r));
    expect(upsertCalls.find((c) => c.table === 'project_secrets')).toBeUndefined();
  });
});

describe('databaseService.deprovision — VITE_DB_* secret cleanup', () => {
  it('deletes VITE_DB_API_URL and VITE_DB_ANON_KEY for the project', async () => {
    await databaseService.deprovision('user-1', 'project-1');

    const secretsDelete = deleteCalls.find((c) => c.table === 'project_secrets');
    expect(secretsDelete).toBeTruthy();
  });
});
