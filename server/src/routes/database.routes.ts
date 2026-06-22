import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { databaseService } from '../services/database.service.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

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

  // Verify membership + plan in one query — prevents org_id forgery
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

// ── GET /api/v1/database/status ──────────────────────────────────────────────
router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const record = await databaseService.getStatus(req.user!.id, getProjectId(req));
    res.json({ database: record });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/database/credentials ────────────────────────────────────────
// Returns keys regenerated on-demand (never stored). Plan check enforced so
// downgraded users cannot keep retrieving live JWT keys.
router.get('/credentials', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requirePaidPlan(req, res))) return;
    const creds = await databaseService.getCredentials(req.user!.id, getProjectId(req));
    if (!creds) { res.status(404).json({ error: 'No active database' }); return; }
    res.json(creds);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/v1/database/provision ─────────────────────────────────────────
router.post('/provision', dbProvisionLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { organization_id } = req.body;
    const projectId = getProjectId(req);
    if (!(await requirePaidPlan(req, res, organization_id))) return;
    const record = await databaseService.provision(req.user!.id, organization_id || null, projectId);
    const creds  = await databaseService.getCredentials(req.user!.id, projectId);
    res.status(201).json({ database: record, credentials: creds });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('already_provisioned') ? 409 : 500;
    logger.error('Provision error', err);
    res.status(status).json({ error: msg });
  }
});

// ── DELETE /api/v1/database/deprovision ─────────────────────────────────────
// No plan gate: if you own the database you can always delete it.
router.delete('/deprovision', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await databaseService.deprovision(req.user!.id, getProjectId(req));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/database/ping ───────────────────────────────────────────────
router.get('/ping', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requirePaidPlan(req, res))) return;
    const result = await databaseService.testConnection(req.user!.id, getProjectId(req));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/database/dump ───────────────────────────────────────────────
// Returns a downloadable .sql dump (schema + data) of the tenant's schema.
router.get('/dump', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requirePaidPlan(req, res))) return;
    const { sql, schema, truncated } = await databaseService.dumpDatabase(req.user!.id, getProjectId(req));
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${schema}-dump-${Date.now()}.sql"`);
    if (truncated) res.setHeader('X-Dump-Truncated', 'true');
    res.send(sql);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/database/tables ──────────────────────────────────────────────
router.get('/tables', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requirePaidPlan(req, res))) return;
    const tables = await databaseService.listTables(req.user!.id, getProjectId(req));
    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/database/tables/:table/rows ──────────────────────────────────
router.get('/tables/:table/rows', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requirePaidPlan(req, res))) return;
    const limit  = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
    const offset = parseInt(req.query.offset as string || '0', 10);
    const result = await databaseService.queryTable(req.user!.id, req.params.table, limit, offset, getProjectId(req));
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// ── POST /api/v1/database/query ──────────────────────────────────────────────
// role=anon (default) → SELECT only; role=service → full access (agent uses this)
router.post('/query', dbQueryLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sql, role } = req.body as { sql: string; role?: 'anon' | 'service' };
    if (!sql?.trim()) { res.status(400).json({ error: 'sql required' }); return; }

    // Both roles require a paid plan (anon could otherwise be used by downgraded users)
    if (!(await requirePaidPlan(req, res))) return;

    const result = await databaseService.runQuery(req.user!.id, sql, role || 'anon', getProjectId(req));
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.includes('Only SELECT') || msg.includes('blocked') ? 403 : 500).json({ error: msg });
  }
});

export default router;
