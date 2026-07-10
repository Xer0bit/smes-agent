/**
 * eCG Auth routes — backend endpoints that integrate with the eCG Auth
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

import { Router, Request, Response } from 'express';
import { supabaseAuth, supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
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
  buildBrandedResetEmailHtml,
  buildBrandedOtpEmailHtml,
} from '../services/ecgAuth.service.js';
import { ecgAuthMiddleware, type EcgAuthenticatedRequest } from '../middleware/ecgAuth.middleware.js';

const router = Router();

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
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
            res.json({ requires2fa: true, pendingToken: (ecgResult.data as { pendingToken: string }).pendingToken });
            return;
          }
          // 2FA flag is off — ignore the challenge and treat as error
          logger.warn('eCG Auth 2FA required but ECG_AUTH_2FA_ACTIVE is false', { email });
        } else {
          // Successful login
          const loginData = ecgResult.data as { accessToken: string; refreshToken: string; user: { id: string; email: string; firstName: string; lastName: string } };

          // Upsert ecg_auth_user_id in profiles (link if not yet linked)
          try {
            await supabase
              .from('profiles')
              .upsert({ id: loginData.user.id, email, ecg_auth_user_id: loginData.user.id }, { onConflict: 'email' });
          } catch (err: any) {
            logger.warn('Failed to upsert ecg_auth_user_id on login', { error: err?.message });
          }

          res.json({
            accessToken: loginData.accessToken,
            refreshToken: loginData.refreshToken,
            user: {
              id: loginData.user.id,
              email: loginData.user.email,
              fullName: `${loginData.user.firstName} ${loginData.user.lastName}`.trim(),
            },
          });
          return;
        }
      }

      // eCG Auth returned a specific error
      if (!ecgResult.ok && ecgResult.code) {
        // AL-0003: no account found on eCG Auth — fall through to legacy
        if (ecgResult.code === 'AL-0003') {
          logger.info('eCG Auth: user not found, falling back to legacy', { email });
          // fall through to legacy below
        }
        // AL-0004: wrong password — check if user has been migrated
        else if (ecgResult.code === 'AL-0004') {
          // Check if this email has ecg_auth_user_id set (meaning they've been migrated)
          const { data: profile } = await supabase
            .from('profiles')
            .select('ecg_auth_user_id')
            .eq('email', email)
            .maybeSingle();

          if (profile?.ecg_auth_user_id) {
            res.status(401).json({
              error: 'invalid_credentials',
              message: 'This email is registered with a unified eCG account. Please use the password you use on other eCG apps like Mirofish, OneNET, or eComGear, or use "Forgot Password" to reset it.',
            });
            return;
          }

          // Not migrated yet — fall through to legacy
          logger.info('eCG Auth: wrong password, user not migrated, falling back to legacy', { email });
        }
        // Other errors (rate limit, validation) — return as-is
        else if (ecgResult.status !== 0) {
          res.status(ecgResult.status).json({ error: ecgResult.error });
          return;
        }
        // Network error (status 0) — fall through to legacy
        else {
          logger.warn('eCG Auth unreachable, falling back to legacy', { email });
        }
      }
    }

    // ── Legacy: Supabase Auth ────────────────────────────────────────────
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

    if (error) {
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

        ecgRegister(email, data.session.access_token, firstName, lastName)
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
            } else {
              logger.info('eCG Auth migration: user already exists on eCG Auth (probably from another app)', { email, code: regResult.code });
            }
          })
          .catch((err) => logger.warn('eCG Auth background migration failed', { email, error: err.message }));
      }

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
      res.status(401).json({ error: 'Invalid login credentials' });
    }
  } catch (error) {
    logger.error('eCG login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── POST /register ───────────────────────────────────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, fullName, organizationName, projectName } = req.body;
    if (!email || !password || !fullName || !organizationName || !projectName) {
      res.status(400).json({ error: 'Email, password, full name, organization name, and project name are required' });
      return;
    }

    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ');

    // ── Register on eCG Auth ────────────────────────────────────────────
    if (!isEcgAuthConfigured()) {
      res.status(500).json({ error: 'Authentication service not configured' });
      return;
    }

    const regResult = await ecgRegister(email, password, firstName, lastName);

    if (!regResult.ok) {
      if (regResult.code === 'AR-0006') {
        // Email already registered on eCG Auth
        res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });
        return;
      }
      res.status(regResult.status || 400).json({ error: regResult.error || 'Registration failed' });
      return;
    }

    const ecgUser = regResult.data!.user;
    const ecgUserId = ecgUser.id;

    // ── Provision workspace (profile + org + project) ──────────────────
    // We create a Supabase user entry and profile linked to the eCG Auth user.
    // The Supabase user is created via admin API so we get a real auth.users row
    // for RLS compatibility, but the actual auth is eCG Auth.

    // Create profile with ecg_auth_user_id
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: ecgUserId,
        email,
        full_name: fullName,
        ecg_auth_user_id: ecgUserId,
      }, { onConflict: 'email' });

    if (profileError) {
      logger.error('Failed to create profile during eCG registration', { email, error: profileError.message });
      // Don't fail the registration — the eCG Auth account exists, workspace can be created later
    }

    // Create organization
    const slugBase = organizationName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = `${slugBase || 'workspace'}-${Math.random().toString(36).slice(2, 8)}`;

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({ name: organizationName, slug, created_by: ecgUserId })
      .select('id')
      .single();

    if (orgError || !org?.id) {
      logger.error('Failed to create organization during eCG registration', { email, error: orgError?.message });
      res.status(500).json({ error: 'Account created but workspace setup failed. Please contact support.' });
      return;
    }

    // Add user as org admin
    try {
      await supabase
        .from('org_members')
        .insert({ org_id: org.id, user_id: ecgUserId, role: 'admin' });
    } catch (err: any) {
      logger.warn('Failed to add org member', { error: err?.message });
    }

    // Create first project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert({
        name: projectName,
        user_id: ecgUserId,
        created_by: ecgUserId,
        organization_id: org.id,
      })
      .select('id')
      .single();

    if (projectError || !project?.id) {
      logger.error('Failed to create project during eCG registration', { email, error: projectError?.message });
      res.status(500).json({ error: 'Account created but project setup failed. Please contact support.' });
      return;
    }

    // Login to eCG Auth to get tokens
    const loginResult = await ecgLogin(email, password);
    if (!loginResult.ok || !loginResult.data || 'requires2fa' in loginResult.data) {
      // Registration succeeded but auto-login failed — user can log in manually
      res.status(201).json({
        message: 'Account created successfully. Please log in.',
        projectId: project.id,
      });
      return;
    }

    const loginData = loginResult.data as { accessToken: string; refreshToken: string; user: { id: string; email: string } };

    res.status(201).json({
      accessToken: loginData.accessToken,
      refreshToken: loginData.refreshToken,
      user: {
        id: loginData.user.id,
        email: loginData.user.email,
        fullName,
      },
      projectId: project.id,
    });
  } catch (error) {
    logger.error('eCG register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── POST /2fa/verify ───────────────────────────────────────────────────────

router.post('/2fa/verify', async (req: Request, res: Response) => {
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

  const result = await ecgVerify2fa(pendingToken, code);
  if (!result.ok) {
    res.status(result.status || 401).json({ error: result.error || '2FA verification failed' });
    return;
  }

  const data = result.data!;
  res.json({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: {
      id: data.user.id,
      email: data.user.email,
      fullName: `${data.user.firstName} ${data.user.lastName}`.trim(),
    },
  });
});

// ─── POST /2fa/resend ────────────────────────────────────────────────────────

router.post('/2fa/resend', async (req: Request, res: Response) => {
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
      // User has been migrated to eCG Auth — use eCG Auth reset
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

router.post('/reset-password', async (req: Request, res: Response) => {
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
    logger.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ─── POST /change-password ───────────────────────────────────────────────────

router.post('/change-password', ecgAuthMiddleware, async (req: EcgAuthenticatedRequest, res: Response) => {
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
        res.status(400).json({ error: error.message });
        return;
      }
      res.json({ message: 'Password changed successfully.' });
    }
  } catch (error) {
    logger.error('Change password error:', error);
    res.status(500).json({ error: 'Password change failed' });
  }
});

// ─── POST /refresh ───────────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response) => {
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
    logger.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ─── POST /logout ────────────────────────────────────────────────────────────

router.post('/logout', async (req: Request, res: Response) => {
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
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
