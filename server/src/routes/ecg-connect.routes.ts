import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { initProjectFromTemplate } from '../services/baseTemplateService.js';
import { seedEcgTemplate } from '../services/ecg-template.js';
import path from 'node:path';
import fs from 'node:fs';
import { scryptSync, randomBytes } from 'node:crypto';

const router = Router();

const PORTAL_API_URL = process.env.ECG_PORTAL_URL || 'https://api.ecomgear.ai';
const ECG_SERVICE_KEY = process.env.ECG_SERVICE_KEY || '';
// Baked into generated dashboards as the proxy/chat/access endpoint. Defaults
// to api.ecomgear.ai   agent-portal's nginx reverse-proxies the ecg-* routes
// through to this server, so the browser only ever sees one origin.
const ECOMGEAR_SERVER_URL = process.env.ECOMGEAR_SERVER_URL || 'https://api.ecomgear.ai';

function sseWrite(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// POST /api/v1/ecg-connect
// One-time handoff from agent-portal: creates an eComGear project seeded with the
// pre-built eCG dashboard template and stores portal credentials as project secrets.
// Streams SSE 'step' events as each stage below actually completes, so the caller
// can render real progress instead of a single spinner.
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);

  try {
    const { token, organizationId } = req.body as { token?: string; organizationId?: string };
    if (!token) {
      sseWrite(res, 'error', { message: 'token is required' });
      res.end();
      return;
    }

    // If an eComGear organization was selected, verify the caller actually
    // belongs to it before letting the new project be filed under it.
    if (organizationId) {
      const { data: owned } = await supabase.from('organizations').select('id').eq('id', organizationId).eq('created_by', req.user!.id).maybeSingle();
      const { data: membership } = owned ? { data: null } : await supabase.from('org_members').select('org_id').eq('org_id', organizationId).eq('user_id', req.user!.id).maybeSingle();
      if (!owned && !membership) {
        sseWrite(res, 'error', { message: 'You do not have access to that organization' });
        res.end();
        return;
      }
    }

    // Exchange token with the portal (server-to-server)
    let portalData: {
      portalToken: string;
      portalApiUrl: string;
      orgId: string;
      orgName: string;
      agentIds: string[];
      modules: string[];
      config: Record<string, unknown>;
    };

    try {
      const verifyUrl = `${PORTAL_API_URL}/api/app-builder/verify/${token}`;
      const verifyRes = await fetch(verifyUrl, {
        headers: { 'x-service-key': ECG_SERVICE_KEY },
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({ error: 'Token exchange failed' })) as { error?: string };
        sseWrite(res, 'error', { message: body.error ?? 'Token exchange failed' });
        res.end();
        return;
      }
      portalData = await verifyRes.json() as typeof portalData;
    } catch {
      sseWrite(res, 'error', { message: 'Could not reach eCG Agents Portal' });
      res.end();
      return;
    }
    sseWrite(res, 'step', { id: 'token_exchange', status: 'done' });

    // Create the eComGear project record
    const projectName = (portalData.config?.appName as string) || `${portalData.orgName || 'eCG'} Dashboard`;
    const project = await projectService.createProject(req.user!.id, {
      name: projectName,
      description: 'Custom eCG Agents Portal UI   built with App Builder',
      template: 'ecg-dashboard',
      organizationId,
    });
    sseWrite(res, 'step', { id: 'project_created', status: 'done' });

    const serverPath = `/var/ecomgear/projects/user_${req.user!.id.substring(0, 8)}_project_${project.id.substring(0, 8)}`;

    try { await initProjectFromTemplate(serverPath); } catch { /* non-fatal in dev */ }
    sseWrite(res, 'step', { id: 'template_import', status: 'done' });

    const llm = (portalData.config?.llm ?? {}) as { provider?: string; model?: string; apiKey?: string };
    const secrets: { project_id: string; key_name: string; key_value: string }[] = [
      { project_id: project.id, key_name: 'ECG_PORTAL_TOKEN', key_value: portalData.portalToken },
      { project_id: project.id, key_name: 'ECG_ORG_ID',       key_value: portalData.orgId },
    ];
    if (llm.apiKey)  secrets.push({ project_id: project.id, key_name: 'ECG_LLM_API_KEY',  key_value: llm.apiKey });
    if (llm.model)   secrets.push({ project_id: project.id, key_name: 'ECG_LLM_MODEL',    key_value: llm.model });
    if (llm.provider) secrets.push({ project_id: project.id, key_name: 'ECG_LLM_PROVIDER', key_value: llm.provider });

    const accessPassword = portalData.config?.accessPassword as string | undefined;
    if (accessPassword) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(accessPassword, salt, 64).toString('hex');
      secrets.push({ project_id: project.id, key_name: 'ECG_ACCESS_PASSWORD_HASH', key_value: hash });
      secrets.push({ project_id: project.id, key_name: 'ECG_ACCESS_PASSWORD_SALT', key_value: salt });
    }

    const mcp = (portalData.config?.mcp ?? {}) as { enabled?: boolean; url?: string; authToken?: string };
    if (mcp.enabled && mcp.url) {
      secrets.push({ project_id: project.id, key_name: 'ECG_MCP_URL', key_value: mcp.url });
      if (mcp.authToken) secrets.push({ project_id: project.id, key_name: 'ECG_MCP_TOKEN', key_value: mcp.authToken });
    }

    const envContent = `VITE_PROJECT_ID=${project.id}\nVITE_ECG_PROXY_URL=${ECOMGEAR_SERVER_URL}\n`;
    try {
      fs.mkdirSync(serverPath, { recursive: true });
      fs.writeFileSync(path.join(serverPath, '.env.local'), envContent, 'utf8');
    } catch { /* non-fatal in dev */ }

    const templateFiles = seedEcgTemplate(serverPath, {
      orgName:  portalData.orgName,
      modules:  portalData.modules,
      agentIds: portalData.agentIds,
      config:   portalData.config ?? {},
      projectId: project.id,
      proxyUrl:  ECOMGEAR_SERVER_URL,
    });
    sseWrite(res, 'step', { id: 'modules_configured', status: 'done' });

    const filesArray = Object.entries(templateFiles).map(([filePath, content]) => ({ path: filePath, content }));

    await supabase.from('project_secrets').insert(secrets);
    sseWrite(res, 'step', { id: 'secrets_stored', status: 'done' });

    // Store files in Supabase revisions so the eComGear editor can read them.
    const { data: existingRev } = await supabase
      .from('revisions')
      .select('id')
      .eq('project_id', project.id)
      .order('revision_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const revisionPayload = {
      generated_files: { files: filesArray, summary: `eCG dashboard for ${portalData.orgName}` },
      preview_status: 'pending' as const,
    };

    if (existingRev) {
      await supabase.from('revisions').update(revisionPayload).eq('id', existingRev.id);
    } else {
      await supabase.from('revisions').insert({
        project_id: project.id,
        user_id: req.user!.id,
        revision_number: 1,
        prompt: 'eCG dashboard   generated by App Builder',
        generated_code: filesArray.map(f => `// ${f.path}\n${f.content}`).join('\n\n---\n\n'),
        ...revisionPayload,
        is_published: false,
      });
    }
    sseWrite(res, 'step', { id: 'revision_saved', status: 'done' });

    // Push template files to the preview service (VPS2) so the live preview works.
    // fullSync must be false here: this is an OVERLAY onto the base scaffold
    // initProjectFromTemplate() just wrote (package.json, vite.config.ts,
    // tsconfig*.json, node_modules)   agent-template/ never includes those
    // files, so a fullSync prune deletes them immediately after project
    // creation, breaking the build before the user's first message. This was
    // silently corrupting every fresh Dashboard Creator launch.
    const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app';
    const previewSecret = process.env.PREVIEW_UPDATE_SECRET || '';
    try {
      await fetch(`${previewServiceUrl}/preview/${project.id}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-update-secret': previewSecret },
        body: JSON.stringify({ files: filesArray, fullSync: false }),
      });
    } catch { /* preview push is non-fatal */ }
    sseWrite(res, 'step', { id: 'preview_synced', status: 'done' });

   // Close the cross-system ID loop   non-fatal, fire-and-forget.
    fetch(`${PORTAL_API_URL}/api/app-builder/${token}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': ECG_SERVICE_KEY },
      body: JSON.stringify({ projectId: project.id, dashboardUrl: `https://www.ecomgear.dev/project/${project.id}` }),
    }).catch(() => { /* non-fatal   agent-portal's "Your Dashboards" link just won't populate */ });

    sseWrite(res, 'done', { projectId: project.id });
    res.end();
  } catch (err) {
    sseWrite(res, 'error', { message: err instanceof Error ? err.message : 'Unexpected error' });
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

export default router;
