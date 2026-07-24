/**
 * eCG Agent "dev-agent" onboarding   the API-key + MCP-discovery path.
 *
 * Distinct from ecg-connect.routes.ts (the agent-portal's one-time launch-
 * token handoff, still supported for existing dashboards). This is the path
 * for "Connect eCG Agent" on the eCG Agents dashboard page: the user pastes
 * their own long-lived ecg_... API key, we discover what's actually connected
 * to their org over MCP, then seed the SAME agent-template/ used by the portal
 * flow (server/agent-template   already a complete Agents/Schedulers/Posts/
 * Connectors/Runs/Knowledge/Settings dashboard, see seedEcgTemplate()).
 *
 * The template's own client (agent-template/src/lib/ecgClient.ts) talks to
 * this server's existing /api/v1/ecg-proxy bridge using a Bearer token read
 * from project_secrets['ECG_PORTAL_TOKEN']   so the MCP key is dual-written
 * under that name too. ecg-proxy only forwards Authorization; it doesn't care
 * whether the token was minted by the portal or is a raw MCP key, so this
 * needs no changes to ecg-proxy.routes.ts itself.
 *
 * One org can run many of these dashboards over time   this never assumes
 * the key is single-use; it's stored per-project and can seed another
 * project again later.
 */
import { Router, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { projectService, getProjectServerPath } from '../services/project.service.js';
import { initProjectFromTemplate } from '../services/baseTemplateService.js';
import { databaseService, buildProjectEnvSecrets } from '../services/database.service.js';
import { discoverEcgOrg } from '../services/ecgMcpClient.service.js';
import { seedEcgTemplate } from '../services/ecg-template.js';
import { saveEcgRevision, syncEcgPreviewService } from './ecg-connect.routes.js';
import { captureThumbnail } from '../services/thumbnailService.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(authMiddleware);

const ECOMGEAR_SERVER_URL = process.env.ECOMGEAR_SERVER_URL || 'https://api.ecomgear.ai';

// package.json/vite.config.ts/tsconfig*.json aren't part of agent-template/
// (it assumes a scaffolded project) and aren't part of seedEcgTemplate's
// output either   without these the project's file list is missing its own
// "primary configuration files". initProjectFromTemplate() already writes
// them to serverPath; read them back so they land in the revision too.
const SCAFFOLD_CONFIG_FILES = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
];

function sseWrite(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Lightweight discovery for the onboarding wizard's confirm step: verifies
// the key and returns what's connected, WITHOUT creating a project. The
// wizard shows this as proof-of-connection + branding form, then calls
// POST / with the confirmed config.
router.post('/discover', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { apiKey } = req.body as { apiKey?: string };
  if (!apiKey) {
    res.status(400).json({ error: 'apiKey is required' });
    return;
  }
  try {
    const discovery = await discoverEcgOrg(apiKey);
    res.json(discovery);
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : 'Could not verify eCG Agent API key' });
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);

  try {
    const { apiKey, organizationId, config, modules, password } = req.body as {
      apiKey?: string;
      organizationId?: string;
      config?: Record<string, unknown>;
      modules?: string[];
      password?: string;
    };
    const dashConfig  = config && typeof config === 'object' ? config : {};
    const dashModules = Array.isArray(modules) ? modules.filter((m): m is string => typeof m === 'string') : [];
    if (!apiKey) {
      sseWrite(res, 'error', { message: 'apiKey is required' });
      res.end();
      return;
    }

    if (organizationId) {
      const { data: owned } = await supabase.from('organizations').select('id').eq('id', organizationId).eq('created_by', req.user!.id).maybeSingle();
      const { data: membership } = owned ? { data: null } : await supabase.from('org_members').select('org_id').eq('org_id', organizationId).eq('user_id', req.user!.id).maybeSingle();
      if (!owned && !membership) {
        sseWrite(res, 'error', { message: 'You do not have access to that organization' });
        res.end();
        return;
      }
    }

    // ── Discover what's actually connected ──────────────────────────────────
    let discovery;
    try {
      discovery = await discoverEcgOrg(apiKey);
    } catch (err) {
      sseWrite(res, 'error', { message: err instanceof Error ? err.message : 'Could not verify eCG Agent API key' });
      res.end();
      return;
    }
    sseWrite(res, 'step', { id: 'discovery', status: 'done', agents: discovery.agents.length, connectors: discovery.connectors.length });

    // ── Create the project ───────────────────────────────────────────────────
    const orgNameGuess = (typeof dashConfig.appName === 'string' && dashConfig.appName.trim())
      || discovery.agents[0]?.orgName || discovery.agents[0]?.name || 'eCG Agent';
    const project = await projectService.createProject(req.user!.id, {
      name: `${orgNameGuess} Dashboard`,
      description: 'Agent-management dashboard connected to an eCG Agent org via MCP',
      template: 'ecg-dev-agent',
      organizationId,
    });
    sseWrite(res, 'step', { id: 'project_created', status: 'done', projectId: project.id });

    const serverPath = getProjectServerPath(req.user!.id, project.id);
    try { await initProjectFromTemplate(serverPath); } catch (err) {
      logger.warn('[ecg-dev-agent] base template scaffold failed (continuing without it)', err);
    }
    sseWrite(res, 'step', { id: 'template_import', status: 'done' });

    // ── Store the key: ECG_MCP_API_KEY for record-keeping, ECG_PORTAL_TOKEN
    // because that's the secret name ecg-proxy.routes.ts actually reads ──────
    await supabase.from('project_secrets').insert([
      { project_id: project.id, key_name: 'ECG_MCP_API_KEY', key_value: apiKey },
      { project_id: project.id, key_name: 'ECG_PORTAL_TOKEN', key_value: apiKey },
    ]);

    // ── Access password (scrypt, same scheme ecg-access.routes.ts verifies).
    // The wizard collects it at the confirm step; AccessGate then requires it
    // on every visit to the deployed dashboard. ──
    if (typeof password === 'string' && password.trim().length >= 6) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(password.trim(), salt, 64).toString('hex');
      await supabase.from('project_secrets').insert([
        { project_id: project.id, key_name: 'ECG_ACCESS_PASSWORD_HASH', key_value: hash },
        { project_id: project.id, key_name: 'ECG_ACCESS_PASSWORD_SALT', key_value: salt },
      ]);
      sseWrite(res, 'step', { id: 'password_protected', status: 'done' });
    } else {
      sseWrite(res, 'step', { id: 'password_protected', status: 'skipped' });
    }

    let dbProvisioned = false;
    try {
      await databaseService.provision(req.user!.id, organizationId ?? null, project.id);
      await databaseService.getCredentials(req.user!.id, project.id); // upserts VITE_DB_* secrets
      dbProvisioned = true;
    } catch (err) {
      logger.warn('[ecg-dev-agent] database provisioning failed (continuing without hosted DB)', err);
    }
    sseWrite(res, 'step', { id: 'database_provisioned', status: dbProvisioned ? 'done' : 'skipped' });

    // ── Starter edge function: server-side eCG access pattern. The `ecg`
    // helper is injected by functionRunner with the portal token, so ECG
    // credentials never reach the browser. The dev agent extends this file
    // instead of inventing frontend fetches (see its eCG prompt rules). ──
    try {
      await supabase.from('edge_functions').upsert(
        {
          user_id: req.user!.id,
          project_id: project.id,
          name: 'ecg-overview',
          description: 'Server-side eCG summary: agents + publishing stats fetched with credentials that stay on the server.',
          code: [
            "// Server-side eCG access: `ecg` is pre-injected with this project's",
            "// portal credentials. Never fetch the portal from frontend code.",
            "if (!ecg) return { error: 'eCG portal not linked for this project' };",
            "const [agents, stats] = await Promise.all([",
            "  ecg.get('/agents'),",
            "  ecg.get('/stats'),",
            "]);",
            "return { agents, stats, generatedAt: new Date().toISOString() };",
          ].join('\n'),
          is_active: true,
        },
        { onConflict: 'project_id,name' },
      );
      sseWrite(res, 'step', { id: 'edge_function_created', status: 'done' });
    } catch (err) {
      logger.warn('[ecg-dev-agent] starter edge function seed failed (non-fatal)', err);
      sseWrite(res, 'step', { id: 'edge_function_created', status: 'skipped' });
    }

    // Push every secret (platform auth + hosted DB, if provisioned) to the live preview.
    try {
      const secrets = await buildProjectEnvSecrets(req.user!.id, project.id);
      const previewBase = (process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
      await fetch(`${previewBase}/preview/${project.id}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}) },
        body: JSON.stringify({ secrets }),
      });
    } catch (err) {
      logger.warn('[ecg-dev-agent] preview secret sync failed', err);
    }

    // ── Seed the frontend from agent-template/ (Dashboard/Agents/Schedulers/
    // Posts/Connectors/Runs/Knowledge/Settings, AccessGate-protected)   the
    // same seeder ecg-connect.routes.ts's portal flow uses. modules: [] lets
    // ecgConfigTs() default to every module; discovery doesn't yet map
    // 1:1 to agent-template's module keys, so showing all is the safe default. ──
    const agentIds = discovery.agents.map((a) => a?.id).filter((id): id is string => typeof id === 'string');
    const templateFiles = seedEcgTemplate(serverPath, {
      orgName: orgNameGuess,
      modules: dashModules,
      agentIds,
      config: dashConfig,
      projectId: project.id,
      proxyUrl: ECOMGEAR_SERVER_URL,
    });
    sseWrite(res, 'step', { id: 'template_seeded', status: 'done', pages: Object.keys(templateFiles).filter((f) => f.startsWith('src/pages/')).length });

    const files: Record<string, string> = { ...templateFiles };
    for (const rel of SCAFFOLD_CONFIG_FILES) {
      try {
        files[rel] = fs.readFileSync(path.join(serverPath, rel), 'utf8');
      } catch { /* base template scaffold failed earlier   skip, non-fatal */ }
    }
    const filesArray = Object.entries(files).map(([filePath, content]) => ({ path: filePath, content }));

    // Same persisted shape ecg-connect.routes.ts writes   the existing
    // in-editor Customizer panel (gated on ECG_PORTAL_TOKEN) reads this back.
    await supabase.from('project_settings').upsert(
      {
        project_id: project.id,
        setting_key: 'ecg_customizer',
        setting_value: { orgName: orgNameGuess, modules: dashModules, agentIds, config: dashConfig },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,setting_key' },
    );

    await saveEcgRevision(project.id, req.user!.id, filesArray, `eCG agent dashboard for ${orgNameGuess}`);
    sseWrite(res, 'step', { id: 'revision_saved', status: 'done' });

    await syncEcgPreviewService(project.id, filesArray);
    sseWrite(res, 'step', { id: 'preview_synced', status: 'done' });

    // The normal AI-edit loop (agentLoopService.ts) writes this after every
    // successful preview push so the Editor/Projects grid can show a
    // thumbnail; this route never did, so every eCG dashboard was created
    // with revisions.preview_url permanently null and no thumbnail ever
    // generated for it.
    const publicPreviewBase = process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app';
    const revisionPreviewUrl = `${publicPreviewBase}/preview/${project.id}/`;
    try {
      await supabase.from('revisions').update({ preview_url: revisionPreviewUrl, preview_status: 'ready' }).eq('project_id', project.id);
      captureThumbnail(project.id, revisionPreviewUrl, supabase);
    } catch (err) {
      logger.warn('[ecg-dev-agent] preview_url/thumbnail write failed (non-fatal)', err);
    }

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
