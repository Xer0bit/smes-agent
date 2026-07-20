/**
 * Google Analytics connector — connect a Google account (OAuth, read-only
 * Analytics scope), pick a GA4 property per project, and pull real report
 * data (sessions, pageviews, top pages, events) for the settings dashboard.
 *
 * Mirrors github.routes.ts's connection pattern: one connected Google
 * account per user (google_analytics_connections), per-project property
 * selection stored in the generic project_settings key/value table
 * (setting_key = 'google_analytics') — saved directly from the client via
 * Supabase, same as header_integrations, so no save endpoint lives here.
 */
import { Router, Request, Response } from 'express';
import { createHmac } from 'node:crypto';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase, supabaseAuth } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SERVER_URL = (process.env.ECOMGEAR_SERVER_URL || 'https://api.ecomgear.dev').replace(/\/$/, '');
const APP_URL    = (process.env.APP_URL || 'https://www.ecomgear.dev').replace(/\/$/, '');
// Must exactly match an "Authorized redirect URI" registered on this Google
// Cloud OAuth client — that's /auth/google-analytics/callback, not
// /api/v1/google-analytics/callback (see app.ts's dual mount).
const REDIRECT_URI = `${SERVER_URL}/auth/google-analytics/callback`;
const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
// Reuses the same signing key as github.routes.ts's OAuth state token — an
// existing secret, no relation to tenant DB auth.
const STATE_SECRET = process.env.TENANT_DB_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signState(payload: { uid: string; pid?: string; exp: number }): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', STATE_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyState(state: string): { uid: string; pid?: string } | null {
  try {
    const [body, sig] = state.split('.');
    if (!body || !sig) return null;
    const expected = b64url(createHmac('sha256', STATE_SECRET).update(body).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as { uid: string; pid?: string; exp: number };
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.uid !== 'string') return null;
    return { uid: payload.uid, pid: typeof payload.pid === 'string' ? payload.pid : undefined };
  } catch {
    return null;
  }
}

interface GaConnection {
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  google_email: string | null;
}

async function getConnection(userId: string): Promise<GaConnection | null> {
  const { data } = await supabase
    .from('google_analytics_connections')
    .select('access_token, refresh_token, token_expires_at, google_email')
    .eq('user_id', userId)
    .maybeSingle();
  return data as GaConnection | null;
}

/** Returns a usable access token for this user, refreshing it first if expired. */
async function getValidAccessToken(userId: string): Promise<string | null> {
  const conn = await getConnection(userId);
  if (!conn) return null;

  const expiresAt = new Date(conn.token_expires_at).getTime();
  // Refresh a bit early (60s) so a request never races an expiry mid-flight.
  if (expiresAt - Date.now() > 60_000) return conn.access_token;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const tokenJson = await tokenRes.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!tokenJson.access_token) {
    logger.warn('[GoogleAnalytics] token refresh failed', { userId, error: tokenJson.error });
    return null;
  }

  const newExpiresAt = new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000).toISOString();
  await supabase
    .from('google_analytics_connections')
    .update({ access_token: tokenJson.access_token, token_expires_at: newExpiresAt })
    .eq('user_id', userId);

  return tokenJson.access_token;
}

async function requireProjectAccess(req: AuthenticatedRequest, res: Response, projectId: string): Promise<boolean> {
  try {
    await projectService.assertCanEditProject(projectId, req.user!.id);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// ── GET /api/v1/google-analytics/connect?token=<supabase_access_token> ──────
// Top-level browser redirect, so it can't carry an Authorization header —
// the frontend passes the session token as a query param instead.
router.get('/connect', async (req: Request, res: Response) => {
  const token = req.query.token as string | undefined;
  const projectId = req.query.projectId as string | undefined;
  if (!token) { res.status(401).send('Missing token'); return; }
  if (!GOOGLE_CLIENT_ID) { res.status(500).send('Google Analytics integration is not configured on this server.'); return; }

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) { res.status(401).send('Invalid session'); return; }

  const state = signState({ uid: data.user.id, pid: projectId, exp: Math.floor(Date.now() / 1000) + 600 });
  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizeUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', GA_SCOPE);
  authorizeUrl.searchParams.set('access_type', 'offline');
  // Forces Google to reissue a refresh_token on every connect (a repeat
  // connect would otherwise silently omit it) — simplest correct behavior,
  // at the cost of showing the consent screen again on reconnect.
  authorizeUrl.searchParams.set('prompt', 'consent');
  authorizeUrl.searchParams.set('state', state);
  res.redirect(authorizeUrl.toString());
});

// ── GET /api/v1/google-analytics/callback ────────────────────────────────────
router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const verified = state ? verifyState(state) : null;
  const settingsUrl = verified?.pid
    ? `${APP_URL}/project/${verified.pid}/settings?section=workspace-analytics`
    : `${APP_URL}/dashboard/settings?section=workspace-analytics`;

  if (!code || !verified) {
    res.redirect(`${settingsUrl}&ga=error`);
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson = await tokenRes.json() as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
    };
    if (!tokenJson.access_token || !tokenJson.refresh_token) {
      logger.warn('[GoogleAnalytics OAuth] token exchange failed', { error: tokenJson.error, hasRefresh: !!tokenJson.refresh_token });
      res.redirect(`${settingsUrl}&ga=error`);
      return;
    }

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const userInfo = await userInfoRes.json().catch(() => ({})) as { email?: string };

    await supabase.from('google_analytics_connections').upsert(
      {
        user_id: verified.uid,
        google_email: userInfo.email ?? null,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        token_expires_at: new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000).toISOString(),
        scope: tokenJson.scope ?? null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

    res.redirect(`${settingsUrl}&ga=connected`);
  } catch (err) {
    logger.error('[GoogleAnalytics OAuth] callback error', err);
    res.redirect(`${settingsUrl}&ga=error`);
  }
});

// ── GET /api/v1/google-analytics/status ──────────────────────────────────────
router.get('/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const conn = await getConnection(req.user!.id);
  res.json(conn ? { connected: true, email: conn.google_email } : { connected: false });
});

// ── DELETE /api/v1/google-analytics/disconnect ───────────────────────────────
router.delete('/disconnect', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const conn = await getConnection(req.user!.id);
  if (conn) {
    // Best-effort revoke on Google's side too — non-fatal if it fails.
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(conn.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
  await supabase.from('google_analytics_connections').delete().eq('user_id', req.user!.id);
  res.json({ success: true });
});

// ── GET /api/v1/google-analytics/properties ──────────────────────────────────
// Lists GA4 properties the connected account can view, via the Analytics
// Admin API's accountSummaries (one call covers every account+property pair
// instead of listing accounts then properties per-account).
router.get('/properties', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const accessToken = await getValidAccessToken(req.user!.id);
    if (!accessToken) { res.status(401).json({ error: 'Google Analytics is not connected.' }); return; }

    const listRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      const detail = await listRes.text().catch(() => '');
      res.status(502).json({ error: `Failed to list Google Analytics properties (${listRes.status}): ${detail.slice(0, 300)}` });
      return;
    }
    const body = await listRes.json() as {
      accountSummaries?: Array<{ displayName: string; propertySummaries?: Array<{ property: string; displayName: string }> }>;
    };
    const properties = (body.accountSummaries ?? []).flatMap((acc) =>
      (acc.propertySummaries ?? []).map((p) => ({
        // p.property is "properties/123456789" — the Data API's runReport
        // path wants the bare numeric id, but the caller can pass either.
        propertyId: p.property.replace(/^properties\//, ''),
        displayName: `${p.displayName} (${acc.displayName})`,
      }))
    );
    res.json({ properties });
  } catch (err) {
    logger.error('[GoogleAnalytics] properties list error', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

interface GaReport {
  totals: { sessions: number; activeUsers: number; pageviews: number };
  daily: Array<{ date: string; sessions: number; pageviews: number }>;
  topPages: Array<{ path: string; pageviews: number }>;
  topEvents: Array<{ name: string; count: number }>;
}

async function runReport(accessToken: string, propertyId: string, body: Record<string, unknown>) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GA4 report request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json() as Promise<{ rows?: Array<{ dimensionValues?: Array<{ value: string }>; metricValues?: Array<{ value: string }> }> }>;
}

// ── GET /api/v1/google-analytics/:projectId/report?days=30 ──────────────────
router.get('/:projectId/report', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    if (!(await requireProjectAccess(req, res, projectId))) return;

    const accessToken = await getValidAccessToken(req.user!.id);
    if (!accessToken) { res.status(401).json({ error: 'Google Analytics is not connected.' }); return; }

    const { data: setting } = await supabase
      .from('project_settings')
      .select('setting_value')
      .eq('project_id', projectId)
      .eq('setting_key', 'google_analytics')
      .maybeSingle();
    const propertyId = (setting?.setting_value as { property_id?: string } | null)?.property_id;
    if (!propertyId) { res.status(400).json({ error: 'No Google Analytics property selected for this project yet.' }); return; }

    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const dateRange = [{ startDate: `${days}daysAgo`, endDate: 'today' }];

    const [totalsRes, dailyRes, pagesRes, eventsRes] = await Promise.all([
      runReport(accessToken, propertyId, {
        dateRanges: dateRange,
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }],
      }),
      runReport(accessToken, propertyId, {
        dateRanges: dateRange,
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      }),
      runReport(accessToken, propertyId, {
        dateRanges: dateRange,
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: '10',
      }),
      runReport(accessToken, propertyId, {
        dateRanges: dateRange,
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: '10',
      }),
    ]);

    const totalsRow = totalsRes.rows?.[0]?.metricValues ?? [];
    const report: GaReport = {
      totals: {
        sessions: Number(totalsRow[0]?.value ?? 0),
        activeUsers: Number(totalsRow[1]?.value ?? 0),
        pageviews: Number(totalsRow[2]?.value ?? 0),
      },
      daily: (dailyRes.rows ?? []).map((r) => ({
        date: r.dimensionValues?.[0]?.value ?? '',
        sessions: Number(r.metricValues?.[0]?.value ?? 0),
        pageviews: Number(r.metricValues?.[1]?.value ?? 0),
      })),
      topPages: (pagesRes.rows ?? []).map((r) => ({
        path: r.dimensionValues?.[0]?.value ?? '',
        pageviews: Number(r.metricValues?.[0]?.value ?? 0),
      })),
      topEvents: (eventsRes.rows ?? []).map((r) => ({
        name: r.dimensionValues?.[0]?.value ?? '',
        count: Number(r.metricValues?.[0]?.value ?? 0),
      })),
    };

    res.json(report);
  } catch (err) {
    logger.error('[GoogleAnalytics] report error', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
