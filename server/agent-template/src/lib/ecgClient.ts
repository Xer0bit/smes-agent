import { ECG } from '../ecg-config';
const SERVER = ECG.proxyUrl.replace(/\/$/, '');
const PROJECT_ID = ECG.projectId;
const ACTIVE_AGENT_KEY = `ecg_active_agent_${PROJECT_ID}`;

function accessHeaders(): Record<string, string> {
  const token = localStorage.getItem(`ecg_access_${PROJECT_ID}`);
  return token ? { 'x-dashboard-access': token } : {};
}

// Which of this dashboard's managed agents (ECG.agentIds) is currently active
// -- read by the Layout.tsx agent switcher and by every ecgApi call below
// that accepts an agentId filter, so switching agents re-scopes the whole
// dashboard without a re-seed. Defaults to the first managed agent; falls
// back to null (no filter -- shows everything) if the dashboard has none.
export function getActiveAgentId(): string | null {
  const stored = localStorage.getItem(ACTIVE_AGENT_KEY);
  if (stored && ECG.agentIds.includes(stored)) return stored;
  return ECG.agentIds[0] ?? null;
}

export function setActiveAgentId(agentId: string): void {
  localStorage.setItem(ACTIVE_AGENT_KEY, agentId);
}

// Appends the active agent as a query param when one is set -- shared by
// every proxy call below that the MCP tool layer can filter by agentId.
function withActiveAgent(path: string): string {
  const agentId = getActiveAgentId();
  if (!agentId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}agentId=${encodeURIComponent(agentId)}`;
}

// 501 means the proxy explicitly has no MCP-tool equivalent for this call
// (org/team/api-keys/billing on an MCP-connected dashboard   see
// ecg-proxy.routes.ts's mapToMcpTool). Distinguish that from a real failure
// so the UI can show "not available" instead of a blanket error.
export function isUnsupported(e: unknown): boolean {
  return (e as { status?: number })?.status === 501;
}

async function req(method: string, path: string, body?: unknown) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${SERVER}/api/v1/ecg-proxy${path}${sep}projectId=${PROJECT_ID}`;
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...accessHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const err = new Error((e as { error?: string }).error || `API error ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function reqMultipart(path: string, formData: FormData) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${SERVER}/api/v1/ecg-proxy${path}${sep}projectId=${PROJECT_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { ...accessHeaders() },
    body: formData,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error((e as { error?: string }).error || `API error ${res.status}`);
  }
  return res.json();
}

export async function chat(messages: { role: string; content: string }[]) {
  const url = `${SERVER}/api/v1/ecg-chat?projectId=${PROJECT_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...accessHeaders() },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error((e as { error?: string }).error || `Chat error ${res.status}`);
  }
  return res.json() as Promise<{ reply: string; actions: { tool: string; result: unknown }[] }>;
}

export const ecgApi = {
  // Agent templates
  templates:  { list: () => req('GET', '/agent-templates') },

  // Agents
  agents: {
    list:    () => req('GET', '/agents'),
    get:     (id: string) => req('GET', `/agents/${id}`),
    create:  (data: unknown) => req('POST', '/agents', data),
    update:  (id: string, data: unknown) => req('PATCH', `/agents/${id}`, data),
    delete:  (id: string) => req('DELETE', `/agents/${id}`),
    run:     (id: string) => req('POST', `/agents/${id}/run`),
  },

  // Schedulers
  schedulers: {
    list:    () => req('GET', withActiveAgent('/schedulers')),
    create:  (data: unknown) => req('POST', '/schedulers', data),
    update:  (id: string, data: unknown) => req('PATCH', `/schedulers/${id}`, data),
    delete:  (id: string) => req('DELETE', `/schedulers/${id}`),
    // Backend route is /replan, not /trigger   there is no /trigger endpoint.
    trigger: (id: string) => req('POST', `/schedulers/${id}/replan`),
  },

  // Planned posts. Status is the REAL backend vocabulary, not a simplified
  // one: draft (awaiting review) | scheduled | posting | posted | failed |
  // cancelled. get_planned_posts returns these unmapped, so the UI must
  // speak the same values as the proxy mapping below expects.
  posts: {
    // No args (the common case, e.g. PostsPage/PostsCalendarPage): scoped to
    // the active agent. { agentId: null } explicitly opts OUT of that scoping
    // for the rare cross-agent view (AgentsPage's per-agent "next up" summary
    // needs every managed agent's posts, not just the active one).
    list: (opts?: { agentId?: string | null }) => {
      if (opts && 'agentId' in opts) {
        return req('GET', opts.agentId ? `/planned-posts?agentId=${encodeURIComponent(opts.agentId)}` : '/planned-posts');
      }
      return req('GET', withActiveAgent('/planned-posts'));
    },
    create:  (data: unknown) => req('POST', '/planned-posts', data),
    delete:  (id: string) => req('DELETE', `/planned-posts/${id}`),
    // Approving a draft and retrying a failed post are the same call --
    // both just move the post back to 'scheduled'.
    approve: (id: string) => req('PATCH', `/planned-posts/${id}`, { status: 'scheduled' }),
    reject:  (id: string) => req('PATCH', `/planned-posts/${id}`, { status: 'cancelled' }),
    update:  (id: string, data: { content?: string; platform?: string; scheduledAt?: string }) => req('PATCH', `/planned-posts/${id}`, data),
    bulkApprove: (ids: string[]) => req('POST', '/planned-posts/bulk-approve', { postIds: ids }),
    // Rewrites the post's content (optionally steered by feedback), puts it
    // back in Draft for review -- distinct from `approve`/`reject`, which
    // only ever touch status.
    regenerate: (id: string, feedback?: string) => req('POST', `/planned-posts/${id}/regenerate`, { feedback }),
  },

  // Post visuals   Canva-style canvas (background + positioned text/image/
  // shape objects), generated by the agent and directly editable. See
  // VisualEditorPage.
  visualPosts: {
    list:       (plannedPostId?: string) => req('GET', plannedPostId ? `/visual-posts?plannedPostId=${plannedPostId}` : '/visual-posts'),
    get:        (id: string) => req('GET', `/visual-posts/${id}`),
    generate:   (data: { agentId?: string; plannedPostId?: string; postContent: string; platform?: string; stylePrompt?: string }) =>
      req('POST', '/visual-posts/generate', data),
    update:     (id: string, data: { objects?: unknown[]; background?: string }) => req('PATCH', `/visual-posts/${id}`, data),
    regenerate: (id: string, data: { postContent: string; stylePrompt?: string }) => req('POST', `/visual-posts/${id}/regenerate`, data),
    finalize:   (id: string) => req('POST', `/visual-posts/${id}/finalize`),
  },

  // Connectors   the backend router (connectors.ts) is mounted directly at
  // /v1/ecg/connectors but its actual routes all live under /org (/org,
  // /org/:id, /org/:id/test, /zapier/discover)   there is no bare `/` or
  // `/:id` route. Every call here used to 404 silently before this fix.
  connectors: {
    list:    () => req('GET', '/connectors/org'),
    create:  (data: unknown) => req('POST', '/connectors/org', data),
    update:  (id: string, data: unknown) => req('PATCH', `/connectors/org/${id}`, data),
    delete:  (id: string) => req('DELETE', `/connectors/org/${id}`),
    test:    (id: string) => req('POST', `/connectors/org/${id}/test`),
    // Checks which apps are actually enabled on a Zapier MCP token BEFORE
    // creating a connector  avoids guessing which platform dropdown option
    // matches what's set up on zapier.com/mcp.
    discover: (token: string) => req('POST', '/connectors/discover', { token }) as Promise<{ apps: string[] }>,
  },

  // Runs
  runs: {
    list:    () => req('GET', withActiveAgent('/runs')),
    // Full detail for one run, including the post it produced (if any) --
    // GET /runs (list) never carries output content, only metadata.
    get:     (id: string) => req('GET', `/runs/${id}`),
    approve: (id: string) => req('PATCH', `/runs/${id}`, { reviewed: true }),
    flag:    (id: string, flagNote?: string) => req('PATCH', `/runs/${id}`, { flagged: true, flagNote }),
  },

  // Notifications (failed runs, rate limits, repeat-topic warnings, etc.)
  notifications: {
    list:         (unreadOnly?: boolean) => req('GET', unreadOnly ? '/notifications?unreadOnly=true' : '/notifications'),
    markRead:     (id: string) => req('PATCH', `/notifications/${id}/read`),
    markAllRead:  () => req('POST', '/notifications/mark-all-read'),
  },

  // Knowledge
  knowledge: {
    list:   () => req('GET', '/knowledge'),
    upload: (formData: FormData) => reqMultipart('/knowledge/upload', formData),
    delete: (id: string) => req('DELETE', `/knowledge/${id}`),
  },

  // Knowledge bases
  knowledgeBases: {
    list:    () => req('GET', '/knowledge-bases'),
    create:  (data: unknown) => req('POST', '/knowledge-bases', data),
    update:  (id: string, data: unknown) => req('PATCH', `/knowledge-bases/${id}`, data),
    delete:  (id: string) => req('DELETE', `/knowledge-bases/${id}`),
  },

  // Org settings
  org: {
    get:    () => req('GET', '/org'),
    update: (data: unknown) => req('PATCH', '/org', data),
  },

  // Auto-approve trust dial only -- separate from `org` above (which stays
  // portal-account-only: name/billing/entitlements).
  orgSettings: {
    get:    () => req('GET', '/org-settings'),
    update: (data: { autoApprovePosts?: boolean; autoApproveConfidenceThreshold?: number }) => req('PATCH', '/org-settings', data),
  },

  // Team
  team: {
    list:    () => req('GET', '/team'),
    create:  (data: unknown) => req('POST', '/team', data),
    delete:  (id: string) => req('DELETE', `/team/${id}`),
  },

  // API keys
  apiKeys: {
    list:   () => req('GET', '/api-keys'),
    create: (data: unknown) => req('POST', '/api-keys', data),
    revoke: (id: string) => req('PATCH', `/api-keys/${id}/revoke`),
  },

  // Billing
  billing: {
    invoices: () => req('GET', '/billing/invoices'),
  },

  // Summary
  summary: { get: () => req('GET', '/summary') },
  stats:   { get: () => req('GET', '/stats') },

  // One-off LLM call for "preview what this agent would write" in the Create
  // Agent wizard, before the agent (and its real generation pipeline) exists.
  // Backed by the generic server-side LLM proxy (ai-chat) -- reads the
  // project's own ECG_LLM_* secret, never touches the browser with the key.
  // Returns plain text regardless of which provider (OpenAI/Anthropic/Google)
  // the project has configured, since callers shouldn't need to know that shape.
  assistant: {
    preview: async (systemPrompt: string, userPrompt: string): Promise<string> => {
      const data: any = await req('POST', '/ai-chat', { systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
      return data.choices?.[0]?.message?.content // OpenAI-compatible
        ?? data.content?.[0]?.text // Anthropic
        ?? data.candidates?.[0]?.content?.parts?.[0]?.text // Google
        ?? '';
    },
  },
};

// True when a preview call failed because this project has no LLM key
// configured (App Builder -> AI Model) -- not a real error, just "not set up
// yet." Callers should show a graceful "preview unavailable" state, not an
// error banner.
export function isPreviewUnavailable(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return err?.status === 400 && /no llm api key configured/i.test(err.message ?? '');
}
