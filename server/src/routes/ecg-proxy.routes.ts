import { Router, Request, Response as ExpressResponse, NextFunction } from 'express';
import { authMiddleware, dashboardAccessMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { callEcgTool } from '../services/ecgMcpClient.service.js';

const router = Router();

const PORTAL_API_URL = process.env.ECG_PORTAL_URL || 'https://api.ecomgear.ai';

// Helper: fetch all relevant project secrets in one round-trip.
// userId=null means "trust dashboardAccessMiddleware, don't require ownership"
// (an anonymous dashboard visitor, not the eComGear account that built it).
async function getProjectSecrets(projectId: string, userId: string | null) {
  const query = supabase.from('projects').select('id, user_id').eq('id', projectId);
  const { data: project } = await (userId ? query.eq('user_id', userId) : query).maybeSingle();
  if (!project) return null;

  const { data: rows } = await supabase
    .from('project_secrets').select('key_name, key_value')
    .eq('project_id', projectId)
    .in('key_name', ['ECG_PORTAL_TOKEN', 'ECG_MCP_API_KEY', 'ECG_LLM_PROVIDER', 'ECG_LLM_MODEL', 'ECG_LLM_API_KEY']);

  return Object.fromEntries((rows ?? []).map(r => [r.key_name, r.key_value]));
}

// ── MCP bridge ────────────────────────────────────────────────────────────────
// Projects connected via ecg-dev-agent.routes.ts (paste an MCP API key) have no
// portal JWT   api.ecomgear.ai/v1/ecg/* requires one and rejects an MCP key
// outright (confirmed live: "Invalid or expired token"). There's also no way
// to mint a portal JWT for these projects anymore (the only issuer, the old
// launch-token handoff, is retired). So for MCP-key projects, REST-shaped
// calls from the generated dashboard's ecgClient.ts are translated here into
// real MCP tool calls instead of forwarded to the portal REST API.
//
// The MCP catalog (29 tools) doesn't 1:1 cover the full portal REST surface
// -- no reject-post, no connector test, no knowledge-base edit/delete, no
// visual-posts/team/billing/org-settings. Those return 'unsupported' below
// and the route handler answers with a clear message instead of a raw
// upstream failure.
type McpMapping = { tool: string; args: Record<string, unknown> } | 'unsupported';

// The dashboard's REST-shaped frontend calls (ecgClient.ts) send snake_case
// field names matching the backend's own DB columns (api_key, webhook_url,
// prompt_overlay); MCP tools are registered with camelCase Zod schemas
// (apiKey, webhookUrl, promptOverlay, and crucially agentId/connectorId
// instead of the bare `id` a REST PATCH/DELETE path segment gives you).
// Forwarding `body` raw (as every mapping below used to) silently drops
// every mismatched field -- confirmed live: connector tokens were never
// saved (api_key never became apiKey), and update_agent flat out rejected
// every call (no `id`->`agentId` translation at all: "Invalid arguments...
// path: ['agentId'], message: 'Required'"). This helper does the translation
// once instead of per-mapping.
function pick(body: any, ...pairs: Array<[string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [camel, snake] of pairs) {
    const v = body?.[camel] ?? body?.[snake];
    if (v !== undefined) out[camel] = v;
  }
  return out;
}

function mapToMcpTool(method: string, path: string, body: any, query: Record<string, string>): McpMapping | null {
  const seg = path.replace(/^\//, '').split('/').filter(Boolean); // e.g. ['agents', ':id']

  if (seg[0] === 'agent-templates' && method === 'GET' && seg.length === 1) return { tool: 'list_agent_templates', args: {} };

  if (seg[0] === 'agents') {
    if (seg.length === 1) {
      if (method === 'GET') return { tool: 'list_agents', args: {} };
      if (method === 'POST') return {
        tool: 'create_agent',
        args: pick(body, ['name', 'name'], ['templateId', 'template_id'], ['promptOverlay', 'prompt_overlay'],
          ['connectorIds', 'connector_ids'], ['timezone', 'timezone'], ['knowledgeBaseIds', 'knowledge_base_ids']),
      };
    }
    if (seg.length === 2) {
      const id = seg[1];
      if (method === 'GET') return { tool: 'get_agent_status', args: { agentId: id } };
      if (method === 'PATCH') return {
        tool: 'update_agent',
        args: {
          agentId: id,
          ...pick(body, ['name', 'name'], ['promptOverlay', 'prompt_overlay'], ['connectorIds', 'connector_ids'],
            ['status', 'status'], ['timezone', 'timezone'], ['knowledgeBaseIds', 'knowledge_base_ids']),
          ...(body?.harness !== undefined ? { harness: body.harness } : {}),
        },
      };
      if (method === 'DELETE') return { tool: 'delete_agent', args: { agentId: id } };
    }
    if (seg.length === 3 && seg[2] === 'run' && method === 'POST') return { tool: 'run_agent_now', args: { agentId: seg[1] } };
  }

  if (seg[0] === 'schedulers') {
    if (seg.length === 1) {
      if (method === 'GET') return { tool: 'list_schedulers', args: {} };
      if (method === 'POST') return { tool: 'create_scheduler', args: body ?? {} };
    }
    if (seg.length === 2) {
      const id = seg[1];
      if (method === 'DELETE') return { tool: 'delete_scheduler', args: { schedulerId: id } };
      // The only PATCH the dashboard sends is a pause/resume toggle (SchedulersPage.tsx: { status: 'paused' | 'active' }).
      if (method === 'PATCH') {
        const status = body?.status;
        if (status === 'paused') return { tool: 'pause_scheduler', args: { schedulerId: id } };
        if (status === 'active') return { tool: 'resume_scheduler', args: { schedulerId: id } };
        return 'unsupported';
      }
    }
    if (seg.length === 3 && seg[2] === 'replan' && method === 'POST') return { tool: 'trigger_scheduler_now', args: { schedulerId: seg[1] } };
  }

  if (seg[0] === 'planned-posts') {
    if (seg.length === 1 && method === 'GET') return { tool: 'get_planned_posts', args: {} };
    if (seg.length === 2 && seg[1] === 'bulk-approve' && method === 'POST') {
      return { tool: 'bulk_approve_posts', args: { postIds: Array.isArray(body?.postIds) ? body.postIds : [] } };
    }
    if (seg.length === 2) {
      const id = seg[1];
      // Delete (Trash icon in the UI) permanently removes the post; Cancel
      // (below, via PATCH status:'cancelled') just stops it from publishing
      // while keeping the record. These were wrongly collapsed into the same
      // cancel_post call -- "deleted" posts were only ever cancelled, so they
      // kept reappearing in the Cancelled/All views after a page reload.
      if (method === 'DELETE') return { tool: 'delete_post', args: { postId: id } };
      if (method === 'PATCH') {
        // The dashboard now speaks the SAME raw status vocabulary the backend
        // actually uses (draft/scheduled/posting/posted/failed/cancelled) --
        // get_planned_posts returns these unmapped, so the UI's own status
        // checks and this mapping must agree on the same values. Approving
        // and retrying a failed post are the same action (both just move the
        // post back to 'scheduled'); rejecting/cancelling both map to cancel_post.
        if (body?.status === 'scheduled') return { tool: 'approve_post', args: { postId: id } };
        if (body?.status === 'cancelled') return { tool: 'cancel_post', args: { postId: id } };
        // Editing content/platform/scheduledAt (no status change).
        if (body?.status === undefined) {
          return {
            tool: 'update_post',
            args: pick(body, ['content', 'content'], ['platform', 'platform'], ['scheduledAt', 'scheduled_at']),
          };
        }
        return 'unsupported';
      }
    }
  }

  if (seg[0] === 'connectors' && seg[1] === 'org') {
    if (seg.length === 2) {
      if (method === 'GET') return { tool: 'list_connectors', args: {} };
      if (method === 'POST') return {
        tool: 'create_connector',
        args: pick(body, ['type', 'type'], ['name', 'name'], ['apiKey', 'api_key'], ['webhookUrl', 'webhook_url'], ['phone', 'phone'], ['platforms', 'platforms']),
      };
    }
    if (seg.length === 3) {
      const id = seg[2];
      if (method === 'PATCH') return {
        tool: 'update_connector',
        args: { connectorId: id, ...pick(body, ['name', 'name'], ['apiKey', 'api_key'], ['webhookUrl', 'webhook_url'], ['phone', 'phone'], ['platforms', 'platforms']) },
      };
      if (method === 'DELETE') return { tool: 'delete_connector', args: { connectorId: id } };
    }
    if (seg.length === 4 && seg[3] === 'test') return 'unsupported';
  }

  if (seg[0] === 'connectors' && seg[1] === 'discover' && method === 'POST') {
    return { tool: 'discover_zapier_apps', args: { token: body?.token } };
  }

  if (seg[0] === 'stats' && method === 'GET' && seg.length === 1) return { tool: 'get_stats', args: {} };

  if (seg[0] === 'runs' && method === 'GET' && seg.length === 1) return { tool: 'list_runs', args: {} };

  if (seg[0] === 'knowledge' && seg[1] !== 'bases') {
    if (seg.length === 1) {
      if (method === 'GET') return { tool: 'list_knowledge', args: query.q ? { query: query.q } : {} };
      if (method === 'POST') return { tool: 'add_knowledge', args: body ?? {} };
    }
    if (seg.length === 2 && method === 'DELETE') return { tool: 'delete_knowledge', args: { entryId: seg[1] } };
  }

  if (seg[0] === 'knowledge-bases') {
    if (seg.length === 1 && method === 'GET') return { tool: 'list_knowledge_bases', args: {} };
    return 'unsupported'; // create/update/delete knowledge bases have no MCP tool
  }

  // org settings, team, api-keys, billing, visual-posts, summary: portal-account
  // features with no agent-management MCP equivalent at all.
  if (['org', 'team', 'api-keys', 'billing', 'visual-posts', 'summary'].includes(seg[0])) return 'unsupported';

  return 'unsupported';
}

// Tries the dashboard-access token first (anonymous visitor to a deployed
// dashboard); falls back to the eComGear owner Supabase session otherwise.
function resolveAuth(req: AuthenticatedRequest, res: ExpressResponse, next: NextFunction): void {
  const projectId = (req.query.projectId ?? req.headers['x-project-id']) as string | undefined;
  dashboardAccessMiddleware(req, res, () => {
    if (req.dashboardAccessProjectId && req.dashboardAccessProjectId === projectId) {
      next();
      return;
    }
    authMiddleware(req, res, next);
  });
}

// POST /api/v1/ecg-proxy/ai-chat
// Server-side LLM call   reads ECG_LLM_* project secrets, never exposes keys to browser.
router.post('/ai-chat', resolveAuth, async (req: AuthenticatedRequest, res: ExpressResponse): Promise<void> => {
  const projectId = (req.query.projectId ?? req.headers['x-project-id']) as string | undefined;
  if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }

  const secrets = await getProjectSecrets(projectId, req.dashboardAccessProjectId ? null : req.user!.id);
  if (!secrets) { res.status(403).json({ error: 'Project not found or access denied' }); return; }

  const apiKey  = secrets['ECG_LLM_API_KEY'];
  const model   = secrets['ECG_LLM_MODEL']   || 'gpt-4o';
  const provider = secrets['ECG_LLM_PROVIDER'] || 'openai';

  if (!apiKey) { res.status(400).json({ error: 'No LLM API key configured for this project. Set one in App Builder → AI Model.' }); return; }

  const { messages = [], systemPrompt } = req.body as { messages: unknown[]; systemPrompt?: string };

  try {
    let llmRes: globalThis.Response;
    if (provider === 'anthropic') {
      llmRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages }),
      });
    } else if (provider === 'google') {
      const gemUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      llmRes = await fetch(gemUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: messages }),
      });
    } else {
      // OpenAI-compatible (openai + custom)
      const baseUrl = provider === 'custom' ? (process.env.ECG_CUSTOM_LLM_URL || 'https://api.openai.com') : 'https://api.openai.com';
      llmRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages }),
      });
    }
    const data = await llmRes.json();
    res.status(llmRes.status).json(data);
  } catch {
    res.status(502).json({ error: 'LLM provider unreachable' });
  }
});

// ALL /api/v1/ecg-proxy/**
// MCP-key projects (ecg-dev-agent.routes.ts) are bridged to real MCP tool
// calls (see mapToMcpTool above). Portal-JWT projects (the retired
// ecg-connect.routes.ts launch flow, kept for existing dashboards) still
// forward server-to-server to the portal REST API as before.
router.all('*', resolveAuth, async (req: AuthenticatedRequest, res: ExpressResponse): Promise<void> => {
  const projectId = (req.query.projectId ?? req.headers['x-project-id']) as string | undefined;
  if (!projectId) {
    res.status(400).json({ error: 'projectId required (query param or X-Project-Id header)' });
    return;
  }

  const secrets = await getProjectSecrets(projectId, req.dashboardAccessProjectId ? null : req.user!.id);
  if (!secrets) { res.status(403).json({ error: 'Project not found or access denied' }); return; }

  if (secrets['ECG_MCP_API_KEY']) {
    const query = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'projectId')) as Record<string, string>;
    const mapping = mapToMcpTool(req.method, req.path, req.body, query);
    if (mapping === 'unsupported') {
      res.status(501).json({ error: 'This action is not available for an MCP-connected dashboard.' });
      return;
    }
    try {
      const result = await callEcgTool(secrets['ECG_MCP_API_KEY'], mapping!.tool, mapping!.args);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'eCG Agents MCP call failed' });
    }
    return;
  }

  if (!secrets['ECG_PORTAL_TOKEN']) {
    res.status(400).json({ error: 'This project is not linked to an eCG Agents Portal account' });
    return;
  }

  const upstreamPath = req.path === '/' ? '' : req.path;
  const queryString = new URLSearchParams(
    Object.entries(req.query as Record<string, string>).filter(([k]) => k !== 'projectId'),
  ).toString();
  const upstreamUrl = `${PORTAL_API_URL}/v1/ecg${upstreamPath}${queryString ? '?' + queryString : ''}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets['ECG_PORTAL_TOKEN']}` },
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const contentType = upstream.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await upstream.json() : await upstream.text();
    res.status(upstream.status).json(body);
  } catch {
    res.status(502).json({ error: 'Portal API unreachable' });
  }
});

export default router;
