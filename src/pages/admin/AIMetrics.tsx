import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import {
  DollarSign,
  Activity,
  TrendingUp,
  PiggyBank,
  Cpu,
  Database,
  AlertTriangle,
  ArrowUpRight,
} from 'lucide-react';

type Tier = 'micro' | 'fix' | 'edit' | 'feature' | 'build';

const TIERS: Tier[] = ['micro', 'fix', 'edit', 'feature', 'build'];

const TIER_STYLES: Record<Tier, { dot: string; pill: string }> = {
  micro: { dot: 'bg-emerald-400', pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
  fix: { dot: 'bg-blue-400', pill: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  edit: { dot: 'bg-indigo-400', pill: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20' },
  feature: { dot: 'bg-violet-400', pill: 'bg-violet-500/10 text-violet-300 border-violet-500/20' },
  build: { dot: 'bg-orange-400', pill: 'bg-orange-500/10 text-orange-300 border-orange-500/20' },
};

const BASELINE_COST_PER_RUN = 0.65;
const TOKEN_CAP_WARN = 180000;

interface AgentRun {
  id: string;
  project_id: string | null;
  status: string | null;
  created_at: string | null;
  steps_taken: number | null;
  tokens_used: number | null;
  request_tier: string | null;
  model_used: string | null;
  estimated_cost_usd: number | null;
}

interface TierRow {
  tier: Tier;
  runs: number;
  avgTokens: number;
  avgCost: number;
  pct: number;
}

interface ModelRow {
  model: string;
  runs: number;
  totalCost: number;
}

interface KbStats {
  available: boolean;
  totalFiles: number;
  totalProjects: number;
  lastIndexed: string | null;
}

function fmtMoney(n: number, digits = 2): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function calcTrend(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+100%' : '0%';
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return ' ';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function StatCard({
  title,
  value,
  sub,
  trend,
  icon: Icon,
  iconColor,
}: {
  title: string;
  value: string;
  sub?: string;
  trend?: string;
  icon: React.ElementType;
  iconColor: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-white/45 uppercase tracking-wider">{title}</span>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <div className="flex items-end gap-3">
        <span className="text-3xl font-bold text-white/85">{value}</span>
        {trend && (
          <span
            className={`flex items-center gap-0.5 text-xs font-medium mb-1 ${
              trend.startsWith('-') ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            <ArrowUpRight className={`h-3 w-3 ${trend.startsWith('-') ? 'rotate-180' : ''}`} />
            {trend}
          </span>
        )}
      </div>
      {sub && <p className="text-xs text-white/45 mt-1">{sub}</p>}
    </div>
  );
}

function TierPill({ tier }: { tier: Tier }) {
  const style = TIER_STYLES[tier] ?? TIER_STYLES.edit;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${style.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {tier}
    </span>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/[0.04] ${className}`} />;
}

export default function AdminAIMetrics() {
  const [loading, setLoading] = useState(true);
  const [monthCost, setMonthCost] = useState(0);
  const [monthRuns, setMonthRuns] = useState(0);
  const [costTrend, setCostTrend] = useState('…');
  const [runsTrend, setRunsTrend] = useState('…');
  const [savings, setSavings] = useState(0);
  const [tierRows, setTierRows] = useState<TierRow[]>([]);
  const [modelRows, setModelRows] = useState<ModelRow[]>([]);
  const [recent, setRecent] = useState<AgentRun[]>([]);
  const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map());
  const [capHits, setCapHits] = useState(0);
  const [kb, setKb] = useState<KbStats>({ available: true, totalFiles: 0, totalProjects: 0, lastIndexed: null });

  useEffect(() => {
    loadMetrics();
    loadRecent();
    loadKbStats();
  }, []);

  const loadMetrics = async () => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

      const [thisRes, lastRes, capRes] = await Promise.all([
        supabase
          .from('agent_runs')
          .select('id, request_tier, model_used, estimated_cost_usd, tokens_used')
          .eq('status', 'completed')
          .gte('created_at', startOfMonth),
        supabase
          .from('agent_runs')
          .select('id, estimated_cost_usd')
          .eq('status', 'completed')
          .gte('created_at', startOfLastMonth)
          .lte('created_at', endOfLastMonth),
        supabase
          .from('agent_runs')
          .select('id', { count: 'exact', head: true })
          .gt('tokens_used', TOKEN_CAP_WARN),
      ]);

      const thisRows = (thisRes.data ?? []) as AgentRun[];
      const lastRows = (lastRes.data ?? []) as { estimated_cost_usd: number | null }[];

      const totalCost = thisRows.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0);
      const totalRuns = thisRows.length;
      const lastCost = lastRows.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0);
      const lastRuns = lastRows.length;

      setMonthCost(totalCost);
      setMonthRuns(totalRuns);
      setCostTrend(calcTrend(totalCost, lastCost));
      setRunsTrend(calcTrend(totalRuns, lastRuns));
      setSavings(Math.max(0, totalRuns * BASELINE_COST_PER_RUN - totalCost));
      setCapHits(capRes.count ?? 0);

      // Tier distribution
      const tierMap = new Map<Tier, { runs: number; tokens: number; cost: number }>();
      for (const r of thisRows) {
        const t = (r.request_tier ?? 'edit') as Tier;
        const key = TIERS.includes(t) ? t : ('edit' as Tier);
        const agg = tierMap.get(key) ?? { runs: 0, tokens: 0, cost: 0 };
        agg.runs += 1;
        agg.tokens += r.tokens_used ?? 0;
        agg.cost += r.estimated_cost_usd ?? 0;
        tierMap.set(key, agg);
      }
      setTierRows(
        TIERS.map((tier) => {
          const agg = tierMap.get(tier) ?? { runs: 0, tokens: 0, cost: 0 };
          return {
            tier,
            runs: agg.runs,
            avgTokens: agg.runs ? Math.round(agg.tokens / agg.runs) : 0,
            avgCost: agg.runs ? agg.cost / agg.runs : 0,
            pct: totalRuns ? Math.round((agg.runs / totalRuns) * 100) : 0,
          };
        }),
      );

      // Model usage
      const modelMap = new Map<string, { runs: number; cost: number }>();
      for (const r of thisRows) {
        const m = r.model_used ?? 'unknown';
        const agg = modelMap.get(m) ?? { runs: 0, cost: 0 };
        agg.runs += 1;
        agg.cost += r.estimated_cost_usd ?? 0;
        modelMap.set(m, agg);
      }
      setModelRows(
        Array.from(modelMap.entries())
          .map(([model, agg]) => ({ model, runs: agg.runs, totalCost: agg.cost }))
          .sort((a, b) => b.runs - a.runs),
      );
    } catch (e) {
      console.error('Failed to load AI metrics:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadRecent = async () => {
    try {
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id, project_id, status, created_at, steps_taken, tokens_used, request_tier, model_used, estimated_cost_usd')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;

      const rows = (data ?? []) as AgentRun[];
      setRecent(rows);

      const projectIds = Array.from(new Set(rows.map((r) => r.project_id).filter(Boolean))) as string[];
      if (projectIds.length) {
        const { data: projects } = await supabase.from('projects').select('id, name').in('id', projectIds);
        setProjectNames(new Map((projects ?? []).map((p: any) => [p.id, p.name])));
      }
    } catch (e) {
      console.error('Failed to load recent runs:', e);
    }
  };

  const loadKbStats = async () => {
    try {
      const { data, error } = await supabase
        .from('project_file_embeddings')
        .select('project_id, updated_at')
        .order('updated_at', { ascending: false })
        .limit(5000);
      if (error) throw error;

      const rows = (data ?? []) as { project_id: string | null; updated_at: string | null }[];
      const projects = new Set(rows.map((r) => r.project_id).filter(Boolean));
      setKb({
        available: true,
        totalFiles: rows.length,
        totalProjects: projects.size,
        lastIndexed: rows[0]?.updated_at ?? null,
      });
    } catch {
      setKb({ available: false, totalFiles: 0, totalProjects: 0, lastIndexed: null });
    }
  };

  const avgCostPerRun = monthRuns ? monthCost / monthRuns : 0;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="This Month Cost" value={fmtMoney(monthCost)} trend={costTrend} icon={DollarSign} iconColor="text-emerald-400" />
        <StatCard title="Total Runs" value={monthRuns.toLocaleString()} trend={runsTrend} icon={Activity} iconColor="text-blue-400" />
        <StatCard title="Avg Cost / Run" value={fmtMoney(avgCostPerRun, 4)} icon={TrendingUp} iconColor="text-violet-400" />
        <StatCard
          title="Token Savings"
          value={fmtMoney(savings)}
          sub="vs $0.65/run baseline"
          icon={PiggyBank}
          iconColor="text-amber-400"
        />
      </div>

      {/* Token cap warning */}
      {capHits > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-300">
              {capHits} run{capHits === 1 ? '' : 's'} near the 200K token cap
            </p>
            <p className="text-xs text-white/45">Runs exceeding {TOKEN_CAP_WARN.toLocaleString()} tokens may be truncated. Consider tighter scoping.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tier distribution */}
        <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] p-5">
          <h3 className="text-sm font-semibold text-white/85 mb-4">Tier Distribution (this month)</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-white/45 text-left">
                <th className="pb-2 font-medium">Tier</th>
                <th className="pb-2 font-medium text-right">Runs</th>
                <th className="pb-2 font-medium text-right">Avg Tokens</th>
                <th className="pb-2 font-medium text-right">Avg Cost</th>
                <th className="pb-2 font-medium text-right">% Total</th>
              </tr>
            </thead>
            <tbody>
              {tierRows.map((row) => (
                <tr key={row.tier} className="border-t border-white/[0.04]">
                  <td className="py-2.5">
                    <TierPill tier={row.tier} />
                  </td>
                  <td className="py-2.5 text-right text-white/85">{row.runs.toLocaleString()}</td>
                  <td className="py-2.5 text-right text-white/60">{row.avgTokens.toLocaleString()}</td>
                  <td className="py-2.5 text-right text-white/60">{fmtMoney(row.avgCost, 4)}</td>
                  <td className="py-2.5 text-right text-white/60">{row.pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Model usage */}
        <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] p-5">
          <h3 className="text-sm font-semibold text-white/85 mb-4 flex items-center gap-2">
            <Cpu className="h-4 w-4 text-white/45" />
            Model Usage (this month)
          </h3>
          {modelRows.length === 0 ? (
            <p className="text-sm text-white/45 text-center py-8">No model data yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-white/45 text-left">
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium text-right">Runs</th>
                  <th className="pb-2 font-medium text-right">Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map((row) => (
                  <tr key={row.model} className="border-t border-white/[0.04]">
                    <td className="py-2.5 text-white/85 font-mono text-xs">{row.model}</td>
                    <td className="py-2.5 text-right text-white/60">{row.runs.toLocaleString()}</td>
                    <td className="py-2.5 text-right text-white/60">{fmtMoney(row.totalCost, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* KB index stats */}
      <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] p-5">
        <h3 className="text-sm font-semibold text-white/85 mb-4 flex items-center gap-2">
          <Database className="h-4 w-4 text-white/45" />
          Knowledge Base Index
        </h3>
        {!kb.available ? (
          <div className="text-sm text-white/45">
            <p className="text-white/60 font-medium">Not yet indexed</p>
            <p className="mt-1">
              The <span className="font-mono text-xs">project_file_embeddings</span> table is unavailable. Run the migration to enable KB indexing.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-2xl font-bold text-white/85">{kb.totalFiles.toLocaleString()}</p>
              <p className="text-xs text-white/45 mt-0.5">Indexed files</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white/85">{kb.totalProjects.toLocaleString()}</p>
              <p className="text-xs text-white/45 mt-0.5">Projects with KB</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white/85">{timeAgo(kb.lastIndexed)}</p>
              <p className="text-xs text-white/45 mt-0.5">Last indexed</p>
            </div>
          </div>
        )}
      </div>

      {/* Recent runs */}
      <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] p-5">
        <h3 className="text-sm font-semibold text-white/85 mb-4">Recent Runs</h3>
        {recent.length === 0 ? (
          <p className="text-sm text-white/45 text-center py-8">No runs yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-white/45 text-left">
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Project</th>
                  <th className="pb-2 font-medium">Tier</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium text-right">Tokens</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                  <th className="pb-2 font-medium text-right">Steps</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((run) => {
                  const tier = (run.request_tier ?? '') as Tier;
                  const projectLabel =
                    (run.project_id && projectNames.get(run.project_id)) ||
                    (run.project_id ? `${run.project_id.slice(0, 8)}…` : ' ');
                  return (
                    <tr key={run.id} className="border-t border-white/[0.04]">
                      <td className="py-2.5 text-white/45 whitespace-nowrap">{timeAgo(run.created_at)}</td>
                      <td className="py-2.5 text-white/85 max-w-[140px] truncate" title={projectLabel}>
                        {projectLabel}
                      </td>
                      <td className="py-2.5">{TIERS.includes(tier) ? <TierPill tier={tier} /> : <span className="text-white/30"> </span>}</td>
                      <td className="py-2.5 text-white/60 font-mono text-xs">{run.model_used ?? ' '}</td>
                      <td className="py-2.5 text-right text-white/60">{(run.tokens_used ?? 0).toLocaleString()}</td>
                      <td className="py-2.5 text-right text-white/60">{fmtMoney(run.estimated_cost_usd ?? 0, 4)}</td>
                      <td className="py-2.5 text-right text-white/60">{run.steps_taken ?? 0}</td>
                      <td className="py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-xs text-white/60">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              run.status === 'completed'
                                ? 'bg-emerald-400'
                                : run.status === 'failed'
                                  ? 'bg-red-400'
                                  : 'bg-yellow-400 animate-pulse'
                            }`}
                          />
                          {run.status ?? 'unknown'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
