import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { requireAdmin } from './system.routes.js';
import { databaseService } from '../services/database.service.js';
import { supabase } from '../config/database.js';
import { safeErrorMessage } from '../utils/sendError.js';

const router = Router();
router.use(authMiddleware);

// Admin actions on a tenant database not owned by the calling user. All reads
// (listing tenant_databases) already work for admins via RLS directly from
// the frontend   these routes only cover the writes RLS blocks.
async function getOwner(id: string): Promise<{ user_id: string; project_id: string | null } | null> {
  const { data } = await supabase
    .from('tenant_databases')
    .select('user_id, project_id')
    .eq('id', id)
    .maybeSingle();
  return data ?? null;
}

// ── GET /api/v1/admin/database/:id/ping ─────────────────────────────────────
router.get('/:id/ping', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const owner = await getOwner(req.params.id);
    if (!owner) { res.status(404).json({ error: 'Tenant database not found' }); return; }
    const result = await databaseService.testConnection(owner.user_id, owner.project_id ?? undefined);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/admin/database/:id/dump ─────────────────────────────────────
router.get('/:id/dump', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const owner = await getOwner(req.params.id);
    if (!owner) { res.status(404).json({ error: 'Tenant database not found' }); return; }
    const { sql, schema, truncated } = await databaseService.dumpDatabase(owner.user_id, owner.project_id ?? undefined);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${schema}-dump-${Date.now()}.sql"`);
    if (truncated) res.setHeader('X-Dump-Truncated', 'true');
    res.send(sql);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/admin/database/:id/deprovision ─────────────────────────────
router.post('/:id/deprovision', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const owner = await getOwner(req.params.id);
    if (!owner) { res.status(404).json({ error: 'Tenant database not found' }); return; }
    await databaseService.deprovision(owner.user_id, owner.project_id ?? undefined);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

export default router;
