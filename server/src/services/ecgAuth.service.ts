/**
 * eCG Auth service — HTTP client for the centralised eCG Auth API.
 *
 * Every call includes the X-API-Key header.  All functions return a result
 * tuple `{ ok, data, error, status, code }` instead of throwing so callers
 * can decide on fallback strategies.
 */

import { config } from '../config/environment.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EcgAuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  is2faEnabled?: boolean;
  createdAt?: string;
  appId?: string;
}

export interface EcgAuthResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
  status: number;
  /** eCG Auth error code (e.g. "AL-0003", "AR-0006") */
  code: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  return config.ecgAuthBaseUrl.replace(/\/$/, '');
}

function getApiKey(): string {
  return config.ecgAuthApiKey;
}

function headers(contentType = 'application/json'): Record<string, string> {
  const key = getApiKey();
  if (!key) return {};
  return {
    'Content-Type': contentType,
    'X-API-Key': key,
  };
}

/**
 * Returns true when both ECG_AUTH_BASE_URL and ECG_AUTH_API_KEY are set.
 * Use this to gate any code path that talks to eCG Auth.
 */
export function isEcgAuthConfigured(): boolean {
  return !!(config.ecgAuthBaseUrl && config.ecgAuthApiKey);
}

/**
 * Returns true when the 2FA feature flag is enabled.
 */
export function isEcgAuth2faActive(): boolean {
  return config.ecgAuth2faActive;
}

/** Internal fetch wrapper — never throws. */
async function ecgFetch<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<EcgAuthResult<T>> {
  if (!isEcgAuthConfigured()) {
    return { ok: false, data: null, error: 'eCG Auth not configured', status: 0, code: null };
  }

  try {
    const url = `${getBaseUrl()}${path}`;
    const opts: RequestInit = {
      method,
      headers: { ...headers(), ...extraHeaders },
      signal: AbortSignal.timeout(15_000),
    };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (res.ok) {
      return { ok: true, data: json as T, error: null, status: res.status, code: null };
    }

    return {
      ok: false,
      data: null,
      error: (json.error as string) || `HTTP ${res.status}`,
      status: res.status,
      code: (json.code as string) || null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('eCG Auth request failed', { method, path, error: msg });
    return { ok: false, data: null, error: msg, status: 0, code: null };
  }
}

// ─── Authentication flows ─────────────────────────────────────────────────────

/** POST /auth/login */
export function ecgLogin(
  email: string,
  password: string,
  emailHtml?: string,
): Promise<EcgAuthResult<{ accessToken: string; refreshToken: string; user: EcgAuthUser } | { requires2fa: boolean; pendingToken: string }>> {
  return ecgFetch('POST', '/auth/login', { email, password, ...(emailHtml ? { emailHtml } : {}) });
}

/** POST /auth/register */
export function ecgRegister(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
): Promise<EcgAuthResult<{ user: EcgAuthUser }>> {
  return ecgFetch('POST', '/auth/register', { email, password, firstName, lastName });
}

/** POST /auth/2fa/verify */
export function ecgVerify2fa(
  pendingToken: string,
  code: string,
): Promise<EcgAuthResult<{ accessToken: string; refreshToken: string; user: EcgAuthUser }>> {
  return ecgFetch('POST', '/auth/2fa/verify', { code }, { 'Authorization': `Bearer ${pendingToken}` });
}

/** POST /auth/2fa/resend */
export function ecgResend2fa(
  pendingToken: string,
  emailHtml?: string,
): Promise<EcgAuthResult<{ message: string }>> {
  return ecgFetch('POST', '/auth/2fa/resend', emailHtml ? { emailHtml } : undefined, { 'Authorization': `Bearer ${pendingToken}` });
}

// ─── Token management ────────────────────────────────────────────────────────

/** POST /auth/verify */
export function ecgVerifyToken(
  token: string,
): Promise<EcgAuthResult<{ valid: boolean; user: EcgAuthUser }>> {
  return ecgFetch('POST', '/auth/verify', { token });
}

/** POST /auth/refresh */
export function ecgRefreshToken(
  refreshToken: string,
): Promise<EcgAuthResult<{ accessToken: string }>> {
  return ecgFetch('POST', '/auth/refresh', { refreshToken });
}

/** POST /auth/logout */
export function ecgLogout(
  userId: string,
  refreshToken?: string,
): Promise<EcgAuthResult<{ message: string }>> {
  return ecgFetch('POST', '/auth/logout', { userId, ...(refreshToken ? { refreshToken } : {}) });
}

// ─── User profile ────────────────────────────────────────────────────────────

/** GET /auth/profile?userId=... */
export function ecgGetProfile(userId: string): Promise<EcgAuthResult<{ user: EcgAuthUser }>> {
  return ecgFetch('GET', `/auth/profile?userId=${encodeURIComponent(userId)}`);
}

/** PATCH /auth/profile */
export function ecgUpdateProfile(
  userId: string,
  updates: { firstName?: string; lastName?: string; enable2fa?: boolean },
): Promise<EcgAuthResult<{ user: EcgAuthUser }>> {
  return ecgFetch('PATCH', '/auth/profile', { userId, ...updates });
}

// ─── Password management ────────────────────────────────────────────────────

/** POST /auth/password/change */
export function ecgChangePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<EcgAuthResult<{ message: string }>> {
  return ecgFetch('POST', '/auth/password/change', { userId, currentPassword, newPassword });
}

/** POST /auth/password/forgot */
export function ecgForgotPassword(
  email: string,
  resetUrl?: string,
  emailHtml?: string,
): Promise<EcgAuthResult<{ message: string }>> {
  return ecgFetch('POST', '/auth/password/forgot', {
    email,
    ...(resetUrl ? { resetUrl } : {}),
    ...(emailHtml ? { emailHtml } : {}),
  });
}

/** POST /auth/password/reset */
export function ecgResetPassword(
  token: string,
  newPassword: string,
): Promise<EcgAuthResult<{ message: string }>> {
  return ecgFetch('POST', '/auth/password/reset', { token, newPassword });
}

// ─── Branded email templates ─────────────────────────────────────────────────
//
//  These replicate the eComGear visual branding (dark header, indigo accent
//  bar, CTA button) so eCG Auth sends emails that look identical to the
//  existing Supabase-powered ones.  Placeholders {{resetUrl}}, {{token}},
//  and {{code}} are replaced by eCG Auth before sending.

const LOGO_URL = 'https://www.ecomgear.dev/assets/ecomgear-auth-logo-sfGodRbL.png';

function brandedEmailShell(title: string, body: string, frontendUrl: string): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:48px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td align="center" style="background:#0f0f11;border-radius:14px 14px 0 0;padding:28px 40px 24px;">
            <a href="${frontendUrl}" style="text-decoration:none;display:inline-block;line-height:1;">
              <img src="${LOGO_URL}" alt="EcomGear" width="148" style="display:block;height:auto;border:0;outline:0;margin:0 auto;" />
            </a>
          </td>
        </tr>
        <tr>
          <td style="background:linear-gradient(90deg,#4f46e5 0%,#7c3aed 100%);height:3px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:44px 40px 36px;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-radius:0 0 14px 14px;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:12px;color:#94a3b8;line-height:1.6;">
                  &copy; ${year} EcomGear &middot;
                  <a href="${frontendUrl}" style="color:#94a3b8;text-decoration:underline;">ecomgear.dev</a>
                  &middot;
                  <a href="${frontendUrl}/dashboard/settings" style="color:#94a3b8;text-decoration:underline;">Manage preferences</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Returns branded password-reset email HTML with {{resetUrl}} and {{token}}
 * placeholders that eCG Auth will replace before sending.
 */
export function buildBrandedResetEmailHtml(resetUrl: string): string {
  const frontendUrl = process.env.FRONTEND_URL || 'https://ecomgear.dev';
  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">Reset your password</h1>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">Hi there,</p>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">
      We received a request to reset the password for your EcomGear account.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:36px 0 0;">
      <tr>
        <td style="border-radius:8px;background:#4f46e5;box-shadow:0 2px 8px rgba(79,70,229,.28);">
          <a href="{{resetUrl}}"
             style="display:inline-block;padding:14px 32px;color:#ffffff;
                    text-decoration:none;font-weight:600;font-size:15px;
                    letter-spacing:-0.1px;white-space:nowrap;">
            Reset password &rarr;
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:32px 0 0;padding-top:28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.7;">
      This link expires in 1 hour. If you did not request a password reset,
      you can safely ignore this email.
    </p>`;
  return brandedEmailShell('Reset your EcomGear password', body, frontendUrl);
}

/**
 * Returns branded 2FA OTP email HTML with {{code}} placeholder that eCG Auth
 * will replace before sending.
 */
export function buildBrandedOtpEmailHtml(): string {
  const frontendUrl = process.env.FRONTEND_URL || 'https://ecomgear.dev';
  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">Your verification code</h1>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">Hi there,</p>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.6;">
      Use this code to complete your login. It expires in 10 minutes.
    </p>
    <p style="margin:24px 0;font-size:32px;font-weight:700;color:#4f46e5;letter-spacing:6px;">
      {{code}}
    </p>
    <p style="margin:32px 0 0;padding-top:28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.7;">
      If you did not request this code, you can safely ignore this email.
    </p>`;
  return brandedEmailShell('EcomGear verification code', body, frontendUrl);
}
