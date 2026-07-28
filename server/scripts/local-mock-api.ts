/**
 * Minimal stdlib-only mock of the ecg-proxy REST surface (ecgClient.ts's
 * `req()`), so `npm run template:dev` shows a populated dashboard instead of
 * every page's EmptyState. Not a real backend -- fixed in-memory fixtures,
 * mutations are accepted and echoed back but never persisted across restarts.
 *
 * Exports `startMockApi(port, agentIds, agentNames)` -- returns the http.Server.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

interface Fixtures {
  agents: any[];
  connectors: any[];
  posts: any[];
  schedulers: any[];
  runs: any[];
  knowledge: any[];
  knowledgeBases: any[];
}

function buildFixtures(agentIds: string[], agentNames: Record<string, string>): Fixtures {
  const now = Date.now();
  const day = 86_400_000;
  const primaryAgent = agentIds[0];
  const primaryName = agentNames[primaryAgent] ?? 'LinkedIn Growth';

  const agents = agentIds.map((id, i) => ({
    id,
    name: agentNames[id] ?? `Agent ${i + 1}`,
    status: i === 0 ? 'active' : 'idle',
    templateName: 'Social Media',
    template_category: 'social',
    lastRun: new Date(now - (i + 1) * 3_600_000).toISOString(),
  }));

  const connectors = [
    { id: 'c1', name: 'Main LinkedIn', type: 'zapier-mcp-linkedin', status: 'connected', platforms: ['linkedin'] },
    { id: 'c2', name: 'Main Instagram', type: 'zapier-mcp-instagram', status: 'connected', platforms: ['instagram'] },
    { id: 'c3', name: 'Broken X Account', type: 'zapier-mcp-x', status: 'error', platforms: ['x'] },
  ];

  const posts = [
    { id: 'p1', agentId: primaryAgent, agentName: primaryName, platform: 'linkedin', status: 'draft', confidence: 0.82,
      content: "Excited to share our Q3 roadmap — we're doubling down on developer tooling this quarter.", createdAt: new Date(now - 2 * 3_600_000).toISOString() },
    { id: 'p2', agentId: primaryAgent, agentName: primaryName, platform: 'linkedin', status: 'scheduled',
      content: 'Behind the scenes: how our team ships weekly without breaking prod.', scheduledAt: new Date(now + day).toISOString() },
    { id: 'p3', agentId: primaryAgent, agentName: primaryName, platform: 'instagram', status: 'posted',
      content: 'Team offsite recap 🌴', scheduledAt: new Date(now - 3 * day).toISOString(), postUrl: 'https://instagram.com/p/example' },
    { id: 'p4', agentId: primaryAgent, agentName: primaryName, platform: 'x', status: 'failed',
      content: 'Quick tip: batch your API calls to cut latency in half.', scheduledAt: new Date(now - day).toISOString(),
      errorMessage: 'Rate limited by platform API — retry in 15 minutes.' },
    { id: 'p5', agentId: primaryAgent, agentName: primaryName, platform: 'linkedin', status: 'scheduled',
      content: 'Hiring: senior platform engineer, remote-friendly.', scheduledAt: new Date(now + 3 * day).toISOString() },
    { id: 'p6', agentId: primaryAgent, agentName: primaryName, platform: 'instagram', status: 'cancelled',
      content: 'Draft that got pulled before it went out.', createdAt: new Date(now - 5 * day).toISOString() },
  ];

  const schedulers = [
    { id: 's1', agentId: primaryAgent, agentName: primaryName, schedule: '0 9 * * 1,3,5', cron: '0 9 * * 1,3,5', postCount: 3,
      nextRun: new Date(now + day).toISOString(), status: 'active' },
  ];

  const runs = Array.from({ length: 8 }, (_, i) => {
    const failed = i === 2 || i === 5;
    const startedAt = new Date(now - (i + 1) * 4 * 3_600_000);
    return {
      id: `r${i + 1}`,
      agentId: primaryAgent,
      agentName: primaryName,
      status: failed ? 'failed' : 'completed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date(startedAt.getTime() + 30_000 + i * 4_000).toISOString(),
      durationMs: 30_000 + i * 4_000,
      cost: 0.008 + i * 0.001,
      error: failed ? 'Model request timed out after 30s' : undefined,
    };
  });

  const knowledgeBases = [{ id: 'kb1', name: 'General', description: 'Default knowledge base' }];
  const knowledge = [
    { id: 'k1', title: 'Brand Voice Guide', type: 'document', status: 'ready', createdAt: new Date(now - 10 * day).toISOString() },
    { id: 'k2', title: 'Product FAQ', type: 'text', status: 'ready', createdAt: new Date(now - 4 * day).toISOString() },
    { id: 'k3', title: 'Competitor research (link)', type: 'url', status: 'processing', createdAt: new Date(now - 3_600_000).toISOString() },
  ];

  return { agents, connectors, posts, schedulers, runs, knowledge, knowledgeBases };
}

function statsPayload(f: Fixtures) {
  const platforms = ['linkedin', 'instagram', 'x'].map(platform => {
    const rows = f.posts.filter(p => p.platform === platform && p.status === 'posted');
    return { platform, posted30d: rows.length + 2, previous30d: rows.length, total: rows.length + 5 };
  });
  const daily = Array.from({ length: 30 }, (_, i) => ({
    platform: 'linkedin',
    day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
    count: i % 3 === 0 ? 1 : 0,
  }));
  const statusBreakdown: Record<string, number> = {};
  for (const p of f.posts) statusBreakdown[p.status] = (statusBreakdown[p.status] ?? 0) + 1;
  const runSuccess = f.runs.filter(r => r.status === 'completed').length;
  const runFailed = f.runs.filter(r => r.status === 'failed').length;
  return { platforms, daily, statusBreakdown, runs30d: { success: runSuccess, failed: runFailed, cost: f.runs.reduce((n, r) => n + r.cost, 0) } };
}

export function startMockApi(port: number, agentIds: string[], agentNames: Record<string, string>, llmConfigured = false): http.Server {
  const fixtures = buildFixtures(agentIds, agentNames);

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin ?? '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-access');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/v1/ecg-access') return send({ accessToken: 'local-preview' });
    if (url.pathname === '/api/v1/ecg-chat') return send({ reply: "This is a local preview — the assistant isn't wired to a real model here.", actions: [] });

    if (!url.pathname.startsWith('/api/v1/ecg-proxy')) return send({ error: 'not found' }, 404);
    const path = url.pathname.replace('/api/v1/ecg-proxy', '') || '/';

    let bodyChunks: Buffer[] = [];
    req.on('data', c => bodyChunks.push(c));
    req.on('end', () => {
      let payload: any = {};
      try { payload = bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) : {}; } catch { /* ignore */ }

      // Order matters: more specific segments before their parent list route.
      if (path === '/agent-templates') return send([
        { id: 't1', name: 'Social Media Growth', description: 'Writes and schedules platform-native posts.',
          connectorTypes: ['zapier-mcp-linkedin'], scheduleCapable: true,
          instructionsHint: 'Tell it your brand voice and 2-3 topics to focus on -- e.g. "confident but not salesy, focus on product updates and customer wins."' },
      ]);
      if (path === '/ai-chat') {
        if (!llmConfigured) return send({ error: 'No LLM API key configured for this project. Set one in App Builder → AI Model.' }, 400);
        const content = "Excited to share how our latest release cuts setup time in half for new teams — built from direct customer feedback. #ProductUpdate";
        return send({ choices: [{ message: { content } }] });
      }
      if (path === '/knowledge-bases') return send(req.method === 'GET' ? fixtures.knowledgeBases : { id: randomUUID(), ...payload });
      if (path.startsWith('/knowledge')) return send(req.method === 'GET' ? fixtures.knowledge : { id: randomUUID(), ...payload });
      if (path.startsWith('/connectors/org')) {
        if (path.includes('/test')) return send({ note: 'Connection verified (local preview).' });
        return send(req.method === 'GET' ? fixtures.connectors : { id: randomUUID(), status: 'connected', ...payload });
      }
      if (path === '/connectors/discover') return send({ apps: ['LinkedIn', 'Instagram'] });
      if (path.startsWith('/schedulers')) {
        if (path.includes('/replan')) return send({ ok: true });
        return send(req.method === 'GET' ? fixtures.schedulers : { id: randomUUID(), status: 'active', ...payload });
      }
      if (path.startsWith('/planned-posts')) {
        if (path.includes('/bulk-approve')) return send({ ok: true });
        if (path.includes('/regenerate')) return send({ content: 'Regenerated take: ' + (payload.feedback ?? 'a fresh angle on the same topic.'), confidence: 0.9 });
        return send(req.method === 'GET' ? fixtures.posts : { id: randomUUID(), status: 'draft', ...payload });
      }
      if (path.startsWith('/visual-posts')) {
        if (path.includes('/generate')) return send({ id: randomUUID(), width: 1080, height: 1080, background: '#ffffff', objects: [], status: 'draft', platform: payload.platform ?? 'linkedin' });
        return send({ id: randomUUID(), width: 1080, height: 1080, background: '#ffffff', objects: [], status: 'draft' });
      }
      if (path.startsWith('/runs')) return send(fixtures.runs);
      if (path === '/notifications' || path.startsWith('/notifications?')) return send([]);
      if (path.startsWith('/notifications')) return send({ ok: true });
      if (path.startsWith('/agents')) {
        if (path.includes('/run')) return send({ ok: true });
        const idMatch = path.match(/^\/agents\/([^/]+)$/);
        if (idMatch) {
          const agent = fixtures.agents.find(a => a.id === idMatch[1]) ?? fixtures.agents[0];
          return send({
            agent,
            recentRuns: fixtures.runs.slice(0, 3),
            schedulers: fixtures.schedulers,
          });
        }
        return send(req.method === 'GET' ? fixtures.agents : { id: randomUUID(), status: 'active', ...payload });
      }
      if (path === '/org-settings') return send({ autoApprovePosts: false, autoApproveConfidenceThreshold: 0.85 });
      if (path === '/org') return send({ name: 'Preview Org', country: 'US', timezone: 'America/New_York' });
      if (path === '/team') return send([{ id: 'u1', name: 'Jane Doe', email: 'jane@preview.org', role: 'admin' }]);
      if (path === '/api-keys') return send([{ id: 'k1', name: 'Production', keyPrefix: 'sk_live_abc123', status: 'active' }]);
      if (path === '/billing/invoices') return send([]);
      if (path === '/summary') return send({});
      if (path === '/stats') return send(statsPayload(fixtures));

      send({}, 200);
    });
  });

  server.listen(port);
  return server;
}
