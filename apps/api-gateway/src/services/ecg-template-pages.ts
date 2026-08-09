// Pre-built page component generators for the ECG dashboard template.
// Each function returns a React TSX string ready to be written to disk.

type Settings = Record<string, boolean | string> | undefined;

export function agentsPage(s?: Settings) {
  const showLastRun = s?.showLastRun !== false;
  return `import { useEffect, useState } from 'react';
import { Zap, Clock, AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function AgentsPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.agents.list()
      .then(d => setAgents(Array.isArray(d) ? d : (d.agents ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loader />;
  if (error)   return <Err msg={error} />;
  if (!agents.length) return <Empty label="No agents found" />;

  return (
    <div className="space-y-1">
      <p className="text-sm text-slate-500 mb-4">{agents.length} agent{agents.length !== 1 ? 's' : ''}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {agents.map((a: any) => (
          <div key={a.id} className="bg-white rounded-xl border border-slate-200 p-5 hover:border-blue-200 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <p className="font-semibold text-slate-800 text-sm">{a.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{a.templateName ?? a.template_name ?? ' '}</p>
                </div>
              </div>
              <StatusBadge status={a.status} />
            </div>
            {${showLastRun} && (a.lastRun || a.last_run) && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
                <Clock className="w-3 h-3" />
                Last run: {new Date(a.lastRun ?? a.last_run).toLocaleString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Loader() { return <div className="flex justify-center py-20"><span className="w-6 h-6 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Err({ msg }: { msg: string }) { return <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{msg}</div>; }
function Empty({ label }: { label: string }) { return <div className="text-center py-20 text-slate-400 text-sm">{label}</div>; }
`;
}

export function schedulersPage() {
  return `import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function SchedulersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.schedulers.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.schedulers ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loader />;
  if (error)   return <Err msg={error} />;
  if (!rows.length) return <Empty />;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {['Agent', 'Schedule', 'Next Run', 'Status'].map(h => (
              <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((s: any) => (
            <tr key={s.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-800">{s.agentName ?? s.agent_name ?? ' '}</td>
              <td className="px-4 py-3 text-slate-500 font-mono text-xs">{s.schedule ?? s.cron ?? s.cronExpression}</td>
              <td className="px-4 py-3 text-slate-500 text-xs">{s.nextRun ? new Date(s.nextRun).toLocaleString() : ' '}</td>
              <td className="px-4 py-3"><StatusBadge status={s.status ?? 'active'} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Loader() { return <div className="flex justify-center py-20"><span className="w-6 h-6 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Err({ msg }: { msg: string }) { return <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{msg}</div>; }
function Empty() { return <div className="text-center py-20 text-slate-400 text-sm">No schedulers configured</div>; }
`;
}

export function postsPage(s?: Settings) {
  const requireApproval = s?.requireApproval !== false;
  const defaultTab = (s?.defaultTab as string) || 'all';
  return `import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertCircle, FileText } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

const PLATFORM_COLORS: Record<string, string> = {
  linkedin: 'bg-blue-100 text-blue-700', twitter: 'bg-sky-100 text-sky-700',
  x: 'bg-sky-100 text-sky-700', instagram: 'bg-pink-100 text-pink-700',
  facebook: 'bg-indigo-100 text-indigo-700', email: 'bg-slate-100 text-slate-600',
};

export default function PostsPage() {
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('${defaultTab}' as Tab);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    ecgApi.posts.list()
      .then(d => setPosts(Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const visible = posts.filter(p => tab === 'all' || p.status === tab);
  const pending = posts.filter(p => p.status === 'pending').length;

  async function act(id: string, action: 'approve' | 'reject') {
    setActing(id);
    try {
      if (action === 'approve') await ecgApi.posts.approve(id);
      else await ecgApi.posts.reject(id);
      setPosts(prev => prev.map(p => p.id === id ? { ...p, status: action === 'approve' ? 'approved' : 'rejected' } : p));
    } catch (e: any) { setError(e.message); }
    finally { setActing(null); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg w-fit">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={\`px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize \${tab === t ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}\`}>
            {t}{t === 'pending' && pending > 0 ? \` (\${pending})\` : ''}
          </button>
        ))}
      </div>

      {error && <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}

      {loading ? (
        <div className="flex justify-center py-20"><span className="w-6 h-6 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>
      ) : !visible.length ? (
        <div className="text-center py-20 text-slate-400 text-sm">No {tab === 'all' ? '' : tab} posts</div>
      ) : (
        <div className="space-y-3">
          {visible.map((p: any) => {
            const platform = (p.platform ?? '').toLowerCase();
            const platCls = PLATFORM_COLORS[platform] ?? 'bg-slate-100 text-slate-600';
            return (
              <div key={p.id} className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <FileText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-slate-700 leading-relaxed">{p.content ?? p.body ?? '(no content)'}</p>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <div className="flex items-center gap-2 flex-wrap">
                    {platform && <span className={\`text-xs px-2 py-0.5 rounded-full font-medium capitalize \${platCls}\`}>{platform}</span>}
                    <span className="text-xs text-slate-400">{p.agentName ?? p.agent_name}</span>
                    {(p.scheduledAt ?? p.scheduled_at) && <span className="text-xs text-slate-400">· {new Date(p.scheduledAt ?? p.scheduled_at).toLocaleString()}</span>}
                  </div>
                  {${requireApproval} && p.status === 'pending' && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => act(p.id, 'reject')} disabled={acting === p.id}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors disabled:opacity-50">
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                      <button onClick={() => act(p.id, 'approve')} disabled={acting === p.id}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50">
                        <CheckCircle className="w-3.5 h-3.5" /> Approve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
`;
}

export function connectorsPage() {
  return `import { useEffect, useState } from 'react';
import { Plug, AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function ConnectorsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.connectors.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.connectors ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loader />;
  if (error)   return <Err msg={error} />;
  if (!rows.length) return <Empty />;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {rows.map((c: any) => (
        <div key={c.id} className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
              <Plug className="w-4 h-4 text-slate-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-slate-800 text-sm truncate">{c.name}</p>
                <StatusBadge status={c.status ?? 'active'} />
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">{c.type}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Loader() { return <div className="flex justify-center py-20"><span className="w-6 h-6 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Err({ msg }: { msg: string }) { return <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{msg}</div>; }
function Empty() { return <div className="text-center py-20 text-slate-400 text-sm">No connectors configured</div>; }
`;
}

export function runsPage(s?: Settings) {
  const showDuration = s?.showDuration !== false;
  return `import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

function dur(start: string, end?: string) {
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime();
  if (ms < 1000) return \`\${ms}ms\`;
  if (ms < 60000) return \`\${(ms / 1000).toFixed(1)}s\`;
  return \`\${Math.round(ms / 60000)}m\`;
}

export default function RunsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.runs.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.runs ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loader />;
  if (error)   return <Err msg={error} />;
  if (!rows.length) return <Empty />;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {['Agent', 'Status', 'Duration', 'Started'].map(h => (
              <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r: any) => (
            <tr key={r.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-800">{r.agentName ?? r.agent_name ?? ' '}</td>
              <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
              <td className="px-4 py-3 text-slate-500 tabular-nums">{dur(r.startedAt ?? r.started_at, r.completedAt ?? r.completed_at)}</td>
              <td className="px-4 py-3 text-slate-400 text-xs">{new Date(r.startedAt ?? r.started_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Loader() { return <div className="flex justify-center py-20"><span className="w-6 h-6 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Err({ msg }: { msg: string }) { return <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{msg}</div>; }
function Empty() { return <div className="text-center py-20 text-slate-400 text-sm">No runs recorded yet</div>; }
`;
}

export function knowledgePage() {
  return `import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';

const TYPE_ICONS: Record<string, string> = { document: '📄', url: '🔗', text: '📝' };

export default function KnowledgePage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.knowledge.list()
      .then(d => setItems(Array.isArray(d) ? d : (d.knowledge ?? d.items ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loader />;
  if (error)   return <Err msg={error} />;
  if (!items.length) return <Empty />;

  return (
    <div className="space-y-2">
      {items.map((k: any) => (
        <div key={k.id} className="bg-white rounded-xl border border-slate-200 px-5 py-4 flex items-center gap-4">
          <span className="text-xl">{TYPE_ICONS[k.type] ?? '📄'}</span>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-slate-800 text-sm truncate">{k.title ?? k.name ?? 'Untitled'}</p>
            <p className="text-xs text-slate-400 mt-0.5 capitalize">{k.type ?? 'document'}</p>
          </div>
          {k.agentName && <span className="text-xs text-slate-400 shrink-0">{k.agentName}</span>}
        </div>
      ))}
    </div>
  );
}

function Loader() { return <div className="flex justify-center py-20"><span className="w-6 h-6 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Err({ msg }: { msg: string }) { return <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{msg}</div>; }
function Empty() { return <div className="text-center py-20 text-slate-400 text-sm">No knowledge assets found</div>; }
`;
}

export function aiAssistantPage() {
  return `import { useState } from 'react';
import { Send, Bot, AlertCircle } from 'lucide-react';

const SERVER = (import.meta.env.VITE_ECG_PROXY_URL || '').replace(/\\/$/, '');
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID || '';

type Message = { role: 'user' | 'assistant'; content: string };

export default function AiAssistantPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setLoading(true);
    setError('');
    try {
      const res = await fetch(\`\${SERVER}/api/v1/ecg-chat?projectId=\${PROJECT_ID}\`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setMessages(p => [...p, { role: 'assistant', content: data.reply, ...(data.actions ? { actions: data.actions } : {}) }]);
    } catch (e: any) {
      setError(e.message ?? 'Failed to reach AI assistant');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex-1 overflow-y-auto space-y-3 pb-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
            <Bot className="w-8 h-8" />
            <p className="text-sm">Ask me about your agents, posts, or run history.</p>
          </div>
        )}
        {messages.map((m: any, i) => (
          <div key={i} className={\`flex \${m.role === 'user' ? 'justify-end' : 'justify-start'}\`}>
            <div className={\`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed \${m.role === 'user' ? 'text-white' : 'text-slate-800 border border-slate-200'}\`}
              style={m.role === 'user' ? { background: 'var(--accent)' } : { background: 'var(--card-bg)' }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-2.5 border border-slate-200 text-slate-400 text-xs flex items-center gap-1.5"
              style={{ background: 'var(--card-bg)' }}>
              <span className="w-3 h-3 border-2 border-slate-300 border-t-current rounded-full animate-spin inline-block" />
              Thinking…
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}
      </div>
      <div className="flex gap-2 pt-3 border-t border-slate-200">
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Ask about your agents or content…"
          className="flex-1 text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
          style={{ background: 'var(--card-bg)', color: 'var(--text)' }} />
        <button onClick={send} disabled={!input.trim() || loading}
          className="px-4 py-2.5 rounded-xl text-white text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)' }}>
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
`;
}

// dashboardChatTsx and emptyPage live in ecg-template-chat.ts to keep this file under 500 lines.
export { dashboardChatTsx, emptyPage } from './ecg-template-chat.js';
