import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(authMiddleware);

interface SeoData {
  title?: string;
  description?: string;
  keywords?: string;
  favicon?: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  robots?: string;
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

/** Inject or replace <title> */
function injectTitle(html: string, title: string): string {
  if (/<title>/i.test(html)) {
    return html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  }
  return html.replace('</head>', `  <title>${title}</title>\n</head>`);
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

const STRUCTURED_DATA_ID = 'ecomgear-structured-data';

/** Inject or replace a JSON-LD WebSite schema block, keyed by a stable id so re-syncing replaces instead of duplicating. */
function injectStructuredData(html: string, seo: SeoData, projectUrl: string): string {
  const schema: Record<string, string> = { '@context': 'https://schema.org', '@type': 'WebSite' };
  if (seo.title) schema.name = seo.title;
  if (seo.description) schema.description = seo.description;
  if (projectUrl) schema.url = projectUrl;

  const script = `<script type="application/ld+json" id="${STRUCTURED_DATA_ID}">${JSON.stringify(schema)}</script>`;
  const existingRe = new RegExp(`<script[^>]+id=["']${STRUCTURED_DATA_ID}["'][^>]*>[\\s\\S]*?<\\/script>`, 'i');
  if (existingRe.test(html)) return html.replace(existingRe, script);
  return html.replace('</head>', `  ${script}\n</head>`);
}

export function applySeoToHtml(html: string, seo: SeoData, projectUrl = ''): string {
  let out = html;

  if (seo.title)               out = injectTitle(out, seo.title);
  if (seo.description)         out = injectMeta(out, 'name="description"', seo.description);
  if (seo.keywords)            out = injectMeta(out, 'name="keywords"', seo.keywords);
  if (seo.robots)              out = injectMeta(out, 'name="robots"', seo.robots);
  if (seo.favicon)             out = injectFavicon(out, seo.favicon);
  if (seo.google_verification) out = injectGoogleVerification(out, seo.google_verification);

  // Open Graph
  const ogTitle = seo.og_title || seo.title;
  const ogDesc  = seo.og_description || seo.description;
  if (ogTitle)      out = injectMeta(out, 'property="og:title"', ogTitle);
  if (ogDesc)       out = injectMeta(out, 'property="og:description"', ogDesc);
  if (seo.og_image) out = injectMeta(out, 'property="og:image"', seo.og_image);
  if (projectUrl)   out = injectMeta(out, 'property="og:url"', projectUrl);

  // Twitter Card
  if (ogTitle)      out = injectMeta(out, 'name="twitter:card"', 'summary_large_image');
  if (ogTitle)      out = injectMeta(out, 'name="twitter:title"', ogTitle);
  if (ogDesc)       out = injectMeta(out, 'name="twitter:description"', ogDesc);
  if (seo.og_image) out = injectMeta(out, 'name="twitter:image"', seo.og_image);

  // Structured data (JSON-LD)
  if (seo.title || projectUrl) out = injectStructuredData(out, seo, projectUrl);

  return out;
}

// ponytail: sitemap covers the homepage only. The scaffold's HashRouter
// routes (/#/path) aren't distinct crawlable URLs to begin with, so listing
// more entries needs real route detection first — add when BrowserRouter
// projects with discoverable routes are common enough to matter.
function buildSitemapXml(projectUrl: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${projectUrl}</loc>\n    <lastmod>${today}</lastmod>\n  </url>\n</urlset>\n`;
}

// ── POST /api/v1/seo/:projectId/sync ─────────────────────────────────────────
router.post('/:projectId/sync', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    // 1. Verify user has access to this project (owner, org admin, or explicit member)
    let project: any;
    try {
      project = await projectService.getProject(projectId, req.user!.id);
    } catch (projErr) {
      logger.warn('[SEO sync] getProject failed', { projectId, userId: req.user!.id, error: (projErr as Error).message });
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
      title:              saved.title              || (projectFull as any)?.name        || '',
      description:        saved.description        || (projectFull as any)?.description || '',
      keywords:           saved.keywords           || '',
      favicon:            saved.favicon            || '',
      og_title:           saved.og_title           || '',
      og_description:     saved.og_description     || '',
      og_image:           saved.og_image           || '',
      robots:             saved.robots             || 'index, follow',
      google_verification: saved.google_verification || '',
    };

    // 3. The project's real index.html lives on VPS2 (preview-service) — the
    // live dev-server source that /export builds from — not on this server's
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
    const HOSTING_BASE  = (process.env.VITE_HOSTING_SERVICE_URL || process.env.HOSTING_SERVICE_URL || '').replace(/\/$/, '');
    const HOSTING_SECRET = process.env.VITE_HOSTING_SERVICE_SECRET || process.env.HOSTING_SERVICE_SECRET || '';
    const PREVIEW_UPDATE_SECRET = process.env.PREVIEW_UPDATE_SECRET || '';

    // 4. Write index.html (+ robots.txt/sitemap.xml, if applicable) into the
    // live preview project before exporting — /export builds from that source
    // directory. robots.txt/sitemap.xml are written whenever their settings
    // are on, even if index.html itself didn't change (those are separate
    // files, not something index.html-diffing alone would catch).
    const filesToWrite: { path: string; content: string }[] = [];
    if (updated !== original) filesToWrite.push({ path: 'index.html', content: updated });
    if (seo.robots) {
      const robotsContent = seo.robots.includes('noindex')
        ? `User-agent: *\nDisallow: /\n`
        : `User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n`;
      filesToWrite.push({ path: 'public/robots.txt', content: robotsContent });
    }
    if (projectUrl) {
      filesToWrite.push({ path: 'public/sitemap.xml', content: buildSitemapXml(projectUrl) });
    }

    if (filesToWrite.length === 0) {
      res.json({ message: 'index.html already up to date — no changes needed.', changed: false });
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

    // 5. Trigger production rebuild + redeploy if hosting is configured.
    //    Flow: VPS2 (preview-service) → vite build → export built dist/ files
    //          VPS4 (hosting-service) → serve built files at user's domain
    let productionDeployed = false;
    let deployError: string | null = null;

    if (PREVIEW_BASE && HOSTING_BASE) {
      try {
        // Step A: ask VPS2 to export a fresh production build (runs vite build)
        const exportRes = await fetch(`${PREVIEW_BASE}/preview/${projectId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(120_000), // 2 min build timeout
        });

        if (exportRes.ok) {
          const exportData = await exportRes.json() as { success: boolean; files?: { path: string; content: string }[]; error?: string };
          if (exportData.success && Array.isArray(exportData.files)) {
            // Step B: push the built files to VPS4 (hosting service)
            const deployHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
            if (HOSTING_SECRET) deployHeaders['x-deploy-secret'] = HOSTING_SECRET;

            // Look up current slug from published_versions
            const { data: published } = await supabase
              .from('published_versions')
              .select('subdomain')
              .eq('project_id', projectId)
              .eq('status', 'published')
              .order('published_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            const deployRes = await fetch(`${HOSTING_BASE}/deploy/${projectId}`, {
              method: 'POST',
              headers: deployHeaders,
              body: JSON.stringify({
                files: exportData.files,
                slug: (published as any)?.subdomain,
              }),
              signal: AbortSignal.timeout(60_000),
            });

            productionDeployed = deployRes.ok;
            if (!deployRes.ok) {
              const txt = await deployRes.text().catch(() => '');
              deployError = `Deploy to hosting failed: ${deployRes.status} ${txt}`.slice(0, 200);
            }
          } else {
            deployError = exportData.error || 'Build export returned no files';
          }
        } else {
          deployError = `Build export failed: ${exportRes.status}`;
        }
      } catch (deployErr: any) {
        deployError = deployErr?.message ?? 'Production redeploy error';
      }
    }

    res.json({
      changed: true,
      productionDeployed,
      deployError,
      message: productionDeployed
        ? 'SEO synced and production site rebuilt — live immediately.'
        : deployError
          ? `SEO saved to source. Production redeploy failed: ${deployError}. Re-publish your app to go live.`
          : 'SEO synced to source. Re-publish your app from the editor to push changes live.',
      requiresRepublish: !productionDeployed,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
