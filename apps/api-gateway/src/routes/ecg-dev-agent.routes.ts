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
import { seedEcgTemplate, loadTemplateEdgeFunctions } from '../services/ecg-template.js';
import { saveEcgRevision, syncEcgPreviewService } from './ecg-connect.routes.js';
import { captureThumbnail } from '../services/thumbnailService.js';
import { logger } from '../utils/logger.js';
import { safeErrorMessage } from '../utils/sendError.js';

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
    res.status(422).json({ error: safeErrorMessage(err, 'Could not verify eCG Agent API key') });
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);

  try {
    const { apiKey, organizationId, config, modules, password, selectedAgentIds, agentNames } = req.body as {
      apiKey?: string;
      organizationId?: string;
      config?: Record<string, unknown>;
      modules?: string[];
      password?: string;
      // Which of the org's discovered agents this dashboard manages, and their
      // display names for the in-dashboard agent switcher (see
      // EcgConnectWizard.tsx). Omitted entirely means "every discovered agent"
      // -- the wizard only sends these when the user narrowed the selection,
      // so an older client (or a user who left every agent checked) still
      // gets today's behavior.
      selectedAgentIds?: string[];
      agentNames?: Record<string, string>;
      // Which registered dashboard template to seed (TEMPLATE_REGISTRY in
      // ecg-template.ts). Omitted -> 'social' (today's default). 'social-v2'
      // is the tenant-Supabase agency template (spec:
      // .scratch/social-template-v2/spec.md).
      agentType?: string;
    };
    const dashConfig  = config && typeof config === 'object' ? config : {};
    const dashModules = Array.isArray(modules) ? modules.filter((m): m is string => typeof m === 'string') : [];
    const agentType   = typeof req.body.agentType === 'string' ? req.body.agentType : undefined;
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
      sseWrite(res, 'error', { message: safeErrorMessage(err, 'Could not verify eCG Agent API key') });
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
      const { error: overviewErr } = await supabase.from('edge_functions').upsert(
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
          // Explicit, not relying on the default: this dashboard's own
          // frontend fetches agent/publishing stats via the standard anon-key
          // invoke pattern (the dashboard's password gate is a separate
          // client-side check, not a change of Postgres/edge-function role).
          // Set explicitly so intent survives regardless of what is_public's
          // column default is at write time -- see
          // 20260809150000_edge_functions_default_private.sql.
          is_public: true,
        },
        { onConflict: 'project_id,name' },
      );
      // supabase-js resolves {data, error} rather than rejecting on a query
      // error -- an unchecked .error here previously made this whole seed
      // step silently no-op (confirmed live: the ON CONFLICT target didn't
      // match the (project_id, name) partial index until
      // 20260810160000_edge_functions_fix_upsert_conflict_target.sql).
      if (overviewErr) throw overviewErr;
      sseWrite(res, 'step', { id: 'edge_function_created', status: 'done' });
    } catch (err) {
      logger.warn('[ecg-dev-agent] starter edge function seed failed (non-fatal)', err);
      sseWrite(res, 'step', { id: 'edge_function_created', status: 'skipped' });
    }

    // ── Template-owned edge functions (e.g. social-v2's auth-context/clients/
    // content/files/brand-assets/social) -- this is the ONLY data-access path
    // the template's own frontend uses (src/lib/tenant.ts), so these must
    // exist before the seeded app can do anything. is_public: true because
    // the frontend invokes them directly with the DB anon key (each verifies
    // the REAL caller itself against cloud auth, not relying on that key).
    // requires_service_role: true (also the column default) because
    // authorization is enforced in the function's own code, not via RLS --
    // see the migration's header comment. ──
    try {
      const templateFns = loadTemplateEdgeFunctions(agentType);
      const names = Object.keys(templateFns);
      if (names.length > 0) {
        const { error: fnsErr } = await supabase.from('edge_functions').upsert(
          names.map((name) => ({
            user_id: req.user!.id,
            project_id: project.id,
            name,
            description: `Template-owned function (${name}.js) -- part of this dashboard's data layer, see src/lib/tenant.ts.`,
            code: templateFns[name],
            is_active: true,
            is_public: true,
            requires_service_role: true,
          })),
          { onConflict: 'project_id,name' },
        );
        if (fnsErr) throw fnsErr;
      }
      sseWrite(res, 'step', { id: 'template_functions_deployed', status: names.length > 0 ? 'done' : 'skipped', count: names.length });
    } catch (err) {
      logger.warn('[ecg-dev-agent] template edge function seed failed', err);
      sseWrite(res, 'step', { id: 'template_functions_deployed', status: 'failed' });
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
    const allAgentIds = discovery.agents.map((a) => a?.id).filter((id): id is string => typeof id === 'string');
    const agentIds = Array.isArray(selectedAgentIds) && selectedAgentIds.length > 0
      ? selectedAgentIds.filter((id): id is string => typeof id === 'string' && allAgentIds.includes(id))
      : allAgentIds;
    // Name map for the dashboard's agent switcher -- prefer what the wizard
    // sent (it already had the full discovery payload client-side), fall back
    // to building it from this server's own discovery result.
    const resolvedAgentNames: Record<string, string> = agentNames && typeof agentNames === 'object'
      ? agentNames
      : Object.fromEntries(discovery.agents.filter((a) => a?.id && agentIds.includes(a.id)).map((a) => [a.id as string, (a?.name as string) ?? 'Agent']));
    const templateFiles = seedEcgTemplate(serverPath, {
      orgName: orgNameGuess,
      modules: dashModules,
      agentIds,
      agentNames: resolvedAgentNames,
      config: dashConfig,
      projectId: project.id,
      proxyUrl: ECOMGEAR_SERVER_URL,
      agentType,
    });
    sseWrite(res, 'step', { id: 'template_seeded', status: 'done', pages: Object.keys(templateFiles).filter((f) => f.startsWith('src/pages/')).length });

    // ── Base memory for the dev agent ────────────────────────────────────────
    // ai.routes.ts injects projects.context_notes into EVERY chat request as
    // "## Project Context Notes" (see agentLoopService.ts's knowledgeBlock) --
    // this is the durable, conversation-independent memory mechanism the app
    // already has for exactly this purpose. It was never populated for eCG
    // dashboards, so a fresh chat had nothing but the generic eCG integration
    // rules to go on and would often reinvent structure that already existed
    // (new pages/components duplicating what's already in src/pages,
    // hardcoded colors instead of the existing CSS tokens, etc.) instead of
    // extending it. Listing the ACTUAL seeded pages (not a fixed guess) so
    // this stays accurate if the module list changes.
    const seededPages = Object.keys(templateFiles)
      .filter((f) => f.startsWith('src/pages/'))
      .map((f) => f.replace('src/pages/', '').replace(/\.tsx?$/, ''));
    const contextNotes = agentType === 'social-v2' ? [
      `This is a Social Agency dashboard seeded from social-template/ (social-v2): a tenant-Supabase app (clients, leads, press releases, social posting) whose social publishing goes through the Agent Portal's Buffer connector via src/lib/ecgClient.ts.`,
      `Existing pages (extend these, don't recreate them): ${seededPages.join(', ')}.`,
      `Data access: this app talks to its own tenant Supabase via src/integrations/supabase/client.ts for all local data, and to the Agent Portal ONLY through ecgApi (src/lib/ecgClient.ts) for connectors and publishing. Never paste social credentials into this app; they live portal-side.`,
      `src/ecg-config.ts is generated at seed time -- never edit it by hand.`,
    ].join('\n\n') : [
      `This is an eCG Agent dashboard: a social-media agent management UI seeded from server/agent-template/, connected to a live eCG Agents org via MCP.`,
      `Existing pages (extend these, don't recreate them): ${seededPages.join(', ')}.`,
      `Shared components already exist: Layout.tsx (sidebar/topnav/minimal shell), TopBar.tsx (search + notifications), components/ui.tsx (PageHeader, Card, EmptyState, Spinner, SkeletonRows, platformMeta, relTime), StatusBadge.tsx. Use these instead of hand-rolling equivalents.`,
      `src/ecg-config.ts is the ONLY customization surface (appName, logoUrl, theme, layout, modules) -- restyle by changing the CSS custom properties in src/index.css, never hardcode colors in components.`,
      `src/lib/ecgClient.ts is the ONLY data-access layer for this project -- every page fetches through ecgApi, never a raw fetch. It talks to the eCG proxy bridge server-side; credentials never reach the browser.`,
      `Never edit src/pages/AccessGate.tsx or the token handling in ecgClient.ts -- they are this dashboard's authentication.`,
      `The project's own README.md documents the full architecture in more detail.`,
    ].join('\n\n');
    await supabase.from('projects').update({ context_notes: contextNotes }).eq('id', project.id);

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
        setting_value: { orgName: orgNameGuess, modules: dashModules, agentIds, agentNames: resolvedAgentNames, config: dashConfig },
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
    sseWrite(res, 'error', { message: safeErrorMessage(err, 'Unexpected error') });
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

export default router;
