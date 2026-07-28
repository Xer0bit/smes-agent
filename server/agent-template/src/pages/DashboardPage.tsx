import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Zap, Loader2, CheckCircle2, Link2, ChevronRight, FileText, TrendingUp, TrendingDown,
  Activity, CircleDollarSign,
} from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import { Card, relTime, platformMeta, StatCard, SectionHeader, ProgressRing } from '../components/ui';
import { statusLabel } from '../components/StatusBadge';

// Pipeline statuses are semantic, not series colors (dataviz: status palette
// is reserved). Values come straight from the DB status column.
const STATUS_COLORS: Record<string, string> = {
  posted: '#16a34a', scheduled: '#0ea5c9', posting: '#0ea5c9',
  draft: '#94a3b8', failed: '#dc2626', cancelled: '#64748b',
};

const has = (m: string) => ECG.modules.includes(m);

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

interface Stats {
  platforms: Array<{ platform: string; posted30d: number; previous30d: number; total: number }>;
  daily: Array<{ platform: string; day: string; count: number }>;
  statusBreakdown: Record<string, number>;
  runs30d: { success: number; failed: number; cost: number };
}

// ── Tiny SVG helpers (no chart library) ──────────────────────────────────────

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2 || values.every(v => v === 0)) return null;
  const w = 96, h = 28, max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} className="block" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Trend({ now, prev }: { now: number; prev: number }) {
  if (prev === 0 && now === 0) return null;
  const up = now >= prev;
  const pct = prev === 0 ? 100 : Math.round(((now - prev) / prev) * 100);
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium" style={{ color: up ? '#16a34a' : '#dc2626' }}>
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {pct > 0 ? '+' : ''}{pct}%
    </span>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      has('agents')     ? ecgApi.agents.list().then(d => Array.isArray(d) ? d : (d.agents ?? [])) : Promise.resolve([]),
      has('posts')      ? ecgApi.posts.list().then(d => Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? [])) : Promise.resolve([]),
      has('connectors') ? ecgApi.connectors.list().then(d => Array.isArray(d) ? d : (d.connectors ?? [])) : Promise.resolve([]),
      ecgApi.stats.get().catch(() => null),
    ])
      .then(([a, p, c, s]) => { setAgents(a); setPosts(p); setConnectors(c); setStats(s); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const pending = useMemo(() => posts.filter(p => p.status === 'draft'), [posts]);
  const upcoming = useMemo(() =>
    posts
      .filter(p => (p.scheduledAt ?? p.scheduled_at) && new Date(p.scheduledAt ?? p.scheduled_at) > new Date() && ['scheduled', 'posting'].includes(p.status))
      .sort((a, b) => new Date(a.scheduledAt ?? a.scheduled_at).getTime() - new Date(b.scheduledAt ?? b.scheduled_at).getTime())
      .slice(0, 4),
    [posts]);

  // Weekly publishing series for the top 2 platforms (90 days, 13 buckets)
  const chart = useMemo(() => {
    if (!stats?.daily?.length) return null;
    const top = [...(stats.platforms ?? [])].sort((a, b) => b.total - a.total).slice(0, 2).map(p => p.platform);
    if (top.length === 0) return null;
    const now = Date.now();
    const WEEKS = 13;
    const series = top.map(platform => {
      const buckets = Array(WEEKS).fill(0);
      for (const d of stats.daily) {
        if (d.platform !== platform) continue;
        const idx = WEEKS - 1 - Math.floor((now - new Date(d.day).getTime()) / (7 * 86_400_000));
        if (idx >= 0 && idx < WEEKS) buckets[idx] += d.count;
      }
      return { platform, buckets };
    });
    const max = Math.max(1, ...series.flatMap(s => s.buckets));
    return { series, max, weeks: WEEKS };
  }, [stats]);

  const publishedDaily = useMemo(() => {
    if (!stats?.daily?.length) return [];
    const map = new Map<string, number>();
    for (const d of stats.daily) map.set(d.day, (map.get(d.day) ?? 0) + d.count);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v).slice(-30);
  }, [stats]);

  const published30d = stats?.platforms?.reduce((n, p) => n + p.posted30d, 0) ?? 0;
  const previous30d  = stats?.platforms?.reduce((n, p) => n + p.previous30d, 0) ?? 0;
  const runs = stats?.runs30d ?? { success: 0, failed: 0, cost: 0 };
  const runTotal = runs.success + runs.failed;
  const successRate = runTotal > 0 ? Math.round((runs.success / runTotal) * 100) : null;

  const pipeline = useMemo(() => {
    const entries = Object.entries(stats?.statusBreakdown ?? {}).filter(([, n]) => n > 0);
    const total = entries.reduce((n, [, c]) => n + c, 0);
    if (total === 0) return null;
    let acc = 0;
    const segs = entries.map(([status, count]) => {
      const from = (acc / total) * 360; acc += count;
      return { status, count, from, to: (acc / total) * 360, color: STATUS_COLORS[status] ?? 'var(--muted)' };
    });
    return { segs, total };
  }, [stats]);

  const hasConnector = connectors.some((c: any) => (c.status ?? '').toLowerCase() === 'connected');
  const setupSteps = [
    ...(has('connectors') ? [{ done: hasConnector, title: 'Connect a platform', cta: hasConnector ? 'Manage' : 'Connect', path: '/connectors', Icon: Link2 }] : []),
    ...(has('agents')     ? [{ done: agents.length > 0, title: 'Create an agent', cta: agents.length ? 'View' : 'Create', path: '/agents', Icon: Zap }] : []),
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
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      {/* ── Greeting header ── */}
      <div className="flex items-end justify-between pb-1">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>{greeting()}</p>
          <h1 className="text-xl mt-0.5" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</h1>
        </div>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* ── Per-platform pills (published posts, 30d, real deltas) ── */}
      {(stats?.platforms?.length ?? 0) > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {stats!.platforms.map(p => {
            const pm = platformMeta(p.platform);
            return (
              <div key={p.platform} className="flex items-center gap-2 rounded-full border px-3.5 py-2 shrink-0"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: pm.bar }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{pm.label}</span>
                <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>{p.posted30d}</span>
                <Trend now={p.posted30d} prev={p.previous30d} />
              </div>
            );
          })}
        </div>
      )}

      {/* ── Setup checklist (until done) ── */}
      {setupSteps.length > 0 && !setupDone && (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Get started</p>
            <ProgressRing done={setupSteps.filter(s => s.done).length} total={setupSteps.length} />
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {setupSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3" style={step.done ? { opacity: 0.4 } : undefined}>
                <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--accent-bg)' }}>
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
        </Card>
      )}

      {/* ── Pending review banner ── */}
      {has('posts') && pending.length > 0 && (
        <button onClick={() => navigate('/posts')}
          className="w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-shadow hover:shadow-md"
          style={{ background: 'var(--accent-bg)', borderColor: 'var(--accent)' }}>
          <FileText className="w-4 h-4 shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="flex-1 text-sm" style={{ color: 'var(--text)' }}>
            <span style={{ fontWeight: 'var(--font-weight-heading)' }}>{pending.length} post{pending.length === 1 ? '' : 's'}</span> waiting for your review
          </span>
          <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--accent)' }} />
        </button>
      )}

      {/* ── KPI cards ── */}
      {ECG.showSummaryCards && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Published · 30d" value={published30d} Icon={TrendingUp} tone="accent"
            sub={<div className="flex items-center justify-between"><Trend now={published30d} prev={previous30d} /><Sparkline values={publishedDaily} color="var(--accent)" /></div>} />
          <StatCard label="Awaiting review" value={pending.length} Icon={FileText} tone={pending.length > 0 ? 'warning' : 'neutral'} />
          <StatCard label="Run success · 30d" value={successRate === null ? '—' : `${successRate}%`} Icon={Activity}
            tone={successRate === null ? 'neutral' : successRate >= 90 ? 'success' : successRate >= 60 ? 'warning' : 'neutral'}
            sub={runTotal > 0 && (
              <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                <div className="h-full rounded-full" style={{ width: `${successRate}%`, background: successRate! >= 90 ? '#16a34a' : successRate! >= 60 ? '#f59e0b' : '#dc2626' }} />
              </div>
            )} />
          <StatCard label="AI spend · 30d" value={`$${runs.cost.toFixed(2)}`} Icon={CircleDollarSign} tone="neutral" />
        </div>
      )}

      {/* ── Chart + right rail ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Publishing activity, weekly, top 2 platforms */}
        <Card className="p-5 lg:col-span-2">
          <SectionHeader title="Publishing activity" action={<span className="text-xs" style={{ color: 'var(--muted)' }}>last 90 days · weekly</span>} />
          {!chart ? (
            <p className="text-xs text-center py-10" style={{ color: 'var(--muted)' }}>
              No published posts yet. Activity appears here once posts go live.
            </p>
          ) : (
            <>
              <svg viewBox="0 0 560 180" className="w-full" role="img" aria-label="Posts published per week by platform">
                {[0, 0.5, 1].map(f => (
                  <g key={f}>
                    <line x1="30" x2="556" y1={10 + (1 - f) * 140} y2={10 + (1 - f) * 140} stroke="var(--border)" strokeWidth="1" />
                    <text x="24" y={14 + (1 - f) * 140} textAnchor="end" fontSize="9" fill="var(--muted)">{Math.round(chart.max * f)}</text>
                  </g>
                ))}
                {chart.series.map(s => {
                  const pm = platformMeta(s.platform);
                  const x = (i: number) => 30 + (i / (chart.weeks - 1)) * 526;
                  const y = (v: number) => 150 - (v / chart.max) * 140;
                  return (
                    <g key={s.platform}>
                      <polyline points={s.buckets.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                        fill="none" stroke={pm.bar} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                      {s.buckets.map((v, i) => v > 0 && (
                        <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={pm.bar}>
                          <title>{pm.label}: {v} post{v === 1 ? '' : 's'}</title>
                        </circle>
                      ))}
                    </g>
                  );
                })}
              </svg>
              <div className="flex items-center gap-4 mt-2">
                {chart.series.map(s => {
                  const pm = platformMeta(s.platform);
                  return (
                    <span key={s.platform} className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text)' }}>
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: pm.bar }} /> {pm.label}
                    </span>
                  );
                })}
              </div>
            </>
          )}
        </Card>

        {/* Right rail: schedule + pipeline */}
        <div className="space-y-4">
          <Card className="p-5">
            <SectionHeader title="Scheduled posts" action={has('posts') && (
              <button onClick={() => navigate('/posts/calendar')} className="hover:opacity-70" style={{ color: 'var(--accent)' }}>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )} />
            {upcoming.length === 0 ? (
              <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>Nothing scheduled. Approved posts with a future time show up here.</p>
            ) : (
              <div className="space-y-2">
                {upcoming.map((p: any) => {
                  const pm = platformMeta(p.platform ?? '');
                  const at = p.scheduledAt ?? p.scheduled_at;
                  return (
                    <div key={p.id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                      <span className="w-1.5 h-6 rounded-full shrink-0" style={{ background: pm.bar }} />
                      <p className="flex-1 min-w-0 text-xs truncate" style={{ color: 'var(--text)' }}>{p.content ?? '(no content)'}</p>
                      <span className="text-[10px] shrink-0 tabular-nums" style={{ color: 'var(--muted)' }} title={new Date(at).toLocaleString()}>
                        {relTime(at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <SectionHeader title="Post pipeline" />
            {!pipeline ? (
              <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>No posts yet.</p>
            ) : (
              <div className="flex items-center gap-4">
                <div className="relative w-20 h-20 shrink-0 rounded-full" style={{
                  background: `conic-gradient(${pipeline.segs.map(s => `${s.color} ${s.from}deg ${s.to}deg`).join(', ')})`,
                }}>
                  <div className="absolute inset-[22%] rounded-full flex items-center justify-center" style={{ background: 'var(--card-bg)' }}>
                    <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>{pipeline.total}</span>
                  </div>
                </div>
                <div className="space-y-1 min-w-0">
                  {pipeline.segs.map(s => (
                    <p key={s.status} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text)' }}>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                      <span>{statusLabel(s.status)}</span>
                      <span style={{ color: 'var(--muted)' }}>{s.count}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
