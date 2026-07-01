import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, FileText } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

const TABS = ['all', 'pending', 'approved', 'rejected'] as const;
type Tab = typeof TABS[number];

const PLATFORM_COLORS: Record<string, string> = {
  linkedin: 'bg-blue-100 text-blue-700', twitter: 'bg-sky-100 text-sky-700',
  x: 'bg-sky-100 text-sky-700', instagram: 'bg-pink-100 text-pink-700',
  facebook: 'bg-indigo-100 text-indigo-700',
};

export default function PostsPage() {
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('pending');
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    ecgApi.posts.list()
      .then(d => setPosts(Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? [])))
      .finally(() => setLoading(false));
  }, []);

  const visible = posts.filter(p => tab === 'all' || p.status === tab);
  const pendingCount = posts.filter(p => p.status === 'pending').length;

  async function act(id: string, action: 'approve' | 'reject') {
    setActing(id);
    try {
      if (action === 'approve') await ecgApi.posts.approve(id);
      else await ecgApi.posts.reject(id);
      setPosts(prev => prev.map(p => p.id === id ? { ...p, status: action === 'approve' ? 'approved' : 'rejected' } : p));
    } finally { setActing(null); }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Planned Posts</h1>
      <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: 'var(--border)' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors"
            style={tab === t ? { background: 'var(--card-bg)', color: 'var(--text)' } : { color: 'var(--muted)' }}>
            {t}{t === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>
      {loading && <Spinner />}
      {!loading && !visible.length && <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No {tab} posts</div>}
      {!loading && (
        <div className="space-y-3">
          {visible.map((p: any) => {
            const platCls = PLATFORM_COLORS[(p.platform ?? '').toLowerCase()] ?? 'bg-slate-100 text-slate-600';
            return (
              <div key={p.id} className="rounded-xl border p-5 space-y-3"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <FileText className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{p.content ?? p.body ?? '(no content)'}</p>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {p.platform && <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${platCls}`}>{p.platform}</span>}
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{p.agentName ?? p.agent_name}</span>
                  </div>
                  {p.status === 'pending' && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => act(p.id, 'reject')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg disabled:opacity-50">
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                      <button onClick={() => act(p.id, 'approve')} disabled={!!acting}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50"
                        style={{ background: 'var(--accent)' }}>
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

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
