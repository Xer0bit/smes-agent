/**
 * Existing-user migration mechanism for the eCG Auth integration.
 *
 * Two migration paths exist for a legacy (Supabase-only) user:
 *
 *  1. LAZY, per-login (already live in ecgAuth.routes.ts `/login`): the
 *     first time a legacy user logs in after eCG Auth is configured, their
 *     just-typed plaintext password is used to register them on eCG Auth in
 *     the background, and `profiles.ecg_auth_user_id` gets linked. This is
 *     the ONLY way to migrate a user who has no existing eCG Auth account --
 *     Supabase only stores a bcrypt hash, so there is no other source for a
 *     real password to register with.
 *
 *  2. PROACTIVE, this script: a user who already has an eCG Auth account
 *     from another eCG app (Mirofish/OneNET/etc) doesn't need a password to
 *     link -- their identity already exists, we just need its id. Waiting
 *     for that user's next login to discover this (via the AR-0006 branch)
 *     means they stay split-identity until they happen to log back in. This
 *     script does that lookup proactively for the whole existing user base,
 *     using the same admin-API lookup (`ecgAdminFindUserByEmail`) that the
 *     AR-0006 login-time path uses.
 *
 * This script NEVER creates eCG Auth accounts and NEVER touches passwords --
 * it only links profiles whose email already resolves to a real eCG Auth
 * user id via the admin API. Users not found there are left untouched; they
 * still get migrated by path (1) whenever they next log in.
 *
 * Dry-run by default. Pass --apply to actually write `ecg_auth_user_id`.
 *
 * Run with: npx tsx server/scripts/migrate-existing-users-to-ecg-auth.ts [--apply]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { isEcgAuthAdminConfigured, ecgAdminFindUserByEmail } from '../src/services/ecgAuth.service.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APPLY = process.argv.includes('--apply');
const PAGE_SIZE = 500;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('FAIL: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required.');
  process.exit(1);
}
if (!isEcgAuthAdminConfigured()) {
  console.error('FAIL: ECG_AUTH_BASE_URL, ECG_AUTH_ADMIN_USERNAME, and ECG_AUTH_ADMIN_PASSWORD must all be set.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

async function main() {
  console.log(`Target: ${SUPABASE_URL}`);
  console.log(`Mode: ${APPLY ? 'APPLY (will write ecg_auth_user_id)' : 'DRY RUN (no writes -- pass --apply to write)'}`);
  console.log('');

  let linked = 0;
  let deferred = 0;
  let skipped = 0;
  let from = 0;

  for (;;) {
    const { data: rows, error } = await admin
      .from('profiles')
      .select('id, email')
      .is('ecg_auth_user_id', null)
      .not('email', 'is', null)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('FAIL: profiles query failed:', error.message);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const email = row.email as string;
      const found = await ecgAdminFindUserByEmail(email);

      if (!found) {
        deferred++;
        continue;
      }

      if (APPLY) {
        const { error: updateErr } = await admin
          .from('profiles')
          .update({ ecg_auth_user_id: found.id })
          .eq('id', row.id);
        if (updateErr) {
          console.error(`SKIP: ${email} -- found eCG Auth id ${found.id} but write failed: ${updateErr.message}`);
          skipped++;
          continue;
        }
      }
      console.log(`${APPLY ? 'LINKED' : 'WOULD LINK'}: ${email} -> ecg_auth_user_id ${found.id}`);
      linked++;
    }

    from += PAGE_SIZE;
  }

  console.log('');
  console.log(`Done. ${linked} ${APPLY ? 'linked' : 'would be linked'}, ${deferred} deferred to lazy per-login migration, ${skipped} failed to write.`);
  if (!APPLY && linked > 0) {
    console.log('Re-run with --apply to actually write these.');
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
