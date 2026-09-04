// Signs/verifies the short-lived token a deployed eCG dashboard uses to call
// ecg-proxy/ecg-chat without an SMEsAgent account (see ecg-access.routes.ts).
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { logger } from './logger.js';

// Falls back to a random per-process secret if unset, so a missing env var
// can never mean "predictable secret"   it just means tokens don't survive a restart.
const SECRET = process.env.DASHBOARD_ACCESS_SECRET || randomBytes(32).toString('hex');
if (!process.env.DASHBOARD_ACCESS_SECRET) {
  logger.warn('DASHBOARD_ACCESS_SECRET not set   using a random per-process secret. Dashboard access tokens will invalidate on every restart.');
}
const TTL_MS = 12 * 60 * 60 * 1000; // 12h

interface Payload {
  projectId: string;
  exp: number;
}

function sign(payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function issueDashboardAccessToken(projectId: string): string {
  return sign({ projectId, exp: Date.now() + TTL_MS });
}

export function verifyDashboardAccessToken(token: string): string | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expectedSig = createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (typeof payload.projectId !== 'string' || payload.exp < Date.now()) return null;
    return payload.projectId;
  } catch {
    return null;
  }
}
