import { Router, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';

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

function resolveProjectPath(projectId: string, serverPath?: string): string {
  if (serverPath) return serverPath;
  if (process.env.SERVER_PROJECTS_DIR) return path.join(process.env.SERVER_PROJECTS_DIR, projectId);
  if (process.env.NODE_ENV === 'production') return path.join('/var/ecomgear/projects', projectId);
  const localBase = process.env.LOCAL_PREVIEW_DATA || path.join(os.homedir(), '.ecomgear', 'preview');
  return path.join(localBase, projectId);
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

function applySeoToHtml(html: string, seo: SeoData, projectUrl = ''): string {
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

  return out;
}

// ── POST /api/v1/seo/:projectId/sync ─────────────────────────────────────────
router.post('/:projectId/sync', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    // 1. Verify user owns this project
    const { data: project } = await supabase
      .from('projects')
      .select('id, name, custom_domain, subdomain')
      .eq('id', projectId)
      .eq('user_id', req.user!.id)
      .maybeSingle();

    if (!project) {
      res.status(404).json({ error: 'Project not found or access denied.' });
      return;
    }

    // 2. Load SEO settings from DB
    const { data: setting } = await supabase
      .from('project_settings')
      .select('setting_value')
      .eq('project_id', projectId)
      .eq('setting_key', 'seo')
      .maybeSingle();

    const seo: SeoData = (setting?.setting_value as SeoData) ?? {};

    if (!seo.title && !seo.description && !seo.og_title) {
      res.status(400).json({ error: 'No SEO settings saved yet. Fill in at least a title and description first.' });
      return;
    }

    // 3. Resolve project path
    const { data: serverPathRow } = await supabase
      .from('projects')
      .select('server_path')
      .eq('id', projectId)
      .maybeSingle();

    const appPath = resolveProjectPath(projectId, (serverPathRow as any)?.server_path);
    const htmlPath = path.join(appPath, 'index.html');

    if (!fs.existsSync(htmlPath)) {
      res.status(404).json({ error: 'index.html not found — the project has not been built yet. Ask the agent to build it first.' });
      return;
    }

    // 4. Read, inject, write back
    const original = fs.readFileSync(htmlPath, 'utf8');
    const projectUrl = project.custom_domain
      ? `https://${project.custom_domain}`
      : project.subdomain
        ? `https://${project.subdomain}.ecomgear.app`
        : '';

    const updated = applySeoToHtml(original, seo, projectUrl);

    if (updated === original) {
      res.json({ message: 'index.html already up to date — no changes needed.', changed: false });
      return;
    }

    fs.writeFileSync(htmlPath, updated, 'utf8');

    // 5. Also write/update public/robots.txt if robots setting is present
    if (seo.robots) {
      const publicDir = path.join(appPath, 'public');
      if (fs.existsSync(publicDir)) {
        const robotsContent = seo.robots.includes('noindex')
          ? `User-agent: *\nDisallow: /\n`
          : `User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n`;
        fs.writeFileSync(path.join(publicDir, 'robots.txt'), robotsContent, 'utf8');
      }
    }

    // 6. Trigger production rebuild + redeploy if hosting is configured.
    //    Flow: VPS2 (preview-service) → vite build → export built dist/ files
    //          VPS4 (hosting-service) → serve built files at user's domain
    const PREVIEW_BASE = (process.env.VITE_PREVIEW_SERVICE_URL || process.env.PREVIEW_SERVICE_URL || '').replace(/\/$/, '');
    const HOSTING_BASE  = (process.env.VITE_HOSTING_SERVICE_URL || process.env.HOSTING_SERVICE_URL || '').replace(/\/$/, '');
    const HOSTING_SECRET = process.env.VITE_HOSTING_SERVICE_SECRET || process.env.HOSTING_SERVICE_SECRET || '';

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

// ── GET /api/v1/seo/:projectId/preview — return current index.html head tags ─
router.get('/:projectId/preview', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', req.user!.id)
      .maybeSingle();

    if (!project) { res.status(404).json({ error: 'Not found' }); return; }

    const { data: serverPathRow } = await supabase
      .from('projects').select('server_path').eq('id', projectId).maybeSingle();
    const appPath = resolveProjectPath(projectId, (serverPathRow as any)?.server_path);
    const htmlPath = path.join(appPath, 'index.html');

    if (!fs.existsSync(htmlPath)) {
      res.json({ synced: false, message: 'No index.html found yet.' });
      return;
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const descMatch  = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    const robotsMatch = html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i);

    res.json({
      synced: true,
      current: {
        title: titleMatch?.[1] ?? '',
        description: descMatch?.[1] ?? '',
        robots: robotsMatch?.[1] ?? '',
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
