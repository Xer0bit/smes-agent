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
    throw new Error((e as any).error || `API error ${res.status}`);
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
    throw new Error((e as any).error || `Chat error ${res.status}`);
  }
  return res.json() as Promise<{ reply: string; actions: { tool: string; result: unknown }[] }>;
}

export const ecgApi = {
  agents:     { list: () => req('GET', '/agents') },
  schedulers: { list: () => req('GET', '/schedulers') },
  posts: {
    list:    () => req('GET', '/planned-posts'),
    approve: (id: string) => req('PATCH', `/planned-posts/${id}`, { status: 'approved' }),
    reject:  (id: string) => req('PATCH', `/planned-posts/${id}`, { status: 'rejected' }),
  },
  connectors: { list: () => req('GET', '/connectors') },
  runs:       { list: () => req('GET', '/runs') },
  knowledge:  { list: () => req('GET', '/knowledge') },
  summary:    { get:  () => req('GET', '/summary') },
};
