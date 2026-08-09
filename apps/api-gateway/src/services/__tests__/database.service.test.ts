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
process.env.SUPABASE_URL = 'https://api.ecomgear.dev';
process.env.SUPABASE_ANON_KEY = 'platform-anon-key';

const upsertCalls: any[] = [];
const deleteCalls: any[] = [];

// tenant_databases fixture: user-1 has TWO projects, each with its own row  
// simulates the exact scenario that exposed the cross-tenant leak.
const tenantDbRows = [
  { id: 'row-1', user_id: 'user-1', project_id: 'project-1', organization_id: null, schema_name: 'tenant_project1', status: 'active', error_message: null, created_at: new Date().toISOString() },
  { id: 'row-2', user_id: 'user-1', project_id: 'project-2', organization_id: null, schema_name: 'tenant_project2', status: 'active', error_message: null, created_at: new Date().toISOString() },
];

// Mutable per-test fixture for the project_secrets table, used by
// buildProjectEnvSecrets()'s stale-value-override regression tests below.
let projectSecretsRows: { project_id: string; key_name: string; key_value: string }[] = [];

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
    upsert: (data: any, opts: any) => {
      // provision() upserts a single row object; getCredentials() upserts an
      // array of secret rows. Normalize so both shapes work.
      const rows = Array.isArray(data) ? data : [data];
      upsertCalls.push({ table, rows, opts });
      // provision() chains .select().single() on the upsert result (needs the
      // real row back); getCredentials()/deprovision() just await it directly.
      // Support both without diverging behavior for either.
      const result = { data: rows, error: null };
      const upsertResult: any = {
        select: () => upsertResult,
        single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (fulfill: any) => fulfill(result),
      };
      return upsertResult;
    },
    delete: (...a: any[]) => { deleteCalls.push({ table, args: a }); return builder; },
  };

  const resolve = () => {
    if (table === 'project_secrets') {
      const matches = projectSecretsRows.filter((row) =>
        filters.every((f) => {
          const rowVal = (row as any)[f.field];
          if (f.op === 'eq') return rowVal === f.value;
          return true;
        })
      );
      // buildProjectEnvSecrets() awaits the plain SELECT (no .single()/
      // .maybeSingle()), so `data` must be the array, not a single row.
      return { data: matches, error: null };
    }
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
const { databaseService, buildProjectEnvSecrets } = await import('../database.service.js');

beforeEach(() => {
  upsertCalls.length = 0;
  deleteCalls.length = 0;
  projectSecretsRows = [];
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

    // Functions execute on VPS5 (the tenant function-runner), reached through
    // the same tenant-scoped cloud.ecomgear.app path as the DB itself   never
    // api.ecomgear.dev, which stays reserved for EcomGear's own platform API.
    // (Stale assertion fixed: this used to expect ECOMGEAR_SERVER_URL/api.ecomgear.dev,
    // which was the wrong host and silently 404'd every generated app's function calls.)
    const fnUrlRow = secretsUpsert.rows.find((r: any) => r.key_name === 'VITE_FUNCTIONS_API_URL');
    expect(fnUrlRow.key_value).toBe(`${creds!.api_url}/functions`);

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

// Regression test for a real incident: every generated app's login/signup
// function is told (app-builder.prompt.ts) to hash passwords via pgcrypto's
// extensions.crypt/gen_salt, but provisioning never granted USAGE on the
// shared `extensions` schema   so every one of the ~53 tenants provisioned
// before this fix hit "permission denied for schema extensions" the first
// time anyone logged in. The in-app AI agent couldn't fix it itself (its own
// DB role has no GRANT rights on a schema it doesn't own), so this has to be
// right at provisioning time, for every tenant, forever.
// Regression test for the class of bug the extensions-schema incident was an
// instance of: a function's own code can reference a table/RPC that was never
// granted to this project's DB roles (created after provisioning, or simply
// missed), and the only way to find out used to be a real user's crash
// report. ensureFunctionDbAccess() statically scans db.select/insert/update/
// delete/rpc calls and self-heals missing grants before write_edge_function
// ever tells the agent the function is ready.
describe('databaseService.ensureFunctionDbAccess   permission preflight for new functions', () => {
  it('grants SELECT/INSERT/UPDATE/DELETE + EXECUTE for tables/RPCs the code references but the DB roles were never granted', async () => {
    const executed: string[] = [];
    pgQuery.mockImplementation((sql: string, params?: unknown[]) => {
      executed.push(sql);
      if (sql.includes('FROM information_schema.tables')) {
        return Promise.resolve({ rows: [{ 1: 1 }] }); // table exists
      }
      if (sql.includes('has_table_privilege')) {
        return Promise.resolve({ rows: [{ ok: false }] }); // exists, but never granted
      }
      if (sql.includes('FROM pg_proc')) {
        return Promise.resolve({ rows: [{ oid: '12345' }] }); // rpc exists
      }
      if (sql.includes('has_function_privilege')) {
        return Promise.resolve({ rows: [{ ok: false }] }); // exists, but never granted
      }
      if (sql.includes('has_schema_privilege')) {
        return Promise.resolve({ rows: [{ ok: false }] }); // extensions USAGE missing
      }
      return Promise.resolve({ rows: [] });
    });

    try {
      const code = `
        const orders = await db.select('orders', { id });
        const hashed = await db.rpc('rpc_hash_password', { password_to_hash: 'x' });
      `;
      const notes = await databaseService.ensureFunctionDbAccess('user-1', 'project-1', code);

      expect(notes.some((n) => n.includes('extensions'))).toBe(true);
      expect(notes.some((n) => n.includes('orders'))).toBe(true);
      expect(notes.some((n) => n.includes('rpc_hash_password'))).toBe(true);

      expect(executed.some((sql) => sql.includes('GRANT USAGE ON SCHEMA extensions'))).toBe(true);
      expect(executed.some((sql) => sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_project1"."orders"'))).toBe(true);
      expect(executed.some((sql) => sql.includes('GRANT EXECUTE ON FUNCTION "tenant_project1"."rpc_hash_password"'))).toBe(true);
    } finally {
      pgQuery.mockReset();
      pgQuery.mockResolvedValue({ rows: [] });
    }
  });

  it('does nothing when the code references no tables/RPCs, or everything is already granted', async () => {
    pgQuery.mockClear();
    const notes = await databaseService.ensureFunctionDbAccess('user-1', 'project-1', 'return { ok: true };');
    expect(notes).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('databaseService.provision   extensions schema access for password hashing', () => {
  it('grants USAGE ON SCHEMA extensions to the anon, service, and owner roles', async () => {
    pgQuery.mockClear();
    await databaseService.provision('user-ext', 'org-ext', 'project-ext');

    const schema = 'tenant_' + 'project-ext'.replace(/-/g, '').slice(0, 16);
    const grantCall = pgQuery.mock.calls.find(([sql]: [string]) =>
      typeof sql === 'string' && sql.includes('GRANT USAGE ON SCHEMA extensions')
    );

    expect(grantCall).toBeTruthy();
    const sql: string = grantCall![0];
    expect(sql).toContain(`${schema}_anon`);
    expect(sql).toContain(`${schema}_service`);
    expect(sql).toContain(`${schema}_owner`);
  });
});

describe('buildProjectEnvSecrets   platform-managed keys always win over stale stored rows', () => {
  // Regression test for a real production bug (2026-08-05 stability review):
  // a stale project_secrets row for a platform-managed key (VITE_DB_API_URL,
  // VITE_FUNCTIONS_API_URL, VITE_SUPABASE_URL, etc.) used to be returned
  // FOREVER instead of the freshly-derived correct value, because the old
  // "user secrets win on collision" rule applied indiscriminately to every
  // key already sitting in the table -- including these six, which the
  // platform itself owns and re-derives every call. Confirmed live: one
  // project's VITE_FUNCTIONS_API_URL stayed pointed at the wrong host despite
  // repeated Sync-button clicks and agent runs, because nothing in that path
  // ever actually preferred the fresh value over the stale stored one.
  it('ignores a stale stored VITE_FUNCTIONS_API_URL and returns the freshly-derived value', async () => {
    projectSecretsRows = [
      { project_id: 'project-1', key_name: 'VITE_FUNCTIONS_API_URL', key_value: 'https://api.ecomgear.dev' },
      { project_id: 'project-1', key_name: 'VITE_DB_API_URL', key_value: 'https://cloud.ecomgear.app/tenant_project1' },
    ];

    const secrets = await buildProjectEnvSecrets('user-1', 'project-1');
    const fnUrl = secrets.find((s) => s.key_name === 'VITE_FUNCTIONS_API_URL');

    expect(fnUrl).toBeTruthy();
    expect(fnUrl!.key_value).toBe('https://cloud.ecomgear.app/tenant_project1/functions');
    expect(fnUrl!.key_value).not.toBe('https://api.ecomgear.dev');
  });

  it('still lets a genuine user-set secret (not one of the six platform-managed keys) win as usual', async () => {
    projectSecretsRows = [
      { project_id: 'project-1', key_name: 'STRIPE_SECRET_KEY', key_value: 'sk_test_user_set_value' },
    ];

    const secrets = await buildProjectEnvSecrets('user-1', 'project-1');
    const stripeKey = secrets.find((s) => s.key_name === 'STRIPE_SECRET_KEY');

    expect(stripeKey).toBeTruthy();
    expect(stripeKey!.key_value).toBe('sk_test_user_set_value');
  });

  it('returns the correct platform-managed values on a project with no stored rows at all', async () => {
    projectSecretsRows = [];
    const secrets = await buildProjectEnvSecrets('user-1', 'project-1');
    const keyNames = secrets.map((s) => s.key_name).sort();
    expect(keyNames).toEqual([
      'VITE_DB_ANON_KEY', 'VITE_DB_API_URL', 'VITE_DB_SCHEMA', 'VITE_FUNCTIONS_API_URL',
      'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL',
    ]);
  });
});
