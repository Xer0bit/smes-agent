/**
 * eCG Auth service   HTTP client for the centralised eCG Auth API.
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

/** Internal fetch wrapper   never throws. */
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

// ─── Admin API (cross-app identity lookup) ──────────────────────────────────
//
//  Separate credential set (JWT username/password login, not X-API-Key).
//  Used ONLY to resolve the AR-0006 case: an email already registered on
//  eCG Auth from another app (Mirofish/OneNET/etc) -- we need that user's
//  real eCG Auth id to link profiles.ecg_auth_user_id, we are not creating
//  a new account. Token is cached in-process; re-login on expiry/401.

export function isEcgAuthAdminConfigured(): boolean {
  return !!(config.ecgAuthBaseUrl && config.ecgAuthAdminUsername && config.ecgAuthAdminPassword);
}

let adminToken: string | null = null;
let adminTokenExpiresAt = 0;

async function getAdminToken(): Promise<string | null> {
  if (!isEcgAuthAdminConfigured()) return null;
  if (adminToken && Date.now() < adminTokenExpiresAt) return adminToken;

  try {
    const res = await fetch(`${getBaseUrl()}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.ecgAuthAdminUsername, password: config.ecgAuthAdminPassword }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({})) as { token?: string };
    if (!res.ok || !json.token) {
      logger.warn('eCG Auth admin login failed', { status: res.status });
      return null;
    }
    adminToken = json.token;
    // Token is valid 12h server-side; refresh a bit early to dodge edge-of-expiry races.
    adminTokenExpiresAt = Date.now() + 11.5 * 60 * 60_000;
    return adminToken;
  } catch (err) {
    logger.warn('eCG Auth admin login request failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const ADMIN_LOOKUP_MAX_PAGES = 50; // 50 * 100 = 5,000 users scanned ceiling
const ADMIN_LOOKUP_PAGE_SIZE = 100;

/**
 * Finds a user on eCG Auth by email via the admin list endpoint. No
 * email-filter query param is documented for GET /admin/users, so this
 * paginates client-side. Only called from the AR-0006 background-migration
 * path, never a request's hot path -- an occasional multi-page scan is an
 * acceptable cost there.
 */
export async function ecgAdminFindUserByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const token = await getAdminToken();
  if (!token) return null;

  const target = email.toLowerCase();
  try {
    for (let page = 1; page <= ADMIN_LOOKUP_MAX_PAGES; page++) {
      const res = await fetch(`${getBaseUrl()}/admin/users?page=${page}&limit=${ADMIN_LOOKUP_PAGE_SIZE}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 401) {
        // Token expired/invalidated mid-scan -- force a fresh login on the
        // next call rather than retrying inline here.
        adminToken = null;
        logger.warn('eCG Auth admin token rejected during lookup', { email });
        return null;
      }
      if (!res.ok) {
        logger.warn('eCG Auth admin user list failed', { email, status: res.status });
        return null;
      }

      const json = await res.json().catch(() => ({})) as { users?: Array<{ id: string; email: string }>; total?: number };
      const match = json.users?.find((u) => u.email.toLowerCase() === target);
      if (match) return { id: match.id, email: match.email };

      const scanned = page * ADMIN_LOOKUP_PAGE_SIZE;
      if (!json.users || json.users.length === 0 || (json.total !== undefined && scanned >= json.total)) {
        break;
      }
    }
  } catch (err) {
    logger.warn('eCG Auth admin lookup request failed', { email, error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

// ─── Branded email templates ─────────────────────────────────────────────────
//
//  These replicate the eComGear visual branding (dark header, indigo accent
//  bar, CTA button) so eCG Auth sends emails that look identical to the
//  existing Supabase-powered ones.  Placeholders {{resetUrl}}, {{token}},
//  and {{code}} are replaced by eCG Auth before sending.

const LOGO_URL = 'https://www.ecomgear.dev/assets/ecomgear-auth-logo-sfGodRbL.png';

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function brandedEmailShell(title: string, preheader: string, body: string, frontendUrl: string): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0B0D0F;font-family:${FONT_STACK};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0D0F;padding:48px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr>
          <td align="center" style="padding:0 0 28px;">
            <a href="${frontendUrl}" style="text-decoration:none;display:inline-block;line-height:1;">
              <img src="${LOGO_URL}" alt="EcomGear" width="132" style="display:block;height:auto;border:0;outline:0;margin:0 auto;" />
            </a>
          </td>
        </tr>
        <tr>
          <td style="background:#15191E;border:1px solid #2C333A;border-radius:16px;padding:40px 36px;">
            ${body}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:28px 12px 0;">
            <p style="margin:0;font-size:12px;color:#5C6570;line-height:1.7;font-family:${FONT_STACK};">
              &copy; ${year} EcomGear &middot;
              <a href="${frontendUrl}" style="color:#5C6570;text-decoration:underline;">ecomgear.dev</a>
              &middot;
              <a href="${frontendUrl}/dashboard/settings" style="color:#5C6570;text-decoration:underline;">Manage preferences</a>
            </p>
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
    <h1 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#F3F5F7;font-family:${FONT_STACK};">Reset your password</h1>
    <p style="margin:0 0 28px;font-size:14px;color:#949EA8;line-height:1.65;font-family:${FONT_STACK};">
      We received a request to reset the password on your EcomGear account.
      Click below to choose a new one -- this link expires in 1 hour.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;">
      <tr>
        <td style="border-radius:10px;background:#22C3C3;">
          <a href="{{resetUrl}}"
             style="display:block;padding:13px 0;color:#0B0D0F;text-align:center;
                    text-decoration:none;font-weight:600;font-size:14px;
                    font-family:${FONT_STACK};">
            Reset password
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:28px 0 0;padding-top:24px;border-top:1px solid #2C333A;font-size:12px;color:#5C6570;line-height:1.7;font-family:${FONT_STACK};">
      If you didn't request this, you can safely ignore this email -- your password won't change.
    </p>`;
  return brandedEmailShell('Reset your EcomGear password', 'Reset the password on your EcomGear account.', body, frontendUrl);
}

/**
 * Returns branded 2FA OTP email HTML with {{code}} placeholder that eCG Auth
 * will replace before sending.
 */
export function buildBrandedOtpEmailHtml(): string {
  const frontendUrl = process.env.FRONTEND_URL || 'https://ecomgear.dev';
  const body = `
    <h1 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#F3F5F7;font-family:${FONT_STACK};">Your verification code</h1>
    <p style="margin:0 0 28px;font-size:14px;color:#949EA8;line-height:1.65;font-family:${FONT_STACK};">
      Enter this code to finish signing in. It expires in 10 minutes.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;">
      <tr>
        <td align="center" style="background:#0B0D0F;border:1px solid #2C333A;border-radius:10px;padding:20px 0;">
          <span style="font-family:'SF Mono',Consolas,Menlo,monospace;font-size:30px;font-weight:600;color:#22C3C3;letter-spacing:8px;">{{code}}</span>
        </td>
      </tr>
    </table>
    <p style="margin:28px 0 0;padding-top:24px;border-top:1px solid #2C333A;font-size:12px;color:#5C6570;line-height:1.7;font-family:${FONT_STACK};">
      If you didn't request this code, you can safely ignore this email.
    </p>`;
  return brandedEmailShell('EcomGear verification code', 'Your verification code for EcomGear.', body, frontendUrl);
}
