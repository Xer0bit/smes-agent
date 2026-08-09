/**
 * One-time RLS backfill for tenant tables created before enableRlsOnNewTables()
 * landed in database.service.ts. Those tables still have RLS disabled and are
 * still exposed via the public anon key + PostgREST (see the incident this
 * fixes: nginx has no access control in front of PostgREST by design -- the
 * anon key is meant to be public, client-embedded, same as a Supabase anon
 * key -- so a flat GRANT SELECT with no RLS is a real, internet-reachable
 * data exposure, not theoretical).
 *
 * Policy: deny-all. Enables RLS with zero policies on every table that
 * doesn't have it yet, across every tenant schema. This does NOT affect the
 * schema owner's own access: the `_service`/`_owner` roles that own these
 * tables bypass RLS as table owner (Postgres default, FORCE ROW LEVEL
 * SECURITY is never set) -- only the public anon role loses its previously-
 * implicit read access. Any table a generated app genuinely needs public-
 * readable will need an explicit policy added afterward; that's a conscious,
 * accepted tradeoff (see this session's incident-response decision), not an
 * oversight of this script.
 *
 * A table can be owned by any of three roles depending on how it was
 * created (agent tool -> service role; direct psql/db_url connection ->
 * owner role) -- see database.service.ts's `runQuery()` SET ROLE and the
 * "db_url intentionally omitted" comment on the owner role's direct-connect
 * path. This script attempts the RLS-enable DO block as the bare superuser
 * connection, then via SET ROLE to _owner, then via SET ROLE to _service,
 * for each schema -- each attempt safely no-ops (via EXCEPTION WHEN
 * insufficient_privilege) on any table it doesn't own, so running all three
 * is safe and maximizes coverage without needing to know in advance which
 * role owns which table.
 *
 * Dry-run by default. Pass --apply to actually enable RLS. Must run from a
 * host that already has working TENANT_DB_* + SUPABASE_* env (VPS1 or VPS3
 * in production -- this dev machine's IP is blocked by VPS5's pg_hba.conf
 * allowlist, confirmed earlier this session).
 *
 * Run with: npx tsx server/scripts/backfill-rls-existing-tables.ts [--apply]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

const APPLY = process.argv.includes('--apply');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TENANT_DB_HOST = process.env.TENANT_DB_HOST || '';
const TENANT_DB_PORT = parseInt(process.env.TENANT_DB_PORT || '5432', 10);
const TENANT_DB_SUPERUSER = process.env.TENANT_DB_SUPERUSER || 'ecg_provisioner';
const TENANT_DB_SUPERUSER_PASSWORD = process.env.TENANT_DB_SUPERUSER_PASSWORD || '';
const TENANT_DB_NAME = process.env.TENANT_DB_NAME || 'ecg_tenants';
const TENANT_DB_SSL = process.env.TENANT_DB_SSL === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FAIL: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required.');
  process.exit(1);
}
if (!TENANT_DB_HOST || !TENANT_DB_SUPERUSER_PASSWORD) {
  console.error('FAIL: TENANT_DB_HOST and TENANT_DB_SUPERUSER_PASSWORD are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const pool = new Pool({
  host: TENANT_DB_HOST,
  port: TENANT_DB_PORT,
  user: TENANT_DB_SUPERUSER,
  password: TENANT_DB_SUPERUSER_PASSWORD,
  database: TENANT_DB_NAME,
  ssl: TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
  max: 5,
});

// Same shape as database.service.ts's enableRlsOnNewTables(), parameterized
// by an optional role to SET ROLE into first (null = run as bare superuser).
async function enableRlsAsRole(
  client: import('pg').PoolClient,
  schemaName: string,
  asRole: string | null,
): Promise<{ enabled: string[]; skipped: string[] }> {
  const enabled: string[] = [];
  const skipped: string[] = [];

  const before = await client.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schemaName],
  );
  const offTables = before.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
  if (offTables.length === 0) return { enabled, skipped };

  if (asRole) await client.query(`SET ROLE "${asRole}"`);
  try {
    for (const table of offTables) {
      try {
        if (APPLY) {
          await client.query(`ALTER TABLE "${schemaName}"."${table}" ENABLE ROW LEVEL SECURITY`);
        }
        enabled.push(table);
      } catch (err: any) {
        if (err?.code === '42501' /* insufficient_privilege */) {
          skipped.push(table);
        } else {
          throw err;
        }
      }
    }
  } finally {
    if (asRole) await client.query('RESET ROLE');
  }
  return { enabled, skipped };
}

async function main() {
  console.log(`Tenant DB: ${TENANT_DB_HOST}:${TENANT_DB_PORT}/${TENANT_DB_NAME}`);
  console.log(`Mode: ${APPLY ? 'APPLY (will enable RLS)' : 'DRY RUN (report only -- pass --apply to write)'}`);
  console.log('');

  const { data: schemas, error } = await supabase
    .from('tenant_databases')
    .select('schema_name, project_id, status')
    .eq('status', 'active');

  if (error) {
    console.error('FAIL: could not list tenant_databases:', error.message);
    process.exit(1);
  }
  if (!schemas || schemas.length === 0) {
    console.log('No active tenant schemas found.');
    return;
  }

  console.log(`Found ${schemas.length} active tenant schema(s).\n`);

  let totalEnabled = 0;
  let totalStillOff = 0;
  let schemasWithChanges = 0;

  for (const row of schemas) {
    const schema = row.schema_name as string;
    const client = await pool.connect();
    try {
      const stillOffBefore = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT c.relrowsecurity`,
        [schema],
      );
      if (stillOffBefore.rows.length === 0) {
        console.log(`${schema}: already fully covered, skipping.`);
        continue;
      }

      const attempts = [
        { label: 'superuser (direct)', role: null },
        { label: `${schema}_owner`, role: `${schema}_owner` },
        { label: `${schema}_service`, role: `${schema}_service` },
      ];

      const allEnabled = new Set<string>();
      for (const attempt of attempts) {
        const { enabled } = await enableRlsAsRole(client, schema, attempt.role);
        enabled.forEach((t) => allEnabled.add(t));
      }

      const stillOffAfter = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT c.relrowsecurity`,
        [schema],
      );

      if (allEnabled.size > 0) {
        schemasWithChanges++;
        totalEnabled += allEnabled.size;
        console.log(`${schema}: ${APPLY ? 'enabled' : 'would enable'} RLS on ${allEnabled.size} table(s): ${[...allEnabled].join(', ')}`);
      }
      if (stillOffAfter.rows.length > 0 && APPLY) {
        totalStillOff += stillOffAfter.rows.length;
        console.log(`  WARNING: ${stillOffAfter.rows.length} table(s) still without RLS after all 3 role attempts (owned by neither superuser/_owner/_service -- investigate manually): ${stillOffAfter.rows.map((r) => r.relname).join(', ')}`);
      }
    } catch (err) {
      console.error(`${schema}: FAILED -- ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  console.log('');
  console.log(`Done. ${schemasWithChanges}/${schemas.length} schemas had tables ${APPLY ? 'fixed' : 'that would be fixed'}, ${totalEnabled} table(s) total.`);
  if (totalStillOff > 0) {
    console.log(`${totalStillOff} table(s) could not be fixed by any of the 3 role attempts -- needs manual investigation.`);
  }
  if (!APPLY) {
    console.log('Re-run with --apply to actually enable RLS.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
