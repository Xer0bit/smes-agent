// Agentic chat endpoint for the eCG dashboard template.
// Wraps LLM tool-calling: AI can read portal data and take actions (approve/reject posts, etc.)
// All portal calls are server-side using ECG_PORTAL_TOKEN — never exposed to the browser.

import { Router, Response as ExpressResponse, NextFunction } from 'express';
import { authMiddleware, dashboardAccessMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { getMcpTools, McpToolset } from '../services/mcpClient.js';

const router = Router();

const PORTAL_API_URL = process.env.ECG_PORTAL_URL || 'https://api.ecomgear.ai';

async function getSecrets(projectId: string, userId: string | null) {
  const query = supabase.from('projects').select('id, user_id').eq('id', projectId);
  const { data: project } = await (userId ? query.eq('user_id', userId) : query).maybeSingle();
  if (!project) return null;
  const { data: rows } = await supabase
    .from('project_secrets').select('key_name, key_value')
    .eq('project_id', projectId)
    .in('key_name', ['ECG_PORTAL_TOKEN', 'ECG_LLM_PROVIDER', 'ECG_LLM_MODEL', 'ECG_LLM_API_KEY', 'ECG_MCP_URL', 'ECG_MCP_TOKEN']);
  return Object.fromEntries((rows ?? []).map(r => [r.key_name, r.key_value]));
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

async function portalCall(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${PORTAL_API_URL}/v1/ecg${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

// Tool definitions (OpenAI-style, adapted per provider)
const TOOLS = [
  { name: 'list_agents',    desc: 'List all agents with their current status' },
  { name: 'list_posts',     desc: 'List planned posts. Pass status="pending"|"approved"|"rejected" to filter' },
  { name: 'approve_post',   desc: 'Approve a planned post. Requires: id (post ID)' },
  { name: 'reject_post',    desc: 'Reject a planned post. Requires: id (post ID)' },
  { name: 'list_runs',      desc: 'List recent agent run history' },
  { name: 'list_schedulers',desc: 'List agent schedulers and their next run times' },
  { name: 'list_connectors',desc: 'List available connectors and their status' },
  { name: 'list_knowledge', desc: 'List knowledge base entries' },
];

function openaiTools(mcp: McpToolset | null) {
  const builtin = TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc,
      parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: [] },
    },
  }));
  const mcpTools = (mcp?.tools ?? []).map(t => ({
    type: 'function',
    function: { name: `mcp_${t.name}`, description: t.description ?? t.name, parameters: t.inputSchema },
  }));
  return [...builtin, ...mcpTools];
}

function anthropicTools(mcp: McpToolset | null) {
  const builtin = TOOLS.map(t => ({
    name: t.name,
    description: t.desc,
    input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
  }));
  const mcpTools = (mcp?.tools ?? []).map(t => ({
    name: `mcp_${t.name}`,
    description: t.description ?? t.name,
    input_schema: t.inputSchema,
  }));
  return [...builtin, ...mcpTools];
}

async function executeTool(name: string, args: Record<string, string>, token: string, mcp: McpToolset | null) {
  if (name.startsWith('mcp_')) {
    if (!mcp) return { error: 'MCP server unavailable' };
    return mcp.callTool(name.slice(4), args);
  }
  switch (name) {
    case 'list_agents':     return portalCall(token, 'GET', '/agents');
    case 'list_posts':      return portalCall(token, 'GET', args.status ? `/planned-posts?status=${args.status}` : '/planned-posts');
    case 'approve_post':    return portalCall(token, 'PATCH', `/planned-posts/${args.id}`, { status: 'approved' });
    case 'reject_post':     return portalCall(token, 'PATCH', `/planned-posts/${args.id}`, { status: 'rejected' });
    case 'list_runs':       return portalCall(token, 'GET', '/runs');
    case 'list_schedulers': return portalCall(token, 'GET', '/schedulers');
    case 'list_connectors': return portalCall(token, 'GET', '/connectors');
    case 'list_knowledge':  return portalCall(token, 'GET', '/knowledge');
    default:                return { error: 'Unknown tool' };
  }
}

const SYSTEM = `You are an AI assistant embedded in a custom eCG Agents Portal dashboard. You have access to portal data and can take actions on behalf of the user. Be concise and helpful. When you take an action, briefly confirm what you did.`;

// POST /api/v1/ecg-chat?projectId=
router.post('/', resolveAuth, async (req: AuthenticatedRequest, res: ExpressResponse): Promise<void> => {
  const projectId = (req.query.projectId ?? req.headers['x-project-id']) as string | undefined;
  if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }

  const secrets = await getSecrets(projectId, req.dashboardAccessProjectId ? null : req.user!.id);
  if (!secrets) { res.status(403).json({ error: 'Project not found or access denied' }); return; }

  const apiKey   = secrets['ECG_LLM_API_KEY'];
  const model    = secrets['ECG_LLM_MODEL']    || 'gpt-4o';
  const provider = secrets['ECG_LLM_PROVIDER'] || 'openai';
  const token    = secrets['ECG_PORTAL_TOKEN'];

  if (!apiKey)  { res.status(400).json({ error: 'No LLM API key configured. Set one in App Builder → AI Model.' }); return; }
  if (!token)   { res.status(400).json({ error: 'No portal token. Re-launch from App Builder.' }); return; }

  const mcp: McpToolset | null = secrets['ECG_MCP_URL']
    ? await getMcpTools(secrets['ECG_MCP_URL'], secrets['ECG_MCP_TOKEN'])
    : null;

  const { messages = [] } = req.body as { messages: { role: string; content: string }[] };
  const actions: { tool: string; result: unknown }[] = [];

  // Agentic loop — max 4 iterations (3 tool calls + final answer)
  let loopMessages = [...messages];
  let finalText = '';

  for (let i = 0; i < 4; i++) {
    let llmRes: globalThis.Response;

    if (provider === 'anthropic') {
      llmRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM, messages: loopMessages, tools: anthropicTools(mcp) }),
      });
      const data = await llmRes.json() as any;
      const toolUse = (data.content ?? []).find((b: any) => b.type === 'tool_use');
      if (toolUse) {
        const result = await executeTool(toolUse.name, toolUse.input ?? {}, token, mcp);
        actions.push({ tool: toolUse.name, result });
        loopMessages = [
          ...loopMessages,
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }] },
        ] as any;
        continue;
      }
      finalText = data.content?.find((b: any) => b.type === 'text')?.text ?? 'No response.';
    } else if (provider === 'google') {
      // Gemini doesn't support tool calling in same way — inject summary as context
      const contextMsg = i === 0 && actions.length === 0
        ? loopMessages
        : [{ role: 'user', content: `Context:\n${JSON.stringify(actions)}\n\nUser: ${messages.at(-1)?.content}` }];
      llmRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: contextMsg.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }),
      });
      const data = await llmRes.json() as any;
      finalText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response.';
    } else {
      // OpenAI-compatible
      const baseUrl = provider === 'custom' ? (process.env.ECG_CUSTOM_LLM_URL || 'https://api.openai.com') : 'https://api.openai.com';
      llmRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, tools: openaiTools(mcp), tool_choice: 'auto',
          messages: [{ role: 'system', content: SYSTEM }, ...loopMessages],
        }),
      });
      const data = await llmRes.json() as any;
      const choice = data.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;
      if (toolCalls?.length) {
        loopMessages = [...loopMessages, choice.message];
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          const result = await executeTool(tc.function.name, args, token, mcp);
          actions.push({ tool: tc.function.name, result });
          loopMessages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id } as any);
        }
        continue;
      }
      finalText = choice?.message?.content ?? 'No response.';
    }
    break;
  }

  res.json({ reply: finalText, actions });
});

export default router;
