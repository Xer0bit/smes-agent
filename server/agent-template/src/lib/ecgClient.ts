import { ECG } from '../ecg-config';
const SERVER = ECG.proxyUrl.replace(/\/$/, '');
const PROJECT_ID = ECG.projectId;

function accessHeaders(): Record<string, string> {
  const token = localStorage.getItem(`ecg_access_${PROJECT_ID}`);
  return token ? { 'x-dashboard-access': token } : {};
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
    throw new Error((e as { error?: string }).error || `API error ${res.status}`);
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
    create:  (data: unknown) => req('POST', '/agents', data),
    update:  (id: string, data: unknown) => req('PATCH', `/agents/${id}`, data),
    delete:  (id: string) => req('DELETE', `/agents/${id}`),
    run:     (id: string) => req('POST', `/agents/${id}/run`),
  },

  // Schedulers
  schedulers: {
    list:    () => req('GET', '/schedulers'),
    create:  (data: unknown) => req('POST', '/schedulers', data),
    update:  (id: string, data: unknown) => req('PATCH', `/schedulers/${id}`, data),
    delete:  (id: string) => req('DELETE', `/schedulers/${id}`),
    trigger: (id: string) => req('POST', `/schedulers/${id}/trigger`),
  },

  // Planned posts
  posts: {
    list:    () => req('GET', '/planned-posts'),
    create:  (data: unknown) => req('POST', '/planned-posts', data),
    delete:  (id: string) => req('DELETE', `/planned-posts/${id}`),
    approve: (id: string) => req('PATCH', `/planned-posts/${id}`, { status: 'approved' }),
    reject:  (id: string) => req('PATCH', `/planned-posts/${id}`, { status: 'rejected' }),
  },

  // Connectors
  connectors: {
    list:    () => req('GET', '/connectors'),
    create:  (data: unknown) => req('POST', '/connectors', data),
    update:  (id: string, data: unknown) => req('PATCH', `/connectors/${id}`, data),
    delete:  (id: string) => req('DELETE', `/connectors/${id}`),
  },

  // Runs
  runs: { list: () => req('GET', '/runs') },

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
};
