/**
 * eCG Auth routes   backend endpoints that integrate with the eCG Auth
 * centralised authentication service.
 *
 * Mounted at /api/v1/auth/ecg/*
 *
 * Login and registration use a dual-path strategy:
 *   - eCG Auth is tried first.
 *   - On failure (user not found, not configured) the legacy Supabase flow
 *     is used as a fallback.
 *   - Successful legacy logins trigger background migration to eCG Auth.
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAuth, supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { createError } from '../middleware/error.middleware.js';
import { verifyTurnstile } from '../services/turnstile.service.js';
import {
  isEcgAuthConfigured,
  isEcgAuth2faActive,
  ecgLogin,
  ecgRegister,
  ecgVerify2fa,
  ecgResend2fa,
  ecgRefreshToken,
  ecgLogout,
  ecgChangePassword,
  ecgForgotPassword,
  ecgResetPassword,
  ecgAdminFindUserByEmail,
  buildBrandedResetEmailHtml,
  buildBrandedOtpEmailHtml,
} from '../services/ecgAuth.service.js';
import { ecgAuthMiddleware, type EcgAuthenticatedRequest } from '../middleware/ecgAuth.middleware.js';
import { ensureSupabaseMirror } from '../services/authBridge.service.js';

const router = Router();

// IP-keyed, not user-keyed: the attack this stops (credential stuffing /
// brute force against an existing end-user account) is defined by source IP,
// not by which account is being guessed. Login tighter than register --
// brute-forcing a known/guessed email is the primary threat; register only
// needs throttling against signup-spam/abuse, a lower-frequency threat.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 8,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts   please wait a few minutes and try again' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 8,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts   please wait and try again later' },
});

// A 6-digit OTP needs a tighter cap than login: IP-keyed limiter stops one
// source from hammering many different pending tokens.
const twoFaVerifyLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts   please wait a few minutes and try again' },
});
const twoFaResendLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  keyGenerator: (req) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many resend requests   please wait a few minutes and try again' },
});

// Per-token attempt cap: the IP limiter above doesn't stop an attacker who
// rotates IPs against one stolen/guessed pendingToken. OTP verification is
// fully delegated to the external eCG Auth service (ecgVerify2fa) -- this
// codebase has no visibility into per-token attempt counts there, so we
// track it locally instead.
// ponytail: in-memory Map, not a DB table -- resets on restart and doesn't
// share state across multiple server instances. Matches the OTP's own
// validity window (a few minutes), so a restart mid-window just resets the
// counter, it doesn't leave a stale lock. Move to Redis/DB if this ever
// runs multi-instance.
const TWO_FA_MAX_ATTEMPTS = 5;
const TWO_FA_ATTEMPT_TTL_MS = 5 * 60_000;
const twoFaAttempts = new Map<string, { count: number; expiresAt: number }>();

function checkTwoFaAttempt(pendingToken: string): boolean {
  const now = Date.now();
  const entry = twoFaAttempts.get(pendingToken);
  if (!entry || entry.expiresAt < now) {
    twoFaAttempts.set(pendingToken, { count: 1, expiresAt: now + TWO_FA_ATTEMPT_TTL_MS });
    return true;
  }
  if (entry.count >= TWO_FA_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

function clearTwoFaAttempts(pendingToken: string): void {
  twoFaAttempts.delete(pendingToken);
}

// Sweep expired entries every minute so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of twoFaAttempts) {
    if (entry.expiresAt < now) twoFaAttempts.delete(token);
  }
}, 60_000).unref();

// The Supabase mirror (ensureSupabaseMirror) needs the plaintext password
// eCG Auth just verified -- the 2FA-verify request only carries the OTP
// code, not the password, so it's held here keyed by pendingToken for the
// same short window as the OTP itself. Cleared on use or TTL expiry; never
// persisted anywhere durable.
const TWO_FA_PENDING_TTL_MS = 5 * 60_000;
const twoFaPendingCreds = new Map<string, { email: string; password: string; expiresAt: number }>();

function stashTwoFaPending(pendingToken: string, email: string, password: string): void {
  twoFaPendingCreds.set(pendingToken, { email, password, expiresAt: Date.now() + TWO_FA_PENDING_TTL_MS });
}
function takeTwoFaPending(pendingToken: string): { email: string; password: string } | null {
  const entry = twoFaPendingCreds.get(pendingToken);
  twoFaPendingCreds.delete(pendingToken);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return { email: entry.email, password: entry.password };
}
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of twoFaPendingCreds) {
    if (entry.expiresAt < now) twoFaPendingCreds.delete(token);
  }
}, 60_000).unref();

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // ── Try eCG Auth ─────────────────────────────────────────────────────
    if (isEcgAuthConfigured()) {
      const otpHtml = buildBrandedOtpEmailHtml();
      const ecgResult = await ecgLogin(email, password, otpHtml);

      if (ecgResult.ok && ecgResult.data) {
        // Check if this is a 2FA challenge
        if ('requires2fa' in ecgResult.data && ecgResult.data.requires2fa) {
          if (isEcgAuth2faActive()) {
            const pendingToken = (ecgResult.data as { pendingToken: string }).pendingToken;
            stashTwoFaPending(pendingToken, email, password);
            res.json({ requires2fa: true, pendingToken });
            return;
          }
          // 2FA flag is off locally but eCG Auth requires it for this account --
          // must NOT fall through to the legacy Supabase path below, since the
          // mirror account has no 2FA at all and that would silently bypass
          // the protection eCG Auth is enforcing for this user.
          logger.warn('security_event', { event: 'login_blocked_2fa_unsupported', email, ip: req.ip, path: req.path });
          res.status(501).json({
            error: '2fa_not_supported',
            message: 'This account requires two-factor authentication, which is not yet enabled on this app. Please contact support.',
          });
          return;
        } else {
          // Successful login. eCG Auth's user.id is NOT a Supabase auth.users
          // id -- profiles.id has a hard FK to auth.users(id)
          // (20260105133931_initial_schema.sql:43), so writing it there
          // directly fails the FK constraint. Mirror a real Supabase account
          // instead and hand back a REAL Supabase session, so every existing
          // RLS policy / auth.middleware.ts / frontend getSession() call
          // keeps working unchanged -- see authBridge.service.ts.
          const loginData = ecgResult.data as { accessToken: string; refreshToken: string; user: { id: string; email: string; firstName: string; lastName: string } };
          const fullName = `${loginData.user.firstName} ${loginData.user.lastName}`.trim();

          try {
            const { supabaseUserId, session } = await ensureSupabaseMirror(email, password, fullName, loginData.user.id);

            logger.info('security_event', { event: 'login_success', userId: supabaseUserId, email, ip: req.ip, path: req.path });
            res.json({
              accessToken: session.access_token,
              refreshToken: session.refresh_token,
              user: { id: supabaseUserId, email: loginData.user.email, fullName },
            });
          } catch (mirrorErr: any) {
            // Say WHICH half failed and why. The old response was one generic
            // sentence for every cause, so a dead local auth container and a
            // genuinely broken account looked identical -- diagnosing the
            // former took a full log dig on 2026-08-22. reason/detail come
            // from SupabaseMirrorError (authBridge.service.ts).
            const reason = mirrorErr?.reason === 'auth_unavailable' ? 'auth_unavailable' : 'mirror_failed';
            logger.error('[ecgAuth] Supabase mirror failed on login', {
              email, reason, error: mirrorErr?.message, detail: mirrorErr?.detail,
            });
            res.status(reason === 'auth_unavailable' ? 503 : 500).json({
              error: reason === 'auth_unavailable'
                ? 'Signed in, but the account service is not responding right now. Please try again in a moment.'
                : 'Login succeeded on eCG Auth but session setup failed. Please try again.',
              reason,
              // Bounded, and only ever the upstream failure text -- never
              // credentials or tokens. This endpoint already required a
              // correct password to reach, so it is not an oracle.
              detail: typeof mirrorErr?.detail === 'string' ? mirrorErr.detail.slice(0, 200) : undefined,
            });
          }
          return;
        }
      }

      // eCG Auth returned a specific error
      if (!ecgResult.ok && ecgResult.code) {
        // AL-0003: no account found on eCG Auth   fall through to legacy
        if (ecgResult.code === 'AL-0003') {
          logger.info('eCG Auth: user not found, falling back to legacy', { email });
          // fall through to legacy below
        }
        // AL-0004: wrong password   check if user has been migrated
        else if (ecgResult.code === 'AL-0004') {
          // Check if this email has ecg_auth_user_id set (meaning they've been migrated)
          const { data: profile } = await supabase
            .from('profiles')
            .select('ecg_auth_user_id')
            .eq('email', email)
            .maybeSingle();

          if (profile?.ecg_auth_user_id) {
            logger.warn('security_event', { event: 'login_failure', email, ip: req.ip, path: req.path, reason: 'ecg_wrong_password_migrated' });
            res.status(401).json({
              error: 'invalid_credentials',
              message: 'This email is registered with a unified eCG account. Please use the password you use on other eCG apps like Mirofish, OneNET, or eComGear, or use "Forgot Password" to reset it.',
            });
            return;
          }

          // Not migrated yet   fall through to legacy
          logger.info('eCG Auth: wrong password, user not migrated, falling back to legacy', { email });
        }
        // Other errors (rate limit, validation)   return as-is
        else if (ecgResult.status !== 0) {
          res.status(ecgResult.status).json({ error: ecgResult.error });
          return;
        }
        // Network error (status 0)   fall through to legacy
        else {
          logger.warn('eCG Auth unreachable, falling back to legacy', { email });
        }
      }
    }

    // ── Legacy: Supabase Auth ────────────────────────────────────────────
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

    if (error) {
      logger.warn('security_event', { event: 'login_failure', email, ip: req.ip, path: req.path, reason: error.message });
      res.status(401).json({ error: 'Invalid login credentials' });
      return;
    }

    if (data.user && data.session) {
      const userId = data.user.id;

      // Background migration: register user on eCG Auth (fire-and-forget)
      if (isEcgAuthConfigured()) {
        const userMeta = data.user.user_metadata || {};
        const firstName = (userMeta.full_name || '').split(' ')[0] || '';
        const lastName = (userMeta.full_name || '').split(' ').slice(1).join(' ') || '';

        ecgRegister(email, password, firstName, lastName)
          .then(async (regResult) => {
            if (regResult.ok && regResult.data?.user?.id) {
              const ecgUserId = regResult.data.user.id;
              try {
                await supabase
                  .from('profiles')
                  .update({ ecg_auth_user_id: ecgUserId })
                  .eq('id', userId);
                logger.info('Migrated legacy user to eCG Auth', { email, ecgUserId });
              } catch (err: any) {
                logger.warn('Failed to store ecg_auth_user_id after migration', { userId, error: err?.message });
              }
            } else if (regResult.code === 'AR-0006') {
              // Email already exists on eCG Auth from another app (Mirofish/
              // OneNET/etc) -- we're not creating a new account, just need
              // to find and link its real id so this user gets routed
              // through eCG-Auth-primary on future logins instead of being
              // stuck on the Supabase mirror forever.
              const found = await ecgAdminFindUserByEmail(email);
              if (found) {
                try {
                  await supabase.from('profiles').update({ ecg_auth_user_id: found.id }).eq('id', userId);
                  logger.info('Linked existing eCG Auth identity to legacy user', { email, ecgUserId: found.id });
                } catch (err: any) {
                  logger.warn('Failed to store ecg_auth_user_id after admin lookup', { userId, error: err?.message });
                }
              } else {
                logger.info('eCG Auth migration: user already exists on eCG Auth but admin lookup could not resolve id (probably from another app)', { email, code: regResult.code });
              }
            } else {
              logger.info('eCG Auth migration: registration failed for an unrelated reason', { email, code: regResult.code });
            }
          })
          .catch((err) => logger.warn('eCG Auth background migration failed', { email, error: err.message }));
      }

      logger.info('security_event', { event: 'login_success', userId, email, ip: req.ip, path: req.path });
      res.json({
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        user: {
          id: userId,
          email: data.user.email || '',
          fullName: (data.user.user_metadata?.full_name as string) || '',
        },
        migrated: true,
      });
    } else {
      logger.warn('security_event', { event: 'login_failure', email, ip: req.ip, path: req.path, reason: 'no_session' });
      res.status(401).json({ error: 'Invalid login credentials' });
    }
  } catch (error) {
    next(createError('Login failed', 500));
  }
});

// ─── Shared workspace provisioning (profile + org + first project) ─────────
// Same provisioning logic regardless of whether userId came from eCG Auth
// or from a legacy Supabase signUp   both need a profile/org/project.

async function provisionWorkspace(
  userId: string,
  email: string,
  fullName: string,
  organizationName: string,
  projectName: string,
  ecgAuthUserId?: string
): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  const { error: profileError } = await supabase
    .from('profiles')
    .upsert({
      id: userId,
      email,
      full_name: fullName,
      ...(ecgAuthUserId ? { ecg_auth_user_id: ecgAuthUserId } : {}),
    }, { onConflict: 'email' });

  if (profileError) {
    logger.error('Failed to create profile during registration', { email, error: profileError.message });
    // Don't fail the registration   the account exists, workspace can be created later
  }

  const slugBase = organizationName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const slug = `${slugBase || 'workspace'}-${Math.random().toString(36).slice(2, 8)}`;

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert({ name: organizationName, slug, created_by: userId })
    .select('id')
    .single();

  if (orgError || !org?.id) {
    logger.error('Failed to create organization during registration', { email, error: orgError?.message });
    return { ok: false, error: 'Account created but workspace setup failed. Please contact support.' };
  }

  try {
    await supabase.from('org_members').insert({ org_id: org.id, user_id: userId, role: 'admin' });
  } catch (err: any) {
    logger.warn('Failed to add org member', { error: err?.message });
  }

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .insert({ name: projectName, user_id: userId, created_by: userId, organization_id: org.id })
    .select('id')
    .single();

  if (projectError || !project?.id) {
    logger.error('Failed to create project during registration', { email, error: projectError?.message });
    return { ok: false, error: 'Account created but project setup failed. Please contact support.' };
  }

  return { ok: true, projectId: project.id };
}

// ─── POST /register ───────────────────────────────────────────────────────────

router.post('/register', registerLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, fullName, organizationName, projectName, turnstileToken } = req.body;
    if (!email || !password || !fullName || !organizationName || !projectName) {
      res.status(400).json({ error: 'Email, password, full name, organization name, and project name are required' });
      return;
    }

    // Bot protection: verify the Turnstile token before creating an account.
    // Inert until TURNSTILE_SECRET is set in the server env (see turnstile.service.ts).
    const turnstile = await verifyTurnstile(turnstileToken, req.ip, 'signup');
    if (!turnstile.ok) {
      logger.warn(`[ecgAuth] register blocked by Turnstile: ${turnstile.reason}`);
      res.status(403).json({ error: 'Human verification failed. Please try again.' });
      return;
    }

    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ');

    // ── Try eCG Auth ─────────────────────────────────────────────────────
    if (isEcgAuthConfigured()) {
      const regResult = await ecgRegister(email, password, firstName, lastName);

      if (regResult.ok) {
        const ecgUserId = regResult.data!.user.id;

        // eCG Auth's id has no matching auth.users row -- profiles.id's FK
        // would reject it. Mirror a real Supabase account (same password)
        // and provision the workspace against THAT id, same reasoning as
        // the login handler above (see authBridge.service.ts).
        let supabaseUserId: string;
        let session: { access_token: string; refresh_token: string };
        try {
          const mirrored = await ensureSupabaseMirror(email, password, fullName, ecgUserId);
          supabaseUserId = mirrored.supabaseUserId;
          session = mirrored.session;
        } catch (mirrorErr: any) {
          logger.error('[ecgAuth] Supabase mirror failed on register', { email, error: mirrorErr?.message });
          res.status(500).json({ error: 'Account created but session setup failed. Please try logging in.' });
          return;
        }

        const provisioned = await provisionWorkspace(supabaseUserId, email, fullName, organizationName, projectName, ecgUserId);
        if (!provisioned.ok) {
          res.status(500).json({ error: provisioned.error });
          return;
        }

        res.status(201).json({
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          user: { id: supabaseUserId, email, fullName },
          projectId: provisioned.projectId,
        });
        return;
      }

      if (regResult.code === 'AR-0006') {
        // Email already registered on eCG Auth
        res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });
        return;
      }
      if (regResult.status && regResult.status !== 0) {
        // Real eCG Auth error (not just unreachable)   surface it, don't fall back
        res.status(regResult.status).json({ error: regResult.error || 'Registration failed' });
        return;
      }
      // Network error (status 0)   fall through to legacy
      logger.warn('eCG Auth unreachable during registration, falling back to legacy', { email });
    }

    // ── Legacy: Supabase Auth ────────────────────────────────────────────
    const { data, error } = await supabaseAuth.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });

    if (error) {
      const status = /already registered|already exists/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
      return;
    }

    if (!data.user) {
      res.status(500).json({ error: 'Registration failed' });
      return;
    }

    const userId = data.user.id;
    const provisioned = await provisionWorkspace(userId, email, fullName, organizationName, projectName);
    if (!provisioned.ok) {
      res.status(500).json({ error: provisioned.error });
      return;
    }

    if (!data.session) {
      // Email confirmation required by this Supabase project   no session yet
      res.status(201).json({
        message: 'Account created. Please check your email to confirm, then log in.',
        projectId: provisioned.projectId,
      });
      return;
    }

    res.status(201).json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: { id: userId, email: data.user.email || '', fullName },
      projectId: provisioned.projectId,
      migrated: true,
    });
  } catch (error) {
    next(createError('Registration failed', 500));
  }
});

// ─── POST /2fa/verify ───────────────────────────────────────────────────────

router.post('/2fa/verify', twoFaVerifyLimiter, async (req: Request, res: Response) => {
  if (!isEcgAuth2faActive()) {
    res.status(404).json({ error: '2FA is not enabled' });
    return;
  }
  if (!isEcgAuthConfigured()) {
    res.status(500).json({ error: 'Authentication service not configured' });
    return;
  }

  const { pendingToken, code } = req.body;
  if (!pendingToken || !code) {
    res.status(400).json({ error: 'pendingToken and code are required' });
    return;
  }

  if (!checkTwoFaAttempt(pendingToken)) {
    logger.warn('security_event', { event: '2fa_rate_limited', ip: req.ip, path: req.path });
    res.status(429).json({ error: 'Too many incorrect attempts for this code   please request a new one' });
    return;
  }

  const result = await ecgVerify2fa(pendingToken, code);
  if (!result.ok) {
    logger.warn('security_event', { event: '2fa_failure', ip: req.ip, path: req.path, reason: result.error });
    res.status(result.status || 401).json({ error: result.error || '2FA verification failed' });
    return;
  }

  clearTwoFaAttempts(pendingToken);
  const data = result.data!;
  const fullName = `${data.user.firstName} ${data.user.lastName}`.trim();

  // Same FK problem as the primary login path -- data.user.id is eCG Auth's
  // own id, not a Supabase auth.users id. The plaintext password isn't in
  // this request (only the OTP code is); it was captured when the 2FA
  // challenge was issued, see stashTwoFaPending above.
  const pending = takeTwoFaPending(pendingToken);
  if (!pending) {
    logger.error('[ecgAuth] 2FA verify succeeded but no pending credentials found', { pendingToken });
    res.status(500).json({ error: '2FA verified but session setup failed -- please log in again.' });
    return;
  }

  try {
    const { supabaseUserId, session } = await ensureSupabaseMirror(pending.email, pending.password, fullName, data.user.id);
    logger.info('security_event', { event: 'login_success', userId: supabaseUserId, email: data.user.email, ip: req.ip, path: req.path });
    res.json({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      user: { id: supabaseUserId, email: data.user.email, fullName },
    });
  } catch (mirrorErr: any) {
    logger.error('[ecgAuth] Supabase mirror failed on 2FA verify', { email: data.user.email, error: mirrorErr?.message });
    res.status(500).json({ error: '2FA verified but session setup failed. Please try again.' });
  }
});

// ─── POST /2fa/resend ────────────────────────────────────────────────────────

router.post('/2fa/resend', twoFaResendLimiter, async (req: Request, res: Response) => {
  if (!isEcgAuth2faActive()) {
    res.status(404).json({ error: '2FA is not enabled' });
    return;
  }
  if (!isEcgAuthConfigured()) {
    res.status(500).json({ error: 'Authentication service not configured' });
    return;
  }

  const { pendingToken } = req.body;
  if (!pendingToken) {
    res.status(400).json({ error: 'pendingToken is required' });
    return;
  }

  const otpHtml = buildBrandedOtpEmailHtml();
  const result = await ecgResend2fa(pendingToken, otpHtml);
  if (!result.ok) {
    res.status(result.status || 401).json({ error: result.error || 'Failed to resend code' });
    return;
  }

  res.json({ message: 'Verification code resent' });
});

// ─── POST /forgot-password ───────────────────────────────────────────────────

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://ecomgear.dev';
    const resetUrl = `${frontendUrl}/auth/reset-password`;

    // Look up user in profiles to determine which auth path to use
    const { data: profile } = await supabase
      .from('profiles')
      .select('ecg_auth_user_id')
      .eq('email', email)
      .maybeSingle();

    if (profile?.ecg_auth_user_id && isEcgAuthConfigured()) {
      // User has been migrated to eCG Auth   use eCG Auth reset
      const brandedHtml = buildBrandedResetEmailHtml(resetUrl);
      const result = await ecgForgotPassword(email, resetUrl, brandedHtml);

      if (!result.ok && result.status !== 0) {
        // eCG Auth returned a real error (not a network failure)
        logger.warn('eCG Auth forgot-password failed', { email, error: result.error });
      }
      // Always return 200 to prevent account enumeration
      res.json({ message: 'If an account with this email exists, a password reset email has been sent.' });
      return;
    }

    // Legacy path: use Supabase reset
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo: `${frontendUrl}/auth/callback`,
    });

    if (error) {
      logger.warn('Supabase forgot-password failed', { email, error: error.message });
    }

    // Always return 200
    res.json({ message: 'If an account with this email exists, a password reset email has been sent.' });
  } catch (error) {
    logger.error('Forgot password error:', error);
    // Always return 200
    res.json({ message: 'If an account with this email exists, a password reset email has been sent.' });
  }
});

// ─── POST /reset-password ───────────────────────────────────────────────────

router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      res.status(400).json({ error: 'Token and new password are required' });
      return;
    }

    if (!isEcgAuthConfigured()) {
      res.status(500).json({ error: 'Authentication service not configured' });
      return;
    }

    const result = await ecgResetPassword(token, newPassword);
    if (!result.ok) {
      res.status(result.status || 401).json({ error: result.error || 'Password reset failed' });
      return;
    }

    res.json({ message: 'Password reset successfully. Please log in again.' });
  } catch (error) {
    next(createError('Password reset failed', 500));
  }
});

// ─── POST /change-password ───────────────────────────────────────────────────

router.post('/change-password', ecgAuthMiddleware, async (req: EcgAuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current password and new password are required' });
      return;
    }

    if (!isEcgAuthConfigured()) {
      res.status(500).json({ error: 'Authentication service not configured' });
      return;
    }

    // The middleware sets req.user from eCG Auth or Supabase.
    // For eCG Auth users, use eCG Auth change password.
    // For legacy Supabase users, use Supabase updateUser.
    const userId = req.user!.id;

    // Check if this user has an eCG Auth ID
    const { data: profile } = await supabase
      .from('profiles')
      .select('ecg_auth_user_id')
      .eq('id', userId)
      .maybeSingle();

    if (profile?.ecg_auth_user_id && isEcgAuthConfigured()) {
      const result = await ecgChangePassword(profile.ecg_auth_user_id, currentPassword, newPassword);
      if (!result.ok) {
        res.status(result.status || 401).json({ error: result.error || 'Password change failed' });
        return;
      }
      res.json({ message: 'Password changed successfully.' });
    } else {
      // Legacy: use Supabase
      const { error } = await supabaseAuth.auth.updateUser({
        password: newPassword,
      });
      if (error) {
        // Raw message intentionally NOT sanitized: Supabase Auth's own
        // validation text here ("Password should be at least 6 characters")
        // is designed to be user-facing, not schema/system detail.
        res.status(400).json({ error: error.message });
        return;
      }
      res.json({ message: 'Password changed successfully.' });
    }
  } catch (error) {
    next(createError('Password change failed', 500));
  }
});

// ─── POST /refresh ───────────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token is required' });
      return;
    }

    if (!isEcgAuthConfigured()) {
      res.status(500).json({ error: 'Authentication service not configured' });
      return;
    }

    const result = await ecgRefreshToken(refreshToken);
    if (!result.ok) {
      res.status(result.status || 401).json({ error: result.error || 'Token refresh failed' });
      return;
    }

    res.json({ accessToken: result.data!.accessToken });
  } catch (error) {
    next(createError('Token refresh failed', 500));
  }
});

// ─── POST /logout ────────────────────────────────────────────────────────────

router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, refreshToken } = req.body;

    // Notify eCG Auth to invalidate the refresh token
    if (isEcgAuthConfigured() && userId) {
      await ecgLogout(userId, refreshToken).catch((err) =>
        logger.warn('eCG Auth logout failed', { error: err.message }),
      );
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(createError('Logout failed', 500));
  }
});

export default router;
