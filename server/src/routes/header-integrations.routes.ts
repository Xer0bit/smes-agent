import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';
import { deployProjectToProduction } from '../services/hostingDeploy.service.js';

const router = Router();
router.use(authMiddleware);

interface HeaderIntegrationsData {
  ga_measurement_id?: string;
  gtm_container_id?: string;
  meta_pixel_id?: string;
  whatsapp_number?: string;
  whatsapp_message?: string;
  custom_head_code?: string;
  custom_body_code?: string;
}

const HEAD_START = '<!-- ecomgear:header-integrations:head:start -->';
const HEAD_END   = '<!-- ecomgear:header-integrations:head:end -->';
const BODY_START = '<!-- ecomgear:header-integrations:body:start -->';
const BODY_END   = '<!-- ecomgear:header-integrations:body:end -->';

/** Replace a previously-injected marker block, or insert a fresh one before the anchor. */
function replaceBlock(html: string, startMarker: string, endMarker: string, block: string, insertBeforeAnchor: string): string {
  const re = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\n?`, 'm');
  const wrapped = block.trim() ? `${startMarker}\n${block.trim()}\n${endMarker}\n` : '';
  if (re.test(html)) return html.replace(re, wrapped);
  if (!wrapped) return html;
  return html.replace(insertBeforeAnchor, `${wrapped}${insertBeforeAnchor}`);
}

function buildHeadSnippets(d: HeaderIntegrationsData): string {
  const parts: string[] = [];

  if (d.ga_measurement_id) {
    const id = d.ga_measurement_id.trim();
    parts.push(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`
    );
  }

  if (d.gtm_container_id) {
    const id = d.gtm_container_id.trim();
    parts.push(
      `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],` +
      `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})` +
      `(window,document,'script','dataLayer','${id}');</script>`
    );
  }

  if (d.meta_pixel_id) {
    const id = d.meta_pixel_id.trim();
    parts.push(
      `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};` +
      `if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;` +
      `s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');` +
      `fbq('init','${id}');fbq('track','PageView');</script>` +
      `<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1" /></noscript>`
    );
  }

  if (d.custom_head_code) parts.push(d.custom_head_code.trim());

  return parts.join('\n');
}

function buildBodySnippets(d: HeaderIntegrationsData): string {
  const parts: string[] = [];

  if (d.gtm_container_id) {
    const id = d.gtm_container_id.trim();
    parts.push(
      `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`
    );
  }

  if (d.whatsapp_number) {
    const number = d.whatsapp_number.replace(/[^\d]/g, '');
    const message = encodeURIComponent(d.whatsapp_message || 'Hi! I have a question.');
    parts.push(
      `<a href="https://wa.me/${number}?text=${message}" target="_blank" rel="noopener noreferrer" ` +
      `style="position:fixed;bottom:20px;right:20px;z-index:9999;width:56px;height:56px;border-radius:50%;` +
      `background:#25D366;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.25);text-decoration:none;" ` +
      `aria-label="Chat on WhatsApp">` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="#fff">` +
      `<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.2h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.2 8.2 0 0 1-4.18-1.14l-.3-.18-3.11.82.83-3.03-.2-.31a8.22 8.22 0 0 1-1.26-4.4c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.55-3.7 8.23-8.26 8.23zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.4-.12-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.43-.06-.13-.56-1.35-.77-1.84-.2-.48-.41-.42-.56-.43-.14-.01-.31-.01-.48-.01-.17 0-.43.06-.66.31-.23.25-.86.84-.86 2.04 0 1.2.88 2.36 1 2.52.13.17 1.73 2.65 4.2 3.71.59.25 1.05.4 1.41.52.59.19 1.13.16 1.55.1.47-.07 1.47-.6 1.68-1.18.2-.58.2-1.08.14-1.18-.06-.11-.23-.17-.48-.29z"/>` +
      `</svg></a>`
    );
  }

  if (d.custom_body_code) parts.push(d.custom_body_code.trim());

  return parts.join('\n');
}

export function applyHeaderIntegrationsToHtml(html: string, data: HeaderIntegrationsData): string {
  let out = html;
  out = replaceBlock(out, HEAD_START, HEAD_END, buildHeadSnippets(data), '</head>');
  out = replaceBlock(out, BODY_START, BODY_END, buildBodySnippets(data), '</body>');
  return out;
}

// ── POST /api/v1/header-integrations/:projectId/sync ─────────────────────────
router.post('/:projectId/sync', async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    try {
      // Injects arbitrary <script> into the published site   viewer/client
      // collaborators must not be able to do this, only owner/admin/editor.
      await projectService.assertCanEditProject(projectId, req.user!.id);
    } catch (projErr) {
      logger.warn('[HeaderIntegrations sync] access check failed', { projectId, userId: req.user!.id, error: (projErr as Error).message });
      res.status(404).json({ error: 'Project not found or access denied.' });
      return;
    }

    const { data: setting } = await supabase
      .from('project_settings')
      .select('setting_value')
      .eq('project_id', projectId)
      .eq('setting_key', 'header_integrations')
      .maybeSingle();

    // The project's real index.html lives on VPS2 (preview-service)   the
    // live dev-server source that /export builds from   not on this server's
    // disk. The client sends its current content (same source the editor and
    // preview already use) so we can inject/update the integration snippets.
    const original = req.body?.indexHtml as string | undefined;
    if (!original) {
      res.status(400).json({ error: 'No index.html content provided to sync.' });
      return;
    }

    const data = (setting?.setting_value as HeaderIntegrationsData) ?? {};
    const updated = applyHeaderIntegrationsToHtml(original, data);

    // Trigger production rebuild + redeploy, same flow as SEO sync:
    // VPS2 (preview-service) exports a fresh build → VPS4 (hosting-service) serves it.
    const PREVIEW_BASE = (process.env.VITE_PREVIEW_SERVICE_URL || process.env.PREVIEW_SERVICE_URL || '').replace(/\/$/, '');
    const PREVIEW_UPDATE_SECRET = process.env.PREVIEW_UPDATE_SECRET || '';

    if (updated === original) {
      res.json({ message: 'index.html already up to date   no changes needed.', changed: false });
      return;
    }

    if (!PREVIEW_BASE) {
      res.status(500).json({ error: 'Preview service is not configured on this server.' });
      return;
    }

    // Write the updated index.html into the live preview project before
    // exporting   /export builds from that source directory.
    const updateRes = await fetch(`${PREVIEW_BASE}/preview/${projectId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PREVIEW_UPDATE_SECRET ? { 'x-update-secret': PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ files: [{ path: 'index.html', content: updated }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!updateRes.ok) {
      res.status(502).json({ error: `Failed to write index.html to preview service: ${updateRes.status}` });
      return;
    }

    const { productionDeployed, deployError } = await deployProjectToProduction(projectId);

    res.json({
      changed: true,
      productionDeployed,
      deployError,
      message: productionDeployed
        ? 'Integrations synced and production site rebuilt   live immediately.'
        : deployError
          ? `Integrations saved to source. Production redeploy failed: ${deployError}. Re-publish your app to go live.`
          : 'Integrations synced to source. Re-publish your app from the editor to push changes live.',
      requiresRepublish: !productionDeployed,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
