/**
 * eCG Auth <-> Supabase identity bridge.
 *
 * eCG Auth is the source of truth for credentials/2FA/password-reset, but
 * every RLS policy in this app (59 migration files) checks auth.uid(), and
 * profiles.id has a hard FK to auth.users(id) (20260105133931_initial_schema.sql:43).
 * eCG Auth issues its own UUIDs that have no matching auth.users row, so
 * writing them straight into profiles.id fails the FK constraint outright.
 *
 * The fix: mirror a real Supabase auth.users account (same email/password)
 * behind every eCG-Auth-authenticated user, and mint a REAL Supabase session
 * via signInWithPassword. profiles.id always stays the real Supabase UUID;
 * eCG Auth's own id lives only in profiles.ecg_auth_user_id. Every existing
 * consumer (auth.middleware.ts, RLS, the ~55 frontend call sites that just
 * read session.access_token) keeps working completely unchanged, because the
 * session handed back really is a normal Supabase session.
 */
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseAuth } from '../config/database.js';
import { logger } from '../utils/logger.js';

export interface SupabaseMirrorResult {
  supabaseUserId: string;
  session: Session;
}

// supabase-js's admin API has no server-side "find by email" -- paginate
// listUsers and match client-side. Only reached on the rare orphaned-mirror
// recovery path (createUser rejected the email as already registered), not
// the normal hot path, so the scan cost is acceptable.
async function findAuthUserIdByEmail(email: string): Promise<string | undefined> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return undefined;
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) return undefined;
  }
  return undefined;
}

/**
 * Ensures a Supabase auth.users account exists for this email with the given
 * password, then signs in as it to produce a real Supabase session. Used
 * after eCG Auth has ALREADY verified the password -- this does not itself
 * verify the password, it mirrors an already-authenticated identity.
 */
export async function ensureSupabaseMirror(
  email: string,
  password: string,
  fullName: string,
  ecgAuthUserId: string,
): Promise<SupabaseMirrorResult> {
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  let supabaseUserId = existingProfile?.id as string | undefined;

  if (!supabaseUserId) {
    // Brand new eCG-Auth-only identity -- provision a matching Supabase user.
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createErr || !created?.user) {
      // profiles can drift out of sync with auth.users (e.g. a profile row
      // removed without deleting the underlying auth user) -- in that case
      // the mirror account already exists even though the lookup above
      // missed it. Recover its id instead of failing every future login.
      if (createErr?.message?.toLowerCase().includes('already been registered')) {
        supabaseUserId = await findAuthUserIdByEmail(email);
        if (!supabaseUserId) {
          throw new Error(`Failed to mirror Supabase account for ${email}: ${createErr.message} (and could not locate the existing auth user)`);
        }
        logger.warn('[authBridge] Recovered orphaned Supabase mirror account (profiles row was out of sync)', { email, supabaseUserId, ecgAuthUserId });
      } else {
        throw new Error(`Failed to mirror Supabase account for ${email}: ${createErr?.message}`);
      }
    } else {
      supabaseUserId = created.user.id;
      logger.info('[authBridge] Provisioned Supabase mirror account', { email, supabaseUserId, ecgAuthUserId });
    }
  }

  const signIn = async () => supabaseAuth.auth.signInWithPassword({ email, password });

  let { data: sessionData, error: signInErr } = await signIn();

  if (signInErr) {
    // Mirror account's Supabase-side password is stale (e.g. changed only on
    // eCG Auth's side since) -- eCG Auth already verified this password is
    // correct, so resync it here and retry once.
    const { error: updateErr } = await supabase.auth.admin.updateUserById(supabaseUserId, { password });
    if (updateErr) {
      throw new Error(`Failed to resync mirror password for ${email}: ${updateErr.message}`);
    }
    ({ data: sessionData, error: signInErr } = await signIn());
    if (signInErr) {
      throw new Error(`Mirror sign-in still failed after password resync for ${email}: ${signInErr.message}`);
    }
  }

  if (!sessionData?.session) {
    throw new Error(`Mirror sign-in for ${email} returned no session`);
  }

  // Link eCG Auth's id for future lookups (which eCG Auth account maps to
  // this Supabase user). Upsert, not update: the recovered-orphan path above
  // can reach here with an auth.users row that has no profiles row at all,
  // and an update would silently match zero rows, leaving the account
  // permanently profile-less. id/email are the only NOT NULL columns
  // (20260105133931_initial_schema.sql:29-44), so this is always safe.
  await supabase
    .from('profiles')
    .upsert({ id: supabaseUserId, email, ecg_auth_user_id: ecgAuthUserId, full_name: fullName })
    .then(({ error }) => {
      if (error) logger.warn('[authBridge] Failed to link ecg_auth_user_id', { email, error: error.message });
    });

  return { supabaseUserId, session: sessionData.session };
}
