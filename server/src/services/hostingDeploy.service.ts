/**
 * Shared production deploy flow: export a fresh Vite build from preview-service
 * (VPS2), then push the built files to hosting-service (VPS4).
 *
 * Extracted from seo.routes.ts / header-integrations.routes.ts, which both had
 * this exact block inline   a third caller (publish_site agent tool) made the
 * duplication worth collapsing.
 */
import { supabase } from '../config/database.js';

const PREVIEW_BASE = (process.env.VITE_PREVIEW_SERVICE_URL || process.env.PREVIEW_SERVICE_URL || '').replace(/\/$/, '');
const HOSTING_BASE = (process.env.VITE_HOSTING_SERVICE_URL || process.env.HOSTING_SERVICE_URL || '').replace(/\/$/, '');
const HOSTING_SECRET = process.env.VITE_HOSTING_SERVICE_SECRET || process.env.HOSTING_SERVICE_SECRET || '';

export interface DeployResult {
  productionDeployed: boolean;
  deployError: string | null;
  hostingUrl?: string;
}

export async function deployProjectToProduction(projectId: string): Promise<DeployResult> {
  if (!PREVIEW_BASE || !HOSTING_BASE) {
    return { productionDeployed: false, deployError: 'Preview or hosting service not configured on this server.' };
  }

  try {
    const exportRes = await fetch(`${PREVIEW_BASE}/preview/${projectId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
    });

    if (!exportRes.ok) {
      return { productionDeployed: false, deployError: `Build export failed: ${exportRes.status}` };
    }
    const exportData = await exportRes.json() as { success: boolean; files?: { path: string; content: string }[]; error?: string };
    if (!exportData.success || !Array.isArray(exportData.files)) {
      return { productionDeployed: false, deployError: exportData.error || 'Build export returned no files' };
    }

    const deployHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (HOSTING_SECRET) deployHeaders['x-deploy-secret'] = HOSTING_SECRET;

    const { data: published } = await supabase
      .from('published_versions')
      .select('subdomain')
      .eq('project_id', projectId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!(published as any)?.subdomain) {
      return { productionDeployed: false, deployError: 'Project has not been published yet   publish it once from the editor first.' };
    }

    const deployRes = await fetch(`${HOSTING_BASE}/deploy/${projectId}`, {
      method: 'POST',
      headers: deployHeaders,
      body: JSON.stringify({ files: exportData.files, slug: (published as any).subdomain }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!deployRes.ok) {
      const txt = await deployRes.text().catch(() => '');
      return { productionDeployed: false, deployError: `Deploy to hosting failed: ${deployRes.status} ${txt}`.slice(0, 200) };
    }
    const data = await deployRes.json().catch(() => ({})) as { siteUrl?: string };
    return { productionDeployed: true, deployError: null, hostingUrl: data.siteUrl };
  } catch (err: any) {
    return { productionDeployed: false, deployError: err?.message ?? 'Production redeploy error' };
  }
}
