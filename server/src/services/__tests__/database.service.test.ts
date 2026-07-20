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

// tenant_databases fixture: user-1 has TWO projects, each with its own row  
// simulates the exact scenario that exposed the cross-tenant leak.
const tenantDbRows = [
  { id: 'row-1', user_id: 'user-1', project_id: 'project-1', organization_id: null, schema_name: 'tenant_project1', status: 'active', error_message: null, created_at: new Date().toISOString() },
  { id: 'row-2', user_id: 'user-1', project_id: 'project-2', organization_id: null, schema_name: 'tenant_project2', status: 'active', error_message: null, created_at: new Date().toISOString() },
];

function makeQueryBuilder(table: string) {
  const filters: { field: string; op: string; value: unknown }[] = [];

  const builder: any = {
    select: () => builder,
    eq: (field: string, value: unknown) => { filters.push({ field, op: 'eq', value }); return builder; },
    is: (field: string, value: unknown) => { filters.push({ field, op: 'is', value }); return builder; },
    not: (field: string, _op: string, value: unknown) => { filters.push({ field, op: 'not', value }); return builder; },
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    update: () => builder,
    upsert: (rows: any[], opts: any) => { upsertCalls.push({ table, rows, opts }); return Promise.resolve({ data: rows, error: null }); },
    delete: (...a: any[]) => { deleteCalls.push({ table, args: a }); return builder; },
  };

  const resolve = () => {
    if (table !== 'tenant_databases') return { data: null, error: null };
    const matches = tenantDbRows.filter((row) =>
      filters.every((f) => {
        const rowVal = (row as any)[f.field];
        if (f.op === 'eq') return rowVal === f.value;
        if (f.op === 'is') return rowVal === f.value; // null-check emulation
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

describe('databaseService.getCredentials   VITE_DB_* secret sync', () => {
  it('upserts VITE_DB_API_URL and VITE_DB_ANON_KEY for the project', async () => {
    const creds = await databaseService.getCredentials('user-1', 'project-1');
    expect(creds).not.toBeNull();
    // api_url carries the tenant schema as a URL path segment   see
    // database.service.ts's getCredentials(): the header-based Accept-Profile
    // convention was error-prone (forgetting the header silently 404/406'd),
    // so the schema now lives in the URL itself and VPS5's nginx derives the
    // real header from it.
    expect(creds!.api_url).toBe('https://cloud.ecomgear.app/tenant_project1');

    // upsert is fired async (not awaited)   flush microtasks.
    await new Promise((r) => setImmediate(r));

    const secretsUpsert = upsertCalls.find((c) => c.table === 'project_secrets');
    expect(secretsUpsert).toBeTruthy();
    expect(secretsUpsert.opts).toEqual({ onConflict: 'project_id,key_name' });

    const keyNames = secretsUpsert.rows.map((r: any) => r.key_name).sort();
    expect(keyNames).toEqual(['VITE_DB_ANON_KEY', 'VITE_DB_API_URL', 'VITE_DB_SCHEMA', 'VITE_FUNCTIONS_API_URL']);

    // Functions live on the API server   never gen.ecomgear.dev, never the tenant DB host.
    const fnUrlRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_FUNCTIONS_API_URL');
    expect(fnUrlRow.key_value).toBe(process.env.ECOMGEAR_SERVER_URL?.replace(/\/$/, '') || 'https://api.ecomgear.dev');

    const apiUrlRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_DB_API_URL');
    expect(apiUrlRow.project_id).toBe('project-1');
    expect(apiUrlRow.key_value).toBe(creds!.api_url);

    const anonKeyRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_DB_ANON_KEY');
    expect(anonKeyRow.key_value).toBe(creds!.anon_key);
    expect(typeof anonKeyRow.key_value).toBe('string');
    expect(anonKeyRow.key_value.split('.')).toHaveLength(3); // header.body.sig JWT shape

    const schemaRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_DB_SCHEMA');
    expect(schemaRow.key_value).toBe(creds!.schema);
  });

  it('does not touch project_secrets when no projectId is given (legacy path)', async () => {
    await databaseService.getCredentials('user-1');
    await new Promise((r) => setImmediate(r));
    expect(upsertCalls.find((c) => c.table === 'project_secrets')).toBeUndefined();
  });
});

describe('databaseService.getCredentials   cross-tenant leak fix', () => {
  it('returns null for a project with no dedicated row, never another project\'s credentials', async () => {
    // user-1 owns project-1 (row-1) and project-2 (row-2). Requesting a THIRD
    // project with no row of its own must not fall back to a sibling
    // project's schema/anon-key   that would leak project-1/2's DB into
    // project-3's generated frontend code.
    const creds = await databaseService.getCredentials('user-1', 'project-3-has-no-db');
    expect(creds).toBeNull();
  });

  it('project-1 and project-2 each resolve to their own distinct schema', async () => {
    const creds1 = await databaseService.getCredentials('user-1', 'project-1');
    const creds2 = await databaseService.getCredentials('user-1', 'project-2');
    expect(creds1!.schema).toBe('tenant_project1');
    expect(creds2!.schema).toBe('tenant_project2');
    expect(creds1!.schema).not.toBe(creds2!.schema);
  });
});

describe('databaseService.deprovision   VITE_DB_* secret cleanup', () => {
  it('deletes VITE_DB_API_URL and VITE_DB_ANON_KEY for the project', async () => {
    await databaseService.deprovision('user-1', 'project-1');

    const secretsDelete = deleteCalls.find((c) => c.table === 'project_secrets');
    expect(secretsDelete).toBeTruthy();
  });
});
