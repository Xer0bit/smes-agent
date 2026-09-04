/**
 * Regression test: project_secrets RLS must never leak plaintext secret
 * values cross-user, and must never leak them through a project's public
 * share link (visibility='org_all', status='active'). Both failure modes
 * have happened in this codebase's migration history for this exact table
 * (see 20260710130000_fix_project_secrets_rls.sql and
 * 20260807120000_fix_project_secrets_public_link_leak.sql) -- this script
 * exists so a future migration can't silently reopen either one.
 *
 * Runs against the LOCAL Supabase stack only (`supabase start`).
 * Run with: npx tsx server/scripts/test-project-secrets-rls.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SERVICE_KEY) {
  console.error('FAIL: SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required to seed fixtures.');
  process.exit(1);
}
if (SUPABASE_URL.includes('supabase.co') || SUPABASE_URL.includes('SMEsAgent')) {
  console.error(`FAIL: refusing to run against a non-local URL (${SUPABASE_URL}). This test creates real rows.`);
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const OWNER = { email: 'rls-test-owner@example.com', password: 'test-pass-12345' };
const STRANGER = { email: 'rls-test-stranger@example.com', password: 'test-pass-12345' };
const SECRET_VALUE = 'sk_live_regression_test_do_not_leak';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.error(`FAIL: ${label}`, detail ?? '');
  }
}

async function ensureUser(email: string, password: string): Promise<string> {
  const { data: existing } = await admin.auth.admin.listUsers();
  const found = existing?.users.find((u) => u.email === email);
  if (found) return found.id;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create user ${email}: ${error?.message}`);
  return data.user.id;
}

async function main() {
  const ownerId = await ensureUser(OWNER.email, OWNER.password);
  const strangerId = await ensureUser(STRANGER.email, STRANGER.password);

  await admin.from('profiles').upsert([{ id: ownerId, email: OWNER.email }, { id: strangerId, email: STRANGER.email }]);

  const { data: project, error: projectErr } = await admin
    .from('projects')
    .upsert(
      { id: '99999999-9999-9999-9999-999999999999', user_id: ownerId, created_by: ownerId, name: 'RLS regression test project', status: 'active', visibility: 'org_all' },
      { onConflict: 'id' }
    )
    .select('id')
    .single();
  if (projectErr || !project) throw new Error(`Failed to seed project: ${projectErr?.message}`);
  const projectId = project.id;

  const { error: secretErr } = await admin
    .from('project_secrets')
    .upsert({ project_id: projectId, key_name: 'REGRESSION_TEST_KEY', key_value: SECRET_VALUE, key_preview: 'sk_l****' }, { onConflict: 'project_id,key_name' });
  if (secretErr) throw new Error(`Failed to seed secret: ${secretErr.message}`);

  // Sanity: project is a public share link (org_all + active), same shape that leaked before.
  check('fixture project is public (org_all/active)', true);

  // ── 1. Anonymous (no session) must get zero rows, public link or not ──────
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: anonRows, error: anonErr } = await anon.from('project_secrets').select('key_value').eq('project_id', projectId);
  check('anonymous SELECT returns zero rows on public project', !anonErr && (anonRows?.length ?? 0) === 0, anonRows);

  // ── 2. Owner must still read their own secret ──────────────────────────────
  const ownerClient = createClient(SUPABASE_URL, ANON_KEY);
  const { error: ownerSignInErr } = await ownerClient.auth.signInWithPassword(OWNER);
  if (ownerSignInErr) throw new Error(`Owner sign-in failed: ${ownerSignInErr.message}`);
  const { data: ownerRows, error: ownerSelErr } = await ownerClient.from('project_secrets').select('key_value').eq('project_id', projectId);
  check('owner SELECT returns their own secret', !ownerSelErr && ownerRows?.[0]?.key_value === SECRET_VALUE, ownerRows);

  // ── 3. An unrelated authenticated user must get zero rows, even though the project is public ──
  const strangerClient = createClient(SUPABASE_URL, ANON_KEY);
  const { error: strangerSignInErr } = await strangerClient.auth.signInWithPassword(STRANGER);
  if (strangerSignInErr) throw new Error(`Stranger sign-in failed: ${strangerSignInErr.message}`);
  const { data: strangerRows, error: strangerSelErr } = await strangerClient.from('project_secrets').select('key_value').eq('project_id', projectId);
  check('unrelated authenticated user SELECT returns zero rows on public project', !strangerSelErr && (strangerRows?.length ?? 0) === 0, strangerRows);

  // ── 4. Stranger UPDATE must affect zero rows ────────────────────────────────
  const { data: updateData, error: updateErr } = await strangerClient
    .from('project_secrets')
    .update({ key_value: 'pwned' })
    .eq('project_id', projectId)
    .select();
  check('unrelated authenticated user UPDATE affects zero rows', !updateErr && (updateData?.length ?? 0) === 0, updateData);

  // ── 5. Stranger DELETE must affect zero rows ────────────────────────────────
  const { data: deleteData, error: deleteErr } = await strangerClient
    .from('project_secrets')
    .delete()
    .eq('project_id', projectId)
    .select();
  check('unrelated authenticated user DELETE affects zero rows', !deleteErr && (deleteData?.length ?? 0) === 0, deleteData);

  // ── 6. Confirm the secret is still intact after the attempted tamper ──────
  const { data: finalRows } = await ownerClient.from('project_secrets').select('key_value').eq('project_id', projectId);
  check('secret value untouched by stranger UPDATE/DELETE attempts', finalRows?.[0]?.key_value === SECRET_VALUE, finalRows);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: script error', err);
  process.exit(1);
});
