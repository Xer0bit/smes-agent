import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Activity, DollarSign, Cpu, FolderKanban } from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(n: number, d = 2) { return `$${n.toFixed(d)}`; }
function fmtNum(n: number) { return n.toLocaleString(); }

function shortModel(m: string): string {
  if (!m) return '—';
  if (m.includes('gemini-2.5-pro')) return 'Gemini 2.5 Pro';
  if (m.includes('gemini-2.5-flash') || m.includes('gemini-flash-latest')) return 'Gemini Flash';
  if (m.includes('gemini')) return 'Gemini';
  if (m.includes('deepseek')) return 'DeepSeek';
  if (m.includes('claude')) return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '');
  return m;
}

function modelColor(m: string): string {
  if (m.includes('claude')) return 'bg-violet-500/15 text-violet-300 border border-violet-500/25';
  if (m.includes('gemini')) return 'bg-blue-500/15 text-blue-300 border border-blue-500/25';
  if (m.includes('deepseek')) return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25';
  return 'bg-white/10 text-white/60 border border-white/20';
}

function getStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface Run {
  id: string;
  project_id: string | null;
  tokens_used: number | null;
  estimated_cost_usd: number | null;
  model_used: string | null;
  created_at: string | null;
}

interface Project { id: string; name: string; organization_id: string | null; }
interface Org     { id: string; name: string; }

interface OrgRow {
  id: string; name: string;
  runs: number; tokens: number; cost: number; avgCost: number; pct: number;
}

interface ProjectRow {
  id: string; name: string; orgName: string;
  runs: number; tokens: number; cost: number; avgCost: number; topModel: string;
}

interface ModelRow {
  model: string;
  runs: number; tokens: number; cost: number;
  runPct: number; costPct: number;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Skeleton({ h = 'h-24' }: { h?: string }) {
  return <div className={`animate-pulse rounded-xl bg-white/[0.04] ${h}`} />;
}

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: string; icon: React.ElementType; color: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] p-5 flex items-center gap-4">
      <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wider text-white/45 mb-0.5">{label}</p>
        <p className="text-2xl font-bold text-white/85">{value}</p>
      </div>
    </div>
  );
}

function Bar({ pct, color = 'bg-purple-500/60' }: { pct: number; color?: string }) {
  return (
    <div className="h-1 w-full rounded-full bg-white/[0.06] mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function buildOrgRows(runs: Run[], projMap: Map<string, Project>, orgMap: Map<string, Org>): OrgRow[] {
  const m = new Map<string, { runs: number; tokens: number; cost: number }>();
  for (const r of runs) {
    const proj = r.project_id ? projMap.get(r.project_id) : null;
    const orgId = proj?.organization_id ?? '__none__';
    const agg = m.get(orgId) ?? { runs: 0, tokens: 0, cost: 0 };
    agg.runs += 1;
    agg.tokens += r.tokens_used ?? 0;
    agg.cost += Number(r.estimated_cost_usd ?? 0);
    m.set(orgId, agg);
  }
  const total = Array.from(m.values()).reduce((s, a) => s + a.cost, 0);
  return Array.from(m.entries())
    .map(([id, agg]) => ({
      id,
      name: id === '__none__' ? '(No org)' : (orgMap.get(id)?.name ?? id.slice(0, 8) + '…'),
      runs: agg.runs,
      tokens: agg.tokens,
      cost: agg.cost,
      avgCost: agg.runs ? agg.cost / agg.runs : 0,
      pct: total ? (agg.cost / total) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

function buildProjectRows(runs: Run[], projMap: Map<string, Project>, orgMap: Map<string, Org>): ProjectRow[] {
  const m = new Map<string, { runs: number; tokens: number; cost: number; models: Map<string, number> }>();
  for (const r of runs) {
    const pid = r.project_id ?? '__none__';
    const agg = m.get(pid) ?? { runs: 0, tokens: 0, cost: 0, models: new Map() };
    agg.runs += 1;
    agg.tokens += r.tokens_used ?? 0;
    agg.cost += Number(r.estimated_cost_usd ?? 0);
    const mod = r.model_used ?? 'unknown';
    agg.models.set(mod, (agg.models.get(mod) ?? 0) + 1);
    m.set(pid, agg);
  }
  return Array.from(m.entries())
    .map(([pid, agg]) => {
      const proj = projMap.get(pid);
      const orgName = proj?.organization_id ? (orgMap.get(proj.organization_id)?.name ?? '—') : '—';
      const topModel = Array.from(agg.models.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      return {
        id: pid,
        name: proj?.name ?? pid.slice(0, 8) + '…',
        orgName,
        runs: agg.runs,
        tokens: agg.tokens,
        cost: agg.cost,
        avgCost: agg.runs ? agg.cost / agg.runs : 0,
        topModel,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

function buildModelRows(runs: Run[]): ModelRow[] {
  const m = new Map<string, { runs: number; tokens: number; cost: number }>();
  for (const r of runs) {
    const mod = r.model_used ?? 'unknown';
    const agg = m.get(mod) ?? { runs: 0, tokens: 0, cost: 0 };
    agg.runs += 1;
    agg.tokens += r.tokens_used ?? 0;
    agg.cost += Number(r.estimated_cost_usd ?? 0);
    m.set(mod, agg);
  }
  const totalRuns = runs.length;
  const totalCost = Array.from(m.values()).reduce((s, a) => s + a.cost, 0);
  return Array.from(m.entries())
    .map(([model, agg]) => ({
      model,
      runs: agg.runs,
      tokens: agg.tokens,
      cost: agg.cost,
      runPct: totalRuns ? (agg.runs / totalRuns) * 100 : 0,
      costPct: totalCost ? (agg.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

// ── Main Component ────────────────────────────────────────────────────────────

const DATE_OPTS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

type TabId = 'org' | 'project' | 'model';

export default function AdminUsage() {
  const [days, setDays]         = useState(30);
  const [tab, setTab]           = useState<TabId>('org');
  const [loading, setLoading]   = useState(true);
  const [runs, setRuns]         = useState<Run[]>([]);
  const [projMap, setProjMap]   = useState<Map<string, Project>>(new Map());
  const [orgMap, setOrgMap]     = useState<Map<string, Org>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since = getStart(days);
      const { data: runData, error } = await supabase
        .from('agent_runs')
        .select('id, project_id, tokens_used, estimated_cost_usd, model_used, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false });

      if (error) throw error;
      const rows = (runData ?? []) as Run[];
      setRuns(rows);

      const pids = Array.from(new Set(rows.map(r => r.project_id).filter(Boolean))) as string[];
      if (pids.length) {
        const { data: projs } = await supabase.from('projects').select('id, name, organization_id').in('id', pids);
        const pm = new Map((projs ?? []).map((p: Project) => [p.id, p]));
        setProjMap(pm);

        const oids = Array.from(new Set((projs ?? []).map((p: Project) => p.organization_id).filter(Boolean))) as string[];
        if (oids.length) {
          const { data: orgs } = await supabase.from('organizations').select('id, name').in('id', oids);
          setOrgMap(new Map((orgs ?? []).map((o: Org) => [o.id, o])));
        }
      }
    } catch (e) {
      console.error('[AdminUsage] load error', e);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const totalCost   = runs.reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0);
  const totalTokens = runs.reduce((s, r) => s + (r.tokens_used ?? 0), 0);
  const uniqueProjs = new Set(runs.map(r => r.project_id).filter(Boolean)).size;

  const orgRows   = buildOrgRows(runs, projMap, orgMap);
  const projRows  = buildProjectRows(runs, projMap, orgMap);
  const modelRows = buildModelRows(runs);

  const maxOrgCost = orgRows[0]?.cost ?? 1;

  // ── Render ──────────────────────────────────────────────────────────────────
  const thCls = 'pb-2 font-medium text-[11px] uppercase tracking-wider text-white/45';

  return (
    <div className="space-y-6">

      {/* Date filter */}
      <div className="flex items-center gap-2">
        {DATE_OPTS.map(o => (
          <button
            key={o.days}
            onClick={() => setDays(o.days)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              days === o.days
                ? 'bg-white/[0.06] text-white border border-white/[0.10]'
                : 'text-white/45 hover:text-white/70 border border-transparent'
            }`}
          >
            {o.label}
          </button>
        ))}
        <span className="text-[11px] text-white/25 ml-1">period</span>
      </div>

      {/* Stat cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0,1,2,3].map(i => <Skeleton key={i} h="h-24" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total Runs"       value={fmtNum(runs.length)}     icon={Activity}      color="bg-purple-500/10 text-purple-400" />
          <StatCard label="Total Cost"       value={fmtMoney(totalCost, 4)}  icon={DollarSign}    color="bg-emerald-500/10 text-emerald-400" />
          <StatCard label="Total Tokens"     value={fmtNum(totalTokens)}     icon={Cpu}           color="bg-blue-500/10 text-blue-400" />
          <StatCard label="Unique Projects"  value={fmtNum(uniqueProjs)}     icon={FolderKanban}  color="bg-amber-500/10 text-amber-400" />
        </div>
      )}

      {/* Tabs */}
      <div className="rounded-xl border border-white/[0.06] bg-[#0d0f14] overflow-hidden">
        {/* Tab bar */}
        <div className="flex gap-1 p-3 border-b border-white/[0.06]">
          {([['org','By Organization'],['project','By Project'],['model','By Model']] as [TabId, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                tab === id
                  ? 'bg-white/[0.06] text-white border border-white/[0.10]'
                  : 'text-white/45 hover:text-white/70 border border-transparent'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-5 overflow-x-auto">
          {loading ? (
            <div className="space-y-2">
              {[0,1,2,3,4].map(i => <Skeleton key={i} h="h-9" />)}
            </div>
          ) : (
            <>
              {/* ── By Organization ── */}
              {tab === 'org' && (
                orgRows.length === 0
                  ? <p className="text-sm text-white/35 text-center py-10">No data for this period</p>
                  : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left">
                          <th className={thCls}>Organization</th>
                          <th className={`${thCls} text-right`}>Runs</th>
                          <th className={`${thCls} text-right`}>Tokens</th>
                          <th className={`${thCls} text-right`}>Cost</th>
                          <th className={`${thCls} text-right`}>Avg / Run</th>
                          <th className={`${thCls} text-right`}>% Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orgRows.map(row => (
                          <tr key={row.id} className="border-t border-white/[0.04]">
                            <td className="py-3 text-white/85 font-medium">{row.name}</td>
                            <td className="py-3 text-right text-white/60">{fmtNum(row.runs)}</td>
                            <td className="py-3 text-right text-white/60">{fmtNum(row.tokens)}</td>
                            <td className="py-3 text-right min-w-[120px]">
                              <span className="text-white/85">{fmtMoney(row.cost, 4)}</span>
                              <div className="w-24 ml-auto">
                                <Bar pct={(row.cost / maxOrgCost) * 100} />
                              </div>
                            </td>
                            <td className="py-3 text-right text-white/60">{fmtMoney(row.avgCost, 4)}</td>
                            <td className="py-3 text-right text-white/45">{row.pct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
              )}

              {/* ── By Project ── */}
              {tab === 'project' && (
                projRows.length === 0
                  ? <p className="text-sm text-white/35 text-center py-10">No data for this period</p>
                  : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left">
                          <th className={thCls}>Project</th>
                          <th className={thCls}>Organization</th>
                          <th className={`${thCls} text-right`}>Runs</th>
                          <th className={`${thCls} text-right`}>Tokens</th>
                          <th className={`${thCls} text-right`}>Cost</th>
                          <th className={`${thCls} text-right`}>Avg / Run</th>
                          <th className={thCls}>Top Model</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projRows.map(row => (
                          <tr key={row.id} className="border-t border-white/[0.04]">
                            <td className="py-3 text-white/85 font-medium max-w-[160px] truncate" title={row.name}>{row.name}</td>
                            <td className="py-3 text-white/45 text-xs">{row.orgName}</td>
                            <td className="py-3 text-right text-white/60">{fmtNum(row.runs)}</td>
                            <td className="py-3 text-right text-white/60">{fmtNum(row.tokens)}</td>
                            <td className="py-3 text-right text-white/85">{fmtMoney(row.cost, 4)}</td>
                            <td className="py-3 text-right text-white/60">{fmtMoney(row.avgCost, 4)}</td>
                            <td className="py-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${modelColor(row.topModel)}`}>
                                {shortModel(row.topModel)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
              )}

              {/* ── By Model ── */}
              {tab === 'model' && (
                modelRows.length === 0
                  ? <p className="text-sm text-white/35 text-center py-10">No data for this period</p>
                  : (
                    <div className="space-y-4">
                      {modelRows.map(row => (
                        <div key={row.model} className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-4">
                          <div className="flex items-center justify-between mb-3">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${modelColor(row.model)}`}>
                              {shortModel(row.model)}
                            </span>
                            <span className="text-xs text-white/40 font-mono">{row.model}</span>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
                            <div>
                              <p className="text-[11px] text-white/40 uppercase tracking-wider mb-0.5">Runs</p>
                              <p className="text-lg font-bold text-white/85">{fmtNum(row.runs)}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-white/40 uppercase tracking-wider mb-0.5">Tokens</p>
                              <p className="text-lg font-bold text-white/85">{fmtNum(row.tokens)}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-white/40 uppercase tracking-wider mb-0.5">Total Cost</p>
                              <p className="text-lg font-bold text-white/85">{fmtMoney(row.cost, 4)}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-white/40 uppercase tracking-wider mb-0.5">Avg / Run</p>
                              <p className="text-lg font-bold text-white/85">{fmtMoney(row.runs ? row.cost / row.runs : 0, 4)}</p>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <div>
                              <div className="flex justify-between text-[11px] text-white/40 mb-0.5">
                                <span>% of runs</span><span>{row.runPct.toFixed(1)}%</span>
                              </div>
                              <Bar pct={row.runPct} color="bg-indigo-500/50" />
                            </div>
                            <div>
                              <div className="flex justify-between text-[11px] text-white/40 mb-0.5">
                                <span>% of cost</span><span>{row.costPct.toFixed(1)}%</span>
                              </div>
                              <Bar pct={row.costPct} color="bg-purple-500/60" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
