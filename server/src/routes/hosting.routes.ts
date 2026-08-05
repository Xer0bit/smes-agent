/**
 * Server-side proxy for the VPS4 hosting service (custom domains + published
 * builds). Previously src/eCG/Publish/domainService.ts called HOSTING_BASE
 * directly from the browser with VITE_HOSTING_SERVICE_SECRET attached   Vite
 * bundles that into the public JS, so anyone could pull the secret out of the
 * built output and hit the hosting service directly. The secret stays
 * server-side now; each route below enforces the authorization the direct
 * call never had (project ownership for a project's own domain, admin role
 * for the cross-project admin panel).
 */
import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { requireAdmin } from './system.routes.js';
import { projectService } from '../services/project.service.js';
import { supabase } from '../config/database.js';
import { safeErrorMessage } from '../utils/sendError.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(authMiddleware);

const HOSTING_BASE = (process.env.VITE_HOSTING_SERVICE_URL || process.env.HOSTING_SERVICE_URL || '').replace(/\/$/, '');
const HOSTING_SECRET = process.env.VITE_HOSTING_SERVICE_SECRET || process.env.HOSTING_SERVICE_SECRET || '';

function hostingHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (HOSTING_SECRET) headers['x-deploy-secret'] = HOSTING_SECRET;
  return headers;
}

// Every route below deploys, activates a domain, or removes one   all writes,
// so this requires edit access (owner/admin/editor), not just view access.
// A viewer/client collaborator must not be able to deploy or reconfigure domains.
async function ownsProject(projectId: string, userId: string): Promise<boolean> {
  try {
    await projectService.assertCanEditProject(projectId, userId);
    return true;
  } catch (err) {
    // Fail closed either way (deny), but log so a genuine unexpected error
    // here isn't indistinguishable from a normal "not your project" denial.
    logger.warn('[hosting] ownsProject check failed', { projectId, userId, error: (err as Error)?.message ?? String(err) });
    return false;
  }
}

// ── POST /api/v1/hosting/:projectId/deploy ──────────────────────────────────
router.post('/:projectId/deploy', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!HOSTING_BASE) { res.status(500).json({ success: false, error: 'Hosting service not configured.' }); return; }
  if (!(await ownsProject(projectId, req.user!.id))) { res.status(404).json({ success: false, error: 'Project not found or access denied.' }); return; }
  const { slug, files } = req.body ?? {};
  if (!slug || !Array.isArray(files)) { res.status(400).json({ success: false, error: 'slug and files are required.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/deploy/${projectId}`, {
      method: 'POST',
      headers: hostingHeaders(),
      body: JSON.stringify({ files, slug }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!hostingRes.ok) {
      const text = await hostingRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Deploy failed: ${hostingRes.status} ${text}`.slice(0, 300) });
      return;
    }
    const data = await hostingRes.json().catch(() => ({}));
    res.json({ success: true, hostingUrl: (data as any)?.siteUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/hosting/:projectId/verify-domain ───────────────────────────
router.post('/:projectId/verify-domain', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!HOSTING_BASE) { res.status(500).json({ verified: false, error: 'Hosting service not configured.' }); return; }
  if (!(await ownsProject(projectId, req.user!.id))) { res.status(404).json({ verified: false, error: 'Project not found or access denied.' }); return; }
  const { domain } = req.body ?? {};
  if (!domain) { res.status(400).json({ verified: false, error: 'domain is required.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/domains/verify`, {
      method: 'POST',
      headers: hostingHeaders(),
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!hostingRes.ok) { res.status(502).json({ verified: false, error: `Hosting service error ${hostingRes.status}` }); return; }
    res.json(await hostingRes.json());
  } catch (err) {
    res.status(500).json({ verified: false, error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/hosting/:projectId/activate-domain ─────────────────────────
router.post('/:projectId/activate-domain', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!HOSTING_BASE) { res.status(500).json({ success: false, error: 'Hosting service not configured.' }); return; }
  if (!(await ownsProject(projectId, req.user!.id))) { res.status(404).json({ success: false, error: 'Project not found or access denied.' }); return; }
  const { domain } = req.body ?? {};
  if (!domain) { res.status(400).json({ success: false, error: 'domain is required.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/domains/activate`, {
      method: 'POST',
      headers: hostingHeaders(),
      body: JSON.stringify({ domain, projectId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!hostingRes.ok) {
      const text = await hostingRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Activation failed: ${hostingRes.status} ${text}` });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── DELETE /api/v1/hosting/:projectId/domain/:domain ────────────────────────
// Project-owner removing their own custom domain   verified against
// project_custom_domains before forwarding, so one owner can't remove a
// domain that belongs to someone else's project.
router.delete('/:projectId/domain/:domain', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId, domain } = req.params;
  if (!HOSTING_BASE) { res.status(500).json({ success: false, error: 'Hosting service not configured.' }); return; }
  if (!(await ownsProject(projectId, req.user!.id))) { res.status(404).json({ success: false, error: 'Project not found or access denied.' }); return; }
  const { data: row } = await supabase
    .from('project_custom_domains')
    .select('id')
    .eq('project_id', projectId)
    .eq('domain', domain)
    .maybeSingle();
  if (!row) { res.status(404).json({ success: false, error: 'Domain not found on this project.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
      headers: hostingHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!hostingRes.ok) {
      const text = await hostingRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Remove failed: ${hostingRes.status} ${text}` });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── DELETE /api/v1/hosting/:projectId/deployment ────────────────────────────
router.delete('/:projectId/deployment', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!HOSTING_BASE) { res.status(500).json({ success: false, error: 'Hosting service not configured.' }); return; }
  if (!(await ownsProject(projectId, req.user!.id))) { res.status(404).json({ success: false, error: 'Project not found or access denied.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/deploy/${projectId}`, {
      method: 'DELETE',
      headers: hostingHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!hostingRes.ok) {
      const text = await hostingRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Remove failed: ${hostingRes.status} ${text}` });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── GET /api/v1/hosting/admin/health ────────────────────────────────────────
router.get('/admin/health', async (req: AuthenticatedRequest, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  if (!HOSTING_BASE) { res.status(500).json(null); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/health`, { signal: AbortSignal.timeout(15_000) });
    if (!hostingRes.ok) { res.status(502).json(null); return; }
    res.json(await hostingRes.json());
  } catch (err) {
    logger.warn('[hosting] admin/health check failed', { error: (err as Error)?.message ?? String(err) });
    res.status(502).json(null);
  }
});

// ── GET /api/v1/hosting/admin/domains ───────────────────────────────────────
router.get('/admin/domains', async (req: AuthenticatedRequest, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  if (!HOSTING_BASE) { res.json({ domains: [], error: 'Hosting service URL not configured' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/domains/list`, { headers: hostingHeaders(), signal: AbortSignal.timeout(15_000) });
    if (hostingRes.status === 401 || hostingRes.status === 403) {
      res.json({ domains: [], error: 'Hosting service rejected credentials (check HOSTING_SERVICE_SECRET on this server).' });
      return;
    }
    if (!hostingRes.ok) { res.json({ domains: [], error: `Hosting service error: ${hostingRes.status}` }); return; }
    const data = await hostingRes.json();
    res.json({ domains: (data as any)?.domains || [] });
  } catch (err) {
    res.json({ domains: [], error: safeErrorMessage(err) });
  }
});

// ── DELETE /api/v1/hosting/admin/domains/:domain ────────────────────────────
router.delete('/admin/domains/:domain', async (req: AuthenticatedRequest, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  if (!HOSTING_BASE) { res.status(500).json({ success: false, error: 'Hosting service not configured.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/domains/${encodeURIComponent(req.params.domain)}`, {
      method: 'DELETE',
      headers: hostingHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!hostingRes.ok) {
      const text = await hostingRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Remove failed: ${hostingRes.status} ${text}` });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── DELETE /api/v1/hosting/admin/deployment/:projectId ──────────────────────
router.delete('/admin/deployment/:projectId', async (req: AuthenticatedRequest, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  if (!HOSTING_BASE) { res.status(500).json({ success: false, error: 'Hosting service not configured.' }); return; }
  try {
    const hostingRes = await fetch(`${HOSTING_BASE}/deploy/${req.params.projectId}`, {
      method: 'DELETE',
      headers: hostingHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!hostingRes.ok) {
      const text = await hostingRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Remove failed: ${hostingRes.status} ${text}` });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

export default router;
