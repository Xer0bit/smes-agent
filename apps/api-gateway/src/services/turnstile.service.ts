/**
 * Cloudflare Turnstile server-side verification.
 *
 * Verifies the token a Turnstile widget produces on the client against
 * Cloudflare's siteverify endpoint before a protected action (registration)
 * proceeds. The secret is read ONLY from the environment (TURNSTILE_SECRET) --
 * never hardcoded, never logged.
 *
 * Rollout safety: if TURNSTILE_SECRET is not configured, verification is
 * SKIPPED (returns ok) with a one-time warning, so shipping the widget + this
 * gate together does not break registration before the secret is deployed.
 * Once the secret is set in the server environment the gate enforces.
 */
import { logger } from '../utils/logger.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Optional comma-separated allowlist of frontend hostnames the token may carry. */
const allowedHostnames = new Set(
  (process.env.TURNSTILE_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
);

// Cloudflare's official "always passes" dummy secret; pairs with the dev dummy
// site key (1x00000000000000000000AA) the frontend uses on localhost so a dev
// token verifies successfully. Never used in production.
const TURNSTILE_DEV_SECRET = '1x0000000000000000000000000000000AA';

let warnedNoSecret = false;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export interface TurnstileResult {
  ok: boolean;
  reason?: string;
}

/**
 * @param token       the `cf-turnstile-response` token from the client
 * @param remoteip    the caller's IP (best-effort; Cloudflare treats it as advisory)
 * @param expectedAction  the `data-action` the widget was rendered with
 */
export async function verifyTurnstile(
  token: unknown,
  remoteip: string | undefined,
  expectedAction: string,
): Promise<TurnstileResult> {
  // Dev/localhost uses the dummy test SITE key (see Turnstile.tsx), whose
  // tokens only validate against the dummy SECRET -- so outside production we
  // always verify with the dummy secret and never the real one, so the widget
  // works end-to-end on localhost. Production reads the real secret from the
  // env (TURNSTILE_SECRET_KEY, delivered by deploy.sh from .deploy.env;
  // TURNSTILE_SECRET accepted as a legacy alias).
  const isProd = process.env.NODE_ENV === 'production';
  const secret = isProd
    ? (process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET || '')
    : TURNSTILE_DEV_SECRET;
  if (!secret) {
    if (!warnedNoSecret) {
      logger.warn('[turnstile] no production TURNSTILE_SECRET_KEY set -- skipping verification (gate inert until configured)');
      warnedNoSecret = true;
    }
    return { ok: true, reason: 'not-configured' };
  }

  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'missing-token' };
  }

  let parsed: unknown;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteip) body.set('remoteip', remoteip);
    const r = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, reason: `siteverify-http-${r.status}` };
    parsed = await r.json();
  } catch (err) {
    return { ok: false, reason: `siteverify-error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const data = isRecord(parsed) ? parsed : {};
  const success = data.success === true;
  const action = typeof data.action === 'string' ? data.action : undefined;
  const hostname = typeof data.hostname === 'string' ? data.hostname : undefined;
  const errorCodes = Array.isArray(data['error-codes']) ? data['error-codes'].join(',') : '';

  if (!success) return { ok: false, reason: `failed: ${errorCodes}` };
  if (action !== expectedAction) return { ok: false, reason: `action-mismatch: ${action}` };
  if (allowedHostnames.size > 0 && !allowedHostnames.has(hostname ?? '')) {
    return { ok: false, reason: `hostname-not-allowed: ${hostname}` };
  }
  return { ok: true };
}
