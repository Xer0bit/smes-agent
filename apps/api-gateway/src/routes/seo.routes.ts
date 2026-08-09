import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';
import { deployProjectToProduction } from '../services/hostingDeploy.service.js';
import { safeErrorMessage } from '../utils/sendError.js';

const router = Router();
router.use(authMiddleware);

// title/description/keywords/robots/OG/structured-data are now owned entirely by
// the per-route system (project_seo_routes, including the "/" root entry   see
// preview-service/server.js's appendRouteSeoFiles/injectSeoMetaJs, applied at
// publish/export time). Keeping them here too would mean two independent code
// paths (this /sync endpoint vs. the export pipeline) both writing index.html's
// <title>/meta tags on different triggers, silently overwriting each other
// depending on which ran last. Only favicon and Google verification stay here  
// genuinely site-wide, not meaningfully "per-page".
interface SeoData {
  favicon?: string;
  google_verification?: string;
}

/** Inject or replace a <meta> tag in the HTML head. */
function injectMeta(html: string, attrs: string, content: string): string {
  // Match any existing tag with the same name/property
  const nameMatch = attrs.match(/name="([^"]+)"/);
  const propMatch = attrs.match(/property="([^"]+)"/);
  const key = nameMatch?.[1] || propMatch?.[1];

  if (key) {
    const existingRe = new RegExp(
      `<meta\\s[^>]*(name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
      'i'
    );
    if (existingRe.test(html)) {
      return html.replace(existingRe, `<meta ${attrs} content="${content}">`);
    }
  }
  // Insert before </head>
  return html.replace('</head>', `  <meta ${attrs} content="${content}">\n</head>`);
}

/** Inject or replace <link rel="icon"> */
function injectFavicon(html: string, href: string): string {
  if (/<link[^>]+rel=["']icon["'][^>]*>/i.test(html)) {
    return html.replace(/<link[^>]+rel=["']icon["'][^>]*>/i, `<link rel="icon" href="${href}">`);
  }
  return html.replace('</head>', `  <link rel="icon" href="${href}">\n</head>`);
}

/** Inject Google verification meta tag */
function injectGoogleVerification(html: string, content: string): string {
  return injectMeta(html, 'name="google-site-verification"', content);
}

export function applySeoToHtml(html: string, seo: SeoData, _projectUrl = ''): string {
  let out = html;
  if (seo.favicon)             out = injectFavicon(out, seo.favicon);
  if (seo.google_verification) out = injectGoogleVerification(out, seo.google_verification);
  return out;
}

// ponytail: sitemap covers the homepage only. The scaffold's HashRouter
// routes (/#/path) aren't distinct crawlable URLs to begin with, so listing
// more entries needs real route detection first   add when BrowserRouter
// projects with discoverable routes are common enough to matter.
function buildSitemapXml(projectUrl: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${projectUrl}</loc>\n    <lastmod>${today}</lastmod>\n  </url>\n</urlset>\n`;
}

// ── POST /api/v1/seo/:projectId/sync ─────────────────────────────────────────
router.post('/:projectId/sync', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    // 1. Verify user can actually edit this project (not just view it)   this
    // writes favicon/verification into the published site.
    let project: any;
    try {
      await projectService.assertCanEditProject(projectId, req.user!.id);
      project = await projectService.getProject(projectId, req.user!.id);
    } catch (projErr) {
      logger.warn('[SEO sync] access check failed', { projectId, userId: req.user!.id, error: (projErr as Error).message });
      res.status(404).json({ error: 'Project not found or access denied.' });
      return;
    }

    // 2. Load SEO settings + project columns in parallel
    const [{ data: setting }, { data: projectFull }] = await Promise.all([
      supabase
        .from('project_settings')
        .select('setting_value')
        .eq('project_id', projectId)
        .eq('setting_key', 'seo')
        .maybeSingle(),
      supabase
        .from('projects')
        .select('name, description, published_subdomain, published_url')
        .eq('id', projectId)
        .maybeSingle(),
    ]);

    const projectSubdomain = projectFull?.published_subdomain || project.slug || '';
    const projectCustomDomain = (() => {
      const url = (projectFull?.published_url as string) ?? '';
      return url && !url.includes('ecomgear.app') ? url.replace(/^https?:\/\//, '') : '';
    })();

    const saved = (setting?.setting_value as SeoData) ?? {};
    const seo: SeoData = {
      favicon:             saved.favicon             || '',
      google_verification: saved.google_verification || '',
    };

    // 3. The project's real index.html lives on VPS2 (preview-service)   the
    // live dev-server source that /export builds from   not on this server's
    // disk. The client sends its current content (same source used for
    // GitHub push / header-integrations sync).
    const original = req.body?.indexHtml as string | undefined;
    if (!original) {
      res.status(400).json({ error: 'No index.html content provided to sync.' });
      return;
    }

    const projectUrl = projectCustomDomain
      ? `https://${projectCustomDomain}`
      : projectSubdomain
        ? `https://${projectSubdomain}.ecomgear.app`
        : '';

    const updated = applySeoToHtml(original, seo, projectUrl);

    const PREVIEW_BASE = (process.env.VITE_PREVIEW_SERVICE_URL || process.env.PREVIEW_SERVICE_URL || '').replace(/\/$/, '');
    const PREVIEW_UPDATE_SECRET = process.env.PREVIEW_UPDATE_SECRET || '';

    // 4. Write index.html (+ robots.txt/sitemap.xml, if applicable) into the
    // live preview project before exporting   /export builds from that source
    // directory. robots.txt/sitemap.xml are written whenever their settings
    // are on, even if index.html itself didn't change (those are separate
    // files, not something index.html-diffing alone would catch).
    const filesToWrite: { path: string; content: string }[] = [];
    if (updated !== original) filesToWrite.push({ path: 'index.html', content: updated });
    // Per-page robots directives live on each route's own entry now (including
    // "/")   this file-level robots.txt is just the crawl-wide default.
    filesToWrite.push({ path: 'public/robots.txt', content: `User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n` });
    if (projectUrl) {
      filesToWrite.push({ path: 'public/sitemap.xml', content: buildSitemapXml(projectUrl) });
    }

    if (filesToWrite.length === 0) {
      res.json({ message: 'index.html already up to date   no changes needed.', changed: false });
      return;
    }

    if (!PREVIEW_BASE) {
      res.status(500).json({ error: 'Preview service is not configured on this server.' });
      return;
    }

    const updateRes = await fetch(`${PREVIEW_BASE}/preview/${projectId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PREVIEW_UPDATE_SECRET ? { 'x-update-secret': PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ files: filesToWrite }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!updateRes.ok) {
      res.status(502).json({ error: `Failed to write index.html to preview service: ${updateRes.status}` });
      return;
    }

    // 5. Trigger production rebuild + redeploy.
    //    Flow: VPS2 (preview-service) → vite build → export built dist/ files
    //          VPS4 (hosting-service) → serve built files at user's domain
    const { productionDeployed, deployError } = await deployProjectToProduction(projectId);

    res.json({
      changed: true,
      productionDeployed,
      deployError,
      message: productionDeployed
        ? 'SEO synced and production site rebuilt   live immediately.'
        : deployError
          ? `SEO saved to source. Production redeploy failed: ${deployError}. Re-publish your app to go live.`
          : 'SEO synced to source. Re-publish your app from the editor to push changes live.',
      requiresRepublish: !productionDeployed,
    });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── Per-route SEO overrides + redirects (project_seo_routes / project_redirects) ──
// Same access pattern as /sync above: verify project access explicitly here rather
// than relying solely on RLS, since this server's supabase client uses the service
// role key (bypasses RLS)   RLS on these tables only protects direct client-side
// Supabase calls, not this API path.

async function requireProjectAccess(req: AuthenticatedRequest, res: Response, projectId: string): Promise<boolean> {
  try {
    await projectService.getProject(projectId, req.user!.id);
    return true;
  } catch (err) {
    logger.warn('[SEO routes] access check failed', { projectId, userId: req.user!.id, error: (err as Error).message });
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// Write variant   viewer/client collaborators can see SEO settings but must
// not be able to change them (they affect the published site).
async function requireProjectEditAccess(req: AuthenticatedRequest, res: Response, projectId: string): Promise<boolean> {
  try {
    await projectService.assertCanEditProject(projectId, req.user!.id);
    return true;
  } catch (err) {
    logger.warn('[SEO routes] edit access check failed', { projectId, userId: req.user!.id, error: (err as Error).message });
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// GET /api/v1/seo/:projectId/routes   list all per-route SEO overrides
router.get('/:projectId/routes', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!(await requireProjectAccess(req, res, projectId))) return;
  const { data, error } = await supabase
    .from('project_seo_routes')
    .select('*')
    .eq('project_id', projectId)
    .order('route_path', { ascending: true });
  if (error) { res.status(500).json({ error: safeErrorMessage(error) }); return; }
  res.json({ routes: data ?? [] });
});

// PUT /api/v1/seo/:projectId/routes   upsert one route's SEO (keyed by route_path)
router.put('/:projectId/routes', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!(await requireProjectEditAccess(req, res, projectId))) return;
  const { route_path } = req.body ?? {};
  if (!route_path || typeof route_path !== 'string') {
    res.status(400).json({ error: 'route_path is required.' });
    return;
  }
  const allowedFields = [
    'title', 'description', 'keywords', 'og_title', 'og_description', 'og_image',
    'canonical_url', 'robots', 'structured_data_type', 'structured_data',
  ] as const;
  const payload: Record<string, unknown> = { project_id: projectId, route_path, updated_at: new Date().toISOString() };
  for (const f of allowedFields) if (f in (req.body ?? {})) payload[f] = req.body[f];

  const { data, error } = await supabase
    .from('project_seo_routes')
    .upsert(payload, { onConflict: 'project_id,route_path' })
    .select()
    .single();
  if (error) { res.status(500).json({ error: safeErrorMessage(error) }); return; }
  res.json({ route: data });
});

// DELETE /api/v1/seo/:projectId/routes/:routeId
router.delete('/:projectId/routes/:routeId', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId, routeId } = req.params;
  if (!(await requireProjectEditAccess(req, res, projectId))) return;
  const { error } = await supabase
    .from('project_seo_routes')
    .delete()
    .eq('id', routeId)
    .eq('project_id', projectId);
  if (error) { res.status(500).json({ error: safeErrorMessage(error) }); return; }
  res.json({ success: true });
});

// GET /api/v1/seo/:projectId/redirects
router.get('/:projectId/redirects', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!(await requireProjectAccess(req, res, projectId))) return;
  const { data, error } = await supabase
    .from('project_redirects')
    .select('*')
    .eq('project_id', projectId)
    .order('from_path', { ascending: true });
  if (error) { res.status(500).json({ error: safeErrorMessage(error) }); return; }
  res.json({ redirects: data ?? [] });
});

// POST /api/v1/seo/:projectId/redirects   create a redirect rule
router.post('/:projectId/redirects', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  if (!(await requireProjectEditAccess(req, res, projectId))) return;
  const { from_path, to_path, status_code } = req.body ?? {};
  if (!from_path || typeof from_path !== 'string' || !to_path || typeof to_path !== 'string') {
    res.status(400).json({ error: 'from_path and to_path are required.' });
    return;
  }
  const code = status_code === 302 ? 302 : 301;
  const { data, error } = await supabase
    .from('project_redirects')
    .insert({ project_id: projectId, from_path, to_path, status_code: code })
    .select()
    .single();
  if (error) {
    // Unique constraint on (project_id, from_path)
    const status = (error as any).code === '23505' ? 409 : 500;
    res.status(status).json({ error: status === 409 ? `A redirect from "${from_path}" already exists.` : error.message });
    return;
  }
  res.json({ redirect: data });
});

// PUT /api/v1/seo/:projectId/redirects/:redirectId   update a redirect rule
router.put('/:projectId/redirects/:redirectId', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId, redirectId } = req.params;
  if (!(await requireProjectEditAccess(req, res, projectId))) return;
  const { from_path, to_path, status_code } = req.body ?? {};
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof from_path === 'string') payload.from_path = from_path;
  if (typeof to_path === 'string') payload.to_path = to_path;
  if (status_code === 301 || status_code === 302) payload.status_code = status_code;

  const { data, error } = await supabase
    .from('project_redirects')
    .update(payload)
    .eq('id', redirectId)
    .eq('project_id', projectId)
    .select()
    .single();
  if (error) { res.status(500).json({ error: safeErrorMessage(error) }); return; }
  res.json({ redirect: data });
});

// DELETE /api/v1/seo/:projectId/redirects/:redirectId
router.delete('/:projectId/redirects/:redirectId', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId, redirectId } = req.params;
  if (!(await requireProjectEditAccess(req, res, projectId))) return;
  const { error } = await supabase
    .from('project_redirects')
    .delete()
    .eq('id', redirectId)
    .eq('project_id', projectId);
  if (error) { res.status(500).json({ error: safeErrorMessage(error) }); return; }
  res.json({ success: true });
});

export default router;
