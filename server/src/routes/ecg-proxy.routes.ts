import { Router, Request, Response as ExpressResponse } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';

const router = Router();

const PORTAL_API_URL = process.env.ECG_PORTAL_URL || 'https://api.ecomgear.ai';

// Helper: fetch all relevant project secrets in one round-trip
async function getProjectSecrets(projectId: string, userId: string) {
  const { data: project } = await supabase
    .from('projects').select('id, user_id')
    .eq('id', projectId).eq('user_id', userId).maybeSingle();
  if (!project) return null;

  const { data: rows } = await supabase
    .from('project_secrets').select('key_name, key_value')
    .eq('project_id', projectId)
    .in('key_name', ['ECG_PORTAL_TOKEN', 'ECG_LLM_PROVIDER', 'ECG_LLM_MODEL', 'ECG_LLM_API_KEY']);

  return Object.fromEntries((rows ?? []).map(r => [r.key_name, r.key_value]));
}

// POST /api/v1/ecg-proxy/ai-chat
// Server-side LLM call — reads ECG_LLM_* project secrets, never exposes keys to browser.
router.post('/ai-chat', authMiddleware, async (req: AuthenticatedRequest, res: ExpressResponse): Promise<void> => {
  const projectId = (req.query.projectId ?? req.headers['x-project-id']) as string | undefined;
  if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }

  const secrets = await getProjectSecrets(projectId, req.user!.id);
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
// Authenticates via Supabase JWT, resolves the project's ECG_PORTAL_TOKEN
// from project_secrets, then forwards the request server-to-server to the portal API.
router.all('*', authMiddleware, async (req: AuthenticatedRequest, res: ExpressResponse): Promise<void> => {
  const projectId = (req.query.projectId ?? req.headers['x-project-id']) as string | undefined;
  if (!projectId) {
    res.status(400).json({ error: 'projectId required (query param or X-Project-Id header)' });
    return;
  }

  const secrets = await getProjectSecrets(projectId, req.user!.id);
  if (!secrets) { res.status(403).json({ error: 'Project not found or access denied' }); return; }

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
