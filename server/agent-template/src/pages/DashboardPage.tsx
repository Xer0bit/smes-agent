import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Loader2, CheckCircle2, Link2, ChevronRight, FileText, XCircle, TrendingUp, BarChart2 } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';

const PLATFORM_META: Record<string, { label: string; bar: string }> = {
  linkedin:  { label: 'LinkedIn',  bar: '#0077B5' },
  facebook:  { label: 'Facebook',  bar: '#1877F2' },
  instagram: { label: 'Instagram', bar: '#E1306C' },
  x:         { label: 'X',         bar: '#64748b' },
  twitter:   { label: 'X',         bar: '#64748b' },
  youtube:   { label: 'YouTube',   bar: '#FF0000' },
  tiktok:    { label: 'TikTok',    bar: '#69C9D0' },
  whatsapp:  { label: 'WhatsApp',  bar: '#25D366' },
};
function platformMeta(p: string) {
  return PLATFORM_META[p.toLowerCase()] ?? { label: p, bar: 'var(--muted)' };
}

const has = (m: string) => ECG.modules.includes(m);

export default function DashboardPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      has('agents')     ? ecgApi.agents.list().then(d => Array.isArray(d) ? d : (d.agents ?? [])) : Promise.resolve([]),
      has('posts')      ? ecgApi.posts.list().then(d => Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? [])) : Promise.resolve([]),
      has('connectors') ? ecgApi.connectors.list().then(d => Array.isArray(d) ? d : (d.connectors ?? [])) : Promise.resolve([]),
    ])
      .then(([a, p, c]) => { setAgents(a); setPosts(p); setConnectors(c); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // NOTE: the proxy this dashboard reads through collapses the portal's real
  // draft/scheduled/posted/failed post lifecycle down to just
  // pending/approved/rejected (see ecgData.toDashboardPostStatus on the
  // portal side)   there is no way to tell "scheduled" from "already posted"
  // through this endpoint, so KPIs are built from the 3 states that actually
  // exist here rather than faking the richer 4-state breakdown.
  const pending  = useMemo(() => posts.filter(p => p.status === 'pending'), [posts]);
  const approved = useMemo(() => posts.filter(p => p.status === 'approved'), [posts]);
  const rejected = useMemo(() => posts.filter(p => p.status === 'rejected'), [posts]);

  const platformStats = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of posts) {
      const pl = (p.platform ?? 'unknown').toLowerCase();
      map[pl] = (map[pl] ?? 0) + 1;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [posts]);
  const maxCount = Math.max(1, ...platformStats.map(([, n]) => n));

  const hasConnector = connectors.some((c: any) => (c.status ?? '').toLowerCase() === 'connected' || (c.status ?? '').toLowerCase() === 'active');
  const hasAgent = agents.length > 0;
  const setupSteps = [
    ...(has('connectors') ? [{ done: hasConnector, title: 'Connect a platform', cta: hasConnector ? 'Manage' : 'Connect', path: '/connectors', Icon: Link2 }] : []),
    ...(has('agents')     ? [{ done: hasAgent, title: 'Create an agent', cta: hasAgent ? 'View' : 'Create', path: '/agents', Icon: Zap }] : []),
  ];
  const setupDone = setupSteps.every(s => s.done);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Home</h1>

      {setupSteps.length > 0 && !setupDone && (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Get started</p>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{setupSteps.filter(s => s.done).length}/{setupSteps.length}</span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {setupSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3" style={step.done ? { opacity: 0.4 } : undefined}>
                <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-bg,#ede9fe)' }}>
                  {step.done ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} /> : <step.Icon className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />}
                </div>
                <p className="flex-1 text-sm" style={{ color: 'var(--text)' }}>{step.title}</p>
                <button onClick={() => navigate(step.path)}
                  className="text-xs flex items-center gap-0.5 transition-opacity hover:opacity-70 shrink-0" style={{ color: 'var(--accent)' }}>
                  {step.cta} <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {ECG.showSummaryCards && has('posts') && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Pending',  value: pending.length,  Icon: FileText,     tint: 'var(--muted)' },
            { label: 'Approved', value: approved.length, Icon: TrendingUp,   tint: 'var(--accent)' },
            { label: 'Rejected', value: rejected.length, Icon: XCircle,      tint: '#dc2626' },
          ].map(card => (
            <div key={card.label} className="rounded-xl border p-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs" style={{ color: 'var(--muted)' }}>{card.label}</p>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-bg,#ede9fe)' }}>
                  <card.Icon className="w-3.5 h-3.5" style={{ color: card.tint }} />
                </div>
              </div>
              <p className="text-2xl font-bold" style={{ color: card.tint }}>{card.value}</p>
            </div>
          ))}
        </div>
      )}

      {(has('posts') || has('connectors')) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {has('posts') && (
            <div className="rounded-xl border p-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-3">
                <BarChart2 className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                <h3 className="text-sm font-medium" style={{ color: 'var(--text)' }}>By platform</h3>
              </div>
              {platformStats.length === 0 ? (
                <p className="text-xs text-center py-3" style={{ color: 'var(--muted)' }}>No posts yet</p>
              ) : (
                <div className="space-y-3">
                  {platformStats.map(([platform, count]) => {
                    const pm = platformMeta(platform);
                    const pct = Math.round((count / maxCount) * 100);
                    return (
                      <div key={platform} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium" style={{ color: 'var(--text)' }}>{pm.label}</span>
                          <span style={{ color: 'var(--muted)' }}>{count}</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: pm.bar }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {has('connectors') && (
            <div className="rounded-xl border p-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Link2 className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                <h3 className="text-sm font-medium" style={{ color: 'var(--text)' }}>Connections</h3>
                <button onClick={() => navigate('/connectors')} className="ml-auto hover:opacity-70 transition-opacity" style={{ color: 'var(--accent)' }}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
              {connectors.length === 0 ? (
                <button onClick={() => navigate('/connectors')}
                  className="w-full text-xs flex items-center gap-1.5 py-2 hover:opacity-70 transition-opacity" style={{ color: 'var(--accent)' }}>
                  <Zap className="w-3 h-3" /> Connect a platform
                </button>
              ) : (
                <div className="space-y-1.5">
                  {connectors.map((c: any, i: number) => {
                    const pm = platformMeta(c.type ?? c.name ?? '');
                    return (
                      <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pm.bar }} />
                        <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{c.name ?? pm.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
