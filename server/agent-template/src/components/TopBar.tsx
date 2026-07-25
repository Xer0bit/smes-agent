import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Bell, FileText, Zap, AlertTriangle, Clock, Info } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';

// One combined fetch for the two header widgets: quick-search needs agents +
// posts; the notifications bell needs pending-review count, today's failed
// runs, and real server-side alerts (rate limits, topic-repeat warnings --
// these used to be written to the notifications table and never displayed
// anywhere). Both live here instead of each page re-fetching the same lists.
function useHeaderData() {
  const [agents, setAgents] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);

  function loadNotifications() {
    ecgApi.notifications.list(true).then((d: any) => setNotifications(Array.isArray(d) ? d : (d.notifications ?? []))).catch(() => {});
  }

  useEffect(() => {
    if (ECG.modules.includes('agents')) {
      ecgApi.agents.list().then((d: any) => setAgents(Array.isArray(d) ? d : (d.agents ?? []))).catch(() => {});
    }
    if (ECG.modules.includes('posts')) {
      ecgApi.posts.list().then((d: any) => setPosts(Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? []))).catch(() => {});
    }
    if (ECG.modules.includes('runs')) {
      ecgApi.runs.list().then((d: any) => setRuns(Array.isArray(d) ? d : (d.runs ?? []))).catch(() => {});
    }
    loadNotifications();
  }, []);

  const pendingCount = useMemo(() => posts.filter(p => p.status === 'draft').length, [posts]);
  const failedToday = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return runs.filter(r => {
      const st = (r.status ?? '').toLowerCase();
      if (st !== 'error' && st !== 'timeout' && st !== 'failed') return false;
      const started = new Date(r.startedAt ?? r.started_at ?? 0);
      return started >= today;
    }).length;
  }, [runs]);

  return { agents, posts, pendingCount, failedToday, notifications, reloadNotifications: loadNotifications };
}

export default function TopBar() {
  const navigate = useNavigate();
  const { agents, posts, pendingCount, failedToday, notifications, reloadNotifications } = useHeaderData();
  const [markingAll, setMarkingAll] = useState(false);

  async function handleMarkAllRead() {
    setMarkingAll(true);
    try { await ecgApi.notifications.markAllRead(); reloadNotifications(); }
    finally { setMarkingAll(false); }
  }
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { agents: [], posts: [] };
    return {
      agents: agents.filter(a => a.name?.toLowerCase().includes(q)).slice(0, 5),
      posts: posts.filter(p => p.content?.toLowerCase().includes(q)).slice(0, 5),
    };
  }, [query, agents, posts]);

  const hasNotifications = pendingCount > 0 || failedToday > 0 || notifications.length > 0;
  const hasResults = results.agents.length > 0 || results.posts.length > 0;

  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)', background: 'var(--card-bg)' }}>
      <div ref={searchRef} className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          placeholder="Search agents, posts…"
          className="w-full pl-9 pr-3 py-1.5 rounded-lg border text-sm focus:outline-none"
          style={{ background: 'var(--body-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
        />
        {searchOpen && query.trim() && (
          <div className="absolute left-0 top-full mt-1.5 w-80 rounded-xl border overflow-hidden z-30"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-md)' }}>
            {!hasResults ? (
              <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--muted)' }}>No matches</p>
            ) : (
              <div className="max-h-80 overflow-y-auto py-1">
                {results.agents.map(a => (
                  <button key={a.id} onClick={() => { navigate(`/agents/${a.id}`); setSearchOpen(false); setQuery(''); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--accent-bg)]">
                    <Zap className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                    <span className="text-sm truncate" style={{ color: 'var(--text)' }}>{a.name}</span>
                  </button>
                ))}
                {results.posts.map(p => (
                  <button key={p.id} onClick={() => { navigate('/posts'); setSearchOpen(false); setQuery(''); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--accent-bg)]">
                    <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--muted)' }} />
                    <span className="text-sm truncate" style={{ color: 'var(--text)' }}>{p.content}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={bellRef} className="relative ml-auto">
        <button onClick={() => setBellOpen(v => !v)} className="relative p-2 rounded-lg hover:bg-[var(--accent-bg)]">
          <Bell className="w-4 h-4" style={{ color: 'var(--muted)' }} />
          {hasNotifications && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full" style={{ background: '#dc2626' }} />
          )}
        </button>
        {bellOpen && (
          <div className="absolute right-0 top-full mt-1.5 w-72 rounded-xl border overflow-hidden z-30"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-md)' }}>
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Notifications</p>
              {notifications.length > 0 && (
                <button onClick={handleMarkAllRead} disabled={markingAll} className="text-[11px] hover:opacity-70 disabled:opacity-50" style={{ color: 'var(--accent)' }}>
                  Mark all read
                </button>
              )}
            </div>
            {!hasNotifications ? (
              <p className="text-xs px-3 pb-3" style={{ color: 'var(--muted)' }}>You're all caught up.</p>
            ) : (
              <div className="pb-1 max-h-80 overflow-y-auto">
                {pendingCount > 0 && (
                  <button onClick={() => { navigate('/posts'); setBellOpen(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--accent-bg)]">
                    <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                    <span className="text-sm" style={{ color: 'var(--text)' }}>{pendingCount} post{pendingCount === 1 ? '' : 's'} waiting for review</span>
                  </button>
                )}
                {failedToday > 0 && (
                  <button onClick={() => { navigate('/runs'); setBellOpen(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--accent-bg)]">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: '#dc2626' }} />
                    <span className="text-sm" style={{ color: 'var(--text)' }}>{failedToday} run{failedToday === 1 ? '' : 's'} failed today</span>
                  </button>
                )}
                {notifications.map(n => (
                  <button key={n.id} onClick={async () => { await ecgApi.notifications.markRead(n.id); reloadNotifications(); }}
                    className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--accent-bg)]">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: n.severity === 'warning' ? '#f59e0b' : 'var(--muted)' }} />
                    <span className="min-w-0">
                      <span className="block text-sm" style={{ color: 'var(--text)' }}>{n.title}</span>
                      {n.message && <span className="block text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{n.message}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
