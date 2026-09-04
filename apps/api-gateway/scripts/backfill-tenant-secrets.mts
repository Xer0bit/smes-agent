/**
 * One-time backfill: force-resync VITE_DB_API_URL / VITE_DB_ANON_KEY /
 * VITE_DB_SCHEMA / VITE_FUNCTIONS_API_URL for every project with an active
 * hosted database, via databaseService.getCredentials() -- the SAME
 * self-healing upsert that already runs on every agent turn
 * (buildProjectEnvSecrets -> getCredentials, database.service.ts:392-402).
 *
 * Why this exists: getCredentials() only fixes a project's secrets when it's
 * actually CALLED (i.e. next time the agent runs for that project). A project
 * that was provisioned before the "single source of truth" fix landed (see
 * database.service.ts:264-270) and hasn't had an agent turn since keeps
 * whatever stale value it was written with -- confirmed live: one production
 * project's VITE_FUNCTIONS_API_URL still pointed at the wrong host
 * (api.SMEsAgent.dev instead of cloud.SMEsAgent.app/<schema>/functions) with no
 * self-heal trigger. This script forces that resync for every active tenant
 * DB in one pass instead of waiting on each project's next agent turn.
 *
 * Never hand-writes a URL/host -- it only calls the existing, tested
 * databaseService logic, so it can't drift from what the real code path does.
 *
 * Run with: npx tsx scripts/backfill-tenant-secrets.mts [--dry-run]
 */
import { supabase } from '../src/config/database.js';
import { databaseService } from '../src/services/database.service.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const { data: rows, error } = await supabase
    .from('tenant_databases')
    .select('id, user_id, project_id, schema_name')
    .eq('status', 'active');

  if (error) {
    console.error('Failed to list active tenant databases:', error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log('No active tenant databases found.');
    return;
  }

  console.log(`Found ${rows.length} active tenant database(s).${DRY_RUN ? ' (dry run -- no writes)' : ''}`);

  let fixed = 0;
  let failed = 0;

  for (const row of rows) {
    const label = row.project_id ?? `(legacy, user ${row.user_id})`;
    if (DRY_RUN) {
      const { data: before } = await supabase
        .from('project_secrets')
        .select('key_name, key_value')
        .eq('project_id', row.project_id ?? '')
        .in('key_name', ['VITE_DB_API_URL', 'VITE_FUNCTIONS_API_URL']);
      console.log(`[dry-run] ${row.schema_name} (project ${label}):`, before);
      continue;
    }
    try {
      // getCredentials() itself performs the upsert (fire-and-forget inside
      // it) when projectId is provided -- await a moment so it lands before
      // moving to the next row.
      await databaseService.getCredentials(row.user_id, row.project_id ?? undefined);
      await new Promise((r) => setTimeout(r, 150));
      console.log(`✓ resynced ${row.schema_name} (project ${label})`);
      fixed++;
    } catch (err) {
      console.error(`✗ failed to resync ${row.schema_name} (project ${label}):`, (err as Error).message);
      failed++;
    }
  }

  console.log(`\nDone. ${fixed} resynced, ${failed} failed, ${rows.length} total.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
