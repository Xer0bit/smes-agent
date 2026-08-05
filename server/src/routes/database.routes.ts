import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { databaseService, buildProjectEnvSecrets } from '../services/database.service.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { projectService } from '../services/project.service.js';
import { safeErrorMessage } from '../utils/sendError.js';

const router = Router();
router.use(authMiddleware);

const dbProvisionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many provision requests, try again later.' } });
const dbQueryLimiter    = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Query rate limit exceeded.' } });

// ── Extract project_id from request (query param, body, or header) ───────────
function getProjectId(req: AuthenticatedRequest): string | undefined {
  return (req.query.project_id as string | undefined)
      || (req.body?.project_id as string | undefined)
      || (req.headers['x-project-id'] as string | undefined)
      || undefined;
}

// ── Plan gate ────────────────────────────────────────────────────────────────
// Verifies BOTH that the org has a paid plan AND that the requesting user is
// actually a member of that org (prevents org_id forgery from the request body).
async function requirePaidPlan(req: AuthenticatedRequest, res: Response, organizationId?: string | null): Promise<boolean> {
  const projectId = getProjectId(req);
  let orgId = organizationId ?? null;
  if (!orgId) {
    const existing = await databaseService.getStatus(req.user!.id, projectId);
    orgId = existing?.organization_id ?? null;
  }
  if (!orgId) {
    res.status(403).json({ error: 'Hosted databases require a Pro or Agency plan.' });
    return false;
  }

  // Verify membership + plan in one query   prevents org_id forgery
  const { data } = await supabase
    .from('organizations')
    .select('plan_tier, org_members!inner(user_id)')
    .eq('id', orgId)
    .eq('org_members.user_id', req.user!.id)
    .maybeSingle();

  if (!data) {
    res.status(403).json({ error: 'Organization not found or you are not a member.' });
    return false;
  }
  const tier = (data as any)?.plan_tier || 'free';
  if (tier === 'free') {
    res.status(403).json({ error: 'Hosted databases require a Pro or Agency plan.' });
    return false;
  }
  return true;
}

// getStatus()/getCredentials()/etc below filter purely by project_id and never
// verify the caller owns it   any authenticated user who knows/guesses another
// project's ID could read or act on that project's hosted database. These two
// helpers close that gap; read ops accept any accepted role (owner down to
// viewer/client), write/destructive/export ops require editor+.
async function requireProjectView(req: AuthenticatedRequest, res: Response, projectId?: string): Promise<boolean> {
  // 2026-08 audit flagged this as fail-open. It isn't a bypass: every
  // downstream operation on the legacy (pre-project-scoping) path filters by
  // req.user!.id itself (see databaseService.getStatus/getCredentials's
  // projectId-undefined branch), so a caller can only ever reach their OWN
  // resources this way regardless of this check. Left as fail-open-by-design
  // rather than flipped to fail-closed: doing that would 404 every legacy
  // tenant-database row (provisioned before project_id existed) outright.
  // The real invariant this relies on: any NEW route added here must keep
  // scoping its own projectId-undefined branch by the caller's user_id --
  // this helper alone does not enforce that for a future caller.
  if (!projectId) return true;
  try {
    await projectService.getProject(projectId, req.user!.id);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}
async function requireProjectEdit(req: AuthenticatedRequest, res: Response, projectId?: string): Promise<boolean> {
  if (!projectId) return true;
  try {
    await projectService.assertCanEditProject(projectId, req.user!.id);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// ── GET /api/v1/database/status ──────────────────────────────────────────────
router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectView(req, res, projectId))) return;
    const record = await databaseService.getStatus(req.user!.id, projectId);
    res.json({ database: record });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/database/credentials ────────────────────────────────────────
// Returns keys regenerated on-demand (never stored). Plan check enforced so
// downgraded users cannot keep retrieving live JWT keys.
router.get('/credentials', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const creds = await databaseService.getCredentials(req.user!.id, projectId);
    if (!creds) { res.status(404).json({ error: 'No active database' }); return; }
    res.json(creds);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/database/sync-secrets ──────────────────────────────────────
// The Settings "Sync" button. getCredentials() only upserts VITE_DB_*/
// VITE_FUNCTIONS_API_URL into the project_secrets TABLE   it never reaches the
// live preview, which only reads a .env.local file written by the preview
// service's own /secrets endpoint. Without this, the running app's
// import.meta.env.VITE_DB_API_URL stays undefined ("Database API URL is not
// configured") even though the row exists in project_secrets. This pushes the
// full current secret set to the preview so it takes effect immediately.
router.post('/sync-secrets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
    if (!(await requireProjectEdit(req, res, projectId))) return;

    // buildProjectEnvSecrets is the single source of truth (see database.service.ts)  
    // it upserts auth + DB/functions rows as a side effect and returns the full merged
    // set, so this route never needs its own derivation logic to drift out of sync.
    const secrets = await buildProjectEnvSecrets(req.user!.id, projectId);

    const previewBase = (process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
    const previewRes = await fetch(`${previewBase}/preview/${projectId}/secrets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ secrets: secrets ?? [] }),
    });
    if (!previewRes.ok) throw new Error(`Preview service responded ${previewRes.status}`);
    const previewResult = await previewRes.json().catch(() => ({})) as { restarted?: boolean };

    res.json({ synced: (secrets ?? []).length, restarted: Boolean(previewResult.restarted) });
  } catch (err) {
    logger.error('sync-secrets error', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/database/preview-update ────────────────────────────────────
// Proxies a file push to the preview service so the browser never has to hold
// PREVIEW_UPDATE_SECRET. Previously src/services/previewHealthService.ts sent
// this secret straight from the client as VITE_PREVIEW_UPDATE_SECRET, which
// Vite bundles into the public JS   anyone could pull it out of the built
// output and hit the preview service's /update endpoint directly. The secret
// stays server-side now; the client just needs to be an authenticated owner
// of the project.
router.post('/preview-update', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
    const files = req.body?.files;
    if (!Array.isArray(files)) { res.status(400).json({ error: 'files array is required.' }); return; }
    const fullSync = req.body?.fullSync !== false;

    if (!(await requireProjectEdit(req, res, projectId))) return;

    const previewBase = (process.env.PREVIEW_SERVICE_URL || process.env.VITE_PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
    const previewRes = await fetch(`${previewBase}/preview/${projectId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ files, fullSync }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!previewRes.ok) {
      const text = await previewRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Preview service error ${previewRes.status}: ${text}` });
      return;
    }
    const data = await previewRes.json().catch(() => ({}));
    res.json({ success: true, session: (data as any)?.session });
  } catch (err) {
    logger.error('preview-update error', err);
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/database/provision ─────────────────────────────────────────
router.post('/provision', dbProvisionLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { organization_id } = req.body;
    const projectId = getProjectId(req);
    if (!(await requireProjectEdit(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res, organization_id))) return;
    const record = await databaseService.provision(req.user!.id, organization_id || null, projectId);
    const creds  = await databaseService.getCredentials(req.user!.id, projectId);
    res.status(201).json({ database: record, credentials: creds });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('already_provisioned') ? 409 : 500;
    // 409's message is a known, safe, internally-generated string ("already_provisioned"),
    // not upstream error detail   fine to return as-is. Anything reaching the 500
    // branch is unexpected and gets sanitized like every other 500 in this file.
    res.status(status).json({ error: status === 409 ? msg : safeErrorMessage(err, 'Provision error') });
  }
});

// ── DELETE /api/v1/database/deprovision ─────────────────────────────────────
// No plan gate: if you own the database you can always delete it.
// Irreversible (DROP SCHEMA ... CASCADE, see database.service.ts) -- requires
// the caller to echo the tenant's exact schema_name as a typed confirmation,
// so a single accidental/forged DELETE can't wipe a tenant database outright.
// Rate-limited to match /provision's existing pattern (this route had none).
router.delete('/deprovision', dbProvisionLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectEdit(req, res, projectId))) return;

    const status = await databaseService.getStatus(req.user!.id, projectId);
    if (!status) { res.status(404).json({ error: 'No database provisioned for this project.' }); return; }

    const confirm = (req.body?.confirm as string | undefined)?.trim();
    if (confirm !== status.schema_name) {
      res.status(400).json({
        error: 'Confirmation required. Pass { "confirm": "<schema_name>" } in the request body, exactly matching the database to delete.',
        schema_name: status.schema_name,
      });
      return;
    }

    await databaseService.deprovision(req.user!.id, projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/database/ping ───────────────────────────────────────────────
router.get('/ping', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const result = await databaseService.testConnection(req.user!.id, projectId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/database/dump ───────────────────────────────────────────────
// Returns a downloadable .sql dump (schema + data) of the tenant's schema.
// Full data export   editor+ only, same bar as /query with role=service.
router.get('/dump', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectEdit(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const { sql, schema, truncated } = await databaseService.dumpDatabase(req.user!.id, projectId);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${schema}-dump-${Date.now()}.sql"`);
    if (truncated) res.setHeader('X-Dump-Truncated', 'true');
    res.send(sql);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/database/tables ──────────────────────────────────────────────
router.get('/tables', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const tables = await databaseService.listTables(req.user!.id, projectId);
    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/database/tables/:table/rows ──────────────────────────────────
router.get('/tables/:table/rows', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const limit  = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
    const offset = parseInt(req.query.offset as string || '0', 10);
    const result = await databaseService.queryTable(req.user!.id, req.params.table, limit, offset, projectId);
    res.json(result);
  } catch (err) {
    // Raw message intentionally NOT sanitized here: this is an owner-only
    // (requireProjectView-gated) table-browser tool, not an end-user-facing
    // endpoint -- the caller needs the real DB error to debug their own
    // schema/query, same reasoning as /query below.
    const msg = (err as Error).message;
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// ── POST /api/v1/database/query ──────────────────────────────────────────────
// role=anon (default) → SELECT only, viewer+; role=service → full access
// (bypasses RLS, agent uses this) → editor+ only.
router.post('/query', dbQueryLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sql, role } = req.body as { sql: string; role?: 'anon' | 'service' };
    if (!sql?.trim()) { res.status(400).json({ error: 'sql required' }); return; }

    const projectId = getProjectId(req);
    const accessOk = role === 'service'
      ? await requireProjectEdit(req, res, projectId)
      : await requireProjectView(req, res, projectId);
    if (!accessOk) return;

    // Both roles require a paid plan (anon could otherwise be used by downgraded users)
    if (!(await requirePaidPlan(req, res))) return;

    const result = await databaseService.runQuery(req.user!.id, sql, role || 'anon', projectId);
    res.json(result);
  } catch (err) {
    // Raw message intentionally NOT sanitized: this endpoint runs the
    // caller's own SQL (a DB console/REPL tool, owner-gated above) -- they
    // need the real Postgres error ("column does not exist", syntax error,
    // etc.) to fix their query. Sanitizing would break the feature.
    const msg = (err as Error).message;
    res.status(msg.includes('Only SELECT') || msg.includes('blocked') ? 403 : 500).json({ error: msg });
  }
});

export default router;
