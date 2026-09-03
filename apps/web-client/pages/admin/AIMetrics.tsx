import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { getGenServerUrl } from '@/config/external-api';
import { toast } from 'sonner';
import { Page, Stats, Panel, Table, Dot, Tag, ago } from '@/components/admin/ui';

type Tier = 'micro' | 'fix' | 'edit' | 'feature' | 'build';
const TIERS: Tier[] = ['micro', 'fix', 'edit', 'feature', 'build'];
const TOKEN_CAP_WARN = 180000;

interface AgentRun {
  id: string; project_id: string | null; status: string | null; created_at: string | null;
  steps_taken: number | null; tokens_used: number | null; request_tier: string | null; model_used: string | null;
  estimated_cost_usd: number | null; input_tokens?: number | null; output_tokens?: number | null;
  cache_read_tokens?: number | null; narration_cost_usd?: number | null; error_message?: string | null;
}
interface ProviderHealthRow { provider: string; ok: boolean; testedAt: string; }
interface ProjectSpendRow { projectId: string; cost: number; runs: number; }
interface TierRow { tier: Tier; runs: number; avgTokens: number; avgCost: number; pct: number; }
interface ModelRow { model: string; runs: number; totalCost: number; }
interface KbStats { available: boolean; totalFiles: number; totalProjects: number; lastIndexed: string | null; }
interface ProjectName { id: string; name: string; }

function fmtMoney(n: number, digits = 2): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function calcTrend(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+100%' : '0%';
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}
function isTier(t: string | null): t is Tier { return TIERS.includes((t ?? '') as Tier); }

export default function AdminAIMetrics() {
  const [loading, setLoading] = useState(true);
  const [monthCost, setMonthCost] = useState(0);
  const [monthRuns, setMonthRuns] = useState(0);
  const [costTrend, setCostTrend] = useState('…');
  const [runsTrend, setRunsTrend] = useState('…');
  const [tierRows, setTierRows] = useState<TierRow[]>([]);
  const [modelRows, setModelRows] = useState<ModelRow[]>([]);
  const [recent, setRecent] = useState<AgentRun[]>([]);
  const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map());
  const [capHits, setCapHits] = useState(0);
  const [kb, setKb] = useState<KbStats>({ available: true, totalFiles: 0, totalProjects: 0, lastIndexed: null });
  const [cacheHitRate, setCacheHitRate] = useState(0);
  const [abortRate, setAbortRate] = useState(0);
  const [failedRuns, setFailedRuns] = useState<AgentRun[]>([]);
  const [topProjects, setTopProjects] = useState<ProjectSpendRow[]>([]);
  const [providerHealth, setProviderHealth] = useState<ProviderHealthRow[] | null>(null);
  const [healthError, setHealthError] = useState(false);

  const addProjectNames = async (ids: string[]) => {
    if (!ids.length) return;
    const { data } = await supabase.from('projects').select('id, name').in('id', ids);
    setProjectNames((prev) => {
      const next = new Map(prev);
      for (const p of (data ?? []) as ProjectName[]) next.set(p.id, p.name);
      return next;
    });
  };
  const projectLabel = (id: string | null) => (id ? projectNames.get(id) ?? `${id.slice(0, 8)}…` : ' ');

  useEffect(() => {
    const loadProviderHealth = async () => {
      try {
        const res = await fetch(getGenServerUrl('/api/v1/ai/health'));
        if (!res.ok) throw new Error(String(res.status));
        const data: { providers?: ProviderHealthRow[] } = await res.json();
        setProviderHealth(data.providers ?? []);
      } catch { setHealthError(true); }
    };

    const loadMetrics = async () => {
      try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();
        // is_internal excluded: dogfooding traffic must not pollute these numbers.
        const [thisRes, lastRes, capRes, allStatusRes] = await Promise.all([
          supabase.from('agent_runs')
            .select('id, request_tier, model_used, estimated_cost_usd, tokens_used, input_tokens, output_tokens, cache_read_tokens, narration_cost_usd, project_id')
            .eq('status', 'completed').eq('is_internal', false).gte('created_at', startOfMonth),
          supabase.from('agent_runs').select('id, estimated_cost_usd')
            .eq('status', 'completed').eq('is_internal', false).gte('created_at', startOfLastMonth).lte('created_at', endOfLastMonth),
          supabase.from('agent_runs').select('id', { count: 'exact', head: true }).eq('is_internal', false).gt('tokens_used', TOKEN_CAP_WARN),
          supabase.from('agent_runs').select('id, status').eq('is_internal', false).gte('created_at', startOfMonth),
        ]);
        const thisRows = (thisRes.data ?? []) as AgentRun[];
        const lastRows = (lastRes.data ?? []) as { estimated_cost_usd: number | null }[];
        const allStatusRows = (allStatusRes.data ?? []) as { id: string; status: string | null }[];

        const cacheReadSum = thisRows.reduce((s, r) => s + (r.cache_read_tokens ?? 0), 0);
        const inputSum = thisRows.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
        setCacheHitRate(cacheReadSum + inputSum > 0 ? (cacheReadSum / (cacheReadSum + inputSum)) * 100 : 0);
        setAbortRate(allStatusRows.length ? (allStatusRows.filter((r) => r.status === 'failed').length / allStatusRows.length) * 100 : 0);

        const projSpend = new Map<string, ProjectSpendRow>();
        for (const r of thisRows) {
          if (!r.project_id) continue;
          const row = projSpend.get(r.project_id) ?? { projectId: r.project_id, cost: 0, runs: 0 };
          row.cost += (r.estimated_cost_usd ?? 0) + (r.narration_cost_usd ?? 0);
          row.runs += 1;
          projSpend.set(r.project_id, row);
        }
        const topSpendRows = Array.from(projSpend.values()).sort((a, b) => b.cost - a.cost).slice(0, 8);
        setTopProjects(topSpendRows);
        await addProjectNames(topSpendRows.map((p) => p.projectId));

        const totalCost = thisRows.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0);
        const totalRuns = thisRows.length;
        setMonthCost(totalCost); setMonthRuns(totalRuns);
        setCostTrend(calcTrend(totalCost, lastRows.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0)));
        setRunsTrend(calcTrend(totalRuns, lastRows.length));
        setCapHits(capRes.count ?? 0);

        const tierMap = new Map<Tier, { runs: number; tokens: number; cost: number }>();
        for (const r of thisRows) {
          const key: Tier = isTier(r.request_tier) ? r.request_tier : 'edit';
          const agg = tierMap.get(key) ?? { runs: 0, tokens: 0, cost: 0 };
          agg.runs += 1; agg.tokens += r.tokens_used ?? 0; agg.cost += r.estimated_cost_usd ?? 0;
          tierMap.set(key, agg);
        }
        setTierRows(TIERS.map((tier) => {
          const agg = tierMap.get(tier) ?? { runs: 0, tokens: 0, cost: 0 };
          return { tier, runs: agg.runs, avgTokens: agg.runs ? Math.round(agg.tokens / agg.runs) : 0, avgCost: agg.runs ? agg.cost / agg.runs : 0, pct: totalRuns ? Math.round((agg.runs / totalRuns) * 100) : 0 };
        }));

        const modelMap = new Map<string, { runs: number; cost: number }>();
        for (const r of thisRows) {
          const agg = modelMap.get(r.model_used ?? 'unknown') ?? { runs: 0, cost: 0 };
          agg.runs += 1; agg.cost += r.estimated_cost_usd ?? 0;
          modelMap.set(r.model_used ?? 'unknown', agg);
        }
        setModelRows(Array.from(modelMap.entries()).map(([model, agg]) => ({ model, runs: agg.runs, totalCost: agg.cost })).sort((a, b) => b.runs - a.runs));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load AI metrics');
      } finally { setLoading(false); }
    };

    const loadRecent = async () => {
      try {
        const { data, error } = await supabase.from('agent_runs').select('id, project_id, status, created_at, steps_taken, tokens_used, request_tier, model_used, estimated_cost_usd')
          .order('created_at', { ascending: false }).limit(20);
        if (error) throw error;
        const rows = (data ?? []) as AgentRun[];
        setRecent(rows);
        const { data: failedData } = await supabase.from('agent_runs').select('id, project_id, status, created_at, model_used, error_message')
          .eq('status', 'failed').order('created_at', { ascending: false }).limit(10);
        const failed = (failedData ?? []) as AgentRun[];
        setFailedRuns(failed);
        await addProjectNames(Array.from(new Set([...rows, ...failed].map((r) => r.project_id).filter((p): p is string => Boolean(p)))));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load recent runs');
      }
    };

    const loadKbStats = async () => {
      try {
        const { data, error } = await supabase.from('project_file_embeddings').select('project_id, updated_at').order('updated_at', { ascending: false }).limit(5000);
        if (error) throw error;
        const rows = (data ?? []) as { project_id: string | null; updated_at: string | null }[];
        setKb({ available: true, totalFiles: rows.length, totalProjects: new Set(rows.map((r) => r.project_id).filter(Boolean)).size, lastIndexed: rows[0]?.updated_at ?? null });
      } catch { setKb({ available: false, totalFiles: 0, totalProjects: 0, lastIndexed: null }); }
    };

    loadMetrics(); loadRecent(); loadKbStats(); loadProviderHealth();
  }, []);

  if (loading) return <Page title="AI metrics"><p className="text-[13px] text-gray-500">Loading…</p></Page>;

  return (
    <Page title="AI metrics">
      <Stats items={[
        { label: 'Month cost', value: `${fmtMoney(monthCost)} (${costTrend})` },
        { label: 'Month runs', value: `${monthRuns.toLocaleString()} (${runsTrend})` },
        { label: 'Avg cost / run', value: fmtMoney(monthRuns ? monthCost / monthRuns : 0, 4) },
        { label: 'Cache hit rate', value: `${cacheHitRate.toFixed(0)}%` },
        { label: 'Abort / fail rate', value: `${abortRate.toFixed(1)}%`, tone: abortRate > 10 ? 'bad' : undefined },
        { label: `Runs over ${TOKEN_CAP_WARN.toLocaleString()} tokens`, value: capHits, tone: capHits > 0 ? 'warn' : undefined },
        { label: 'KB files / projects', value: kb.available ? `${kb.totalFiles.toLocaleString()} / ${kb.totalProjects.toLocaleString()}` : 'unavailable', tone: kb.available ? undefined : 'bad' },
        { label: 'KB last indexed', value: kb.available ? ago(kb.lastIndexed) : '—' },
      ]} />
      <Panel title="Provider health">
        <div className="flex flex-wrap gap-2 px-3 py-2 text-[13px]">
          {healthError ? <span className="text-red-400">Health endpoint unreachable</span>
            : providerHealth === null ? <span className="text-gray-500">Loading…</span>
            : providerHealth.map((p) => <Tag key={p.provider} tone={p.ok ? 'ok' : 'bad'}>{p.provider}</Tag>)}
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tiers (this month)">
          <Table head={['Tier', 'Runs', 'Avg tokens', 'Avg cost', '% runs']}>
            {tierRows.map((r) => (
              <tr key={r.tier}><td>{r.tier}</td><td>{r.runs.toLocaleString()}</td><td>{r.avgTokens.toLocaleString()}</td><td>{fmtMoney(r.avgCost, 4)}</td><td>{r.pct}%</td></tr>
            ))}
          </Table>
        </Panel>
        <Panel title="Models (this month)">
          <Table head={['Model', 'Runs', 'Cost']} empty="No model data">
            {modelRows.map((r) => (
              <tr key={r.model}><td className="font-mono text-[11px]">{r.model}</td><td>{r.runs.toLocaleString()}</td><td>{fmtMoney(r.totalCost, 4)}</td></tr>
            ))}
          </Table>
        </Panel>
        <Panel title="Top projects by spend (this month)">
          <Table head={['Project', 'Runs', 'Cost']} empty="No spend data">
            {topProjects.map((r) => (
              <tr key={r.projectId}><td>{projectLabel(r.projectId)}</td><td>{r.runs}</td><td>{fmtMoney(r.cost, 4)}</td></tr>
            ))}
          </Table>
        </Panel>
        <Panel title="Recent failed runs">
          <Table head={['Project', 'Model', 'Error', 'When']} empty="No failures">
            {failedRuns.map((r) => (
              <tr key={r.id}><td>{projectLabel(r.project_id)}</td><td className="font-mono text-[11px]">{r.model_used ?? ' '}</td><td className="text-red-300 max-w-[280px] truncate" title={r.error_message ?? ''}>{r.error_message ?? 'Unknown error'}</td><td>{ago(r.created_at)}</td></tr>
            ))}
          </Table>
        </Panel>
      </div>
      <Panel title="Recent runs">
        <Table head={['When', 'Project', 'Tier', 'Model', 'Tokens', 'Cost', 'Steps', 'Status']} empty="No runs">
          {recent.map((r) => (
            <tr key={r.id}>
              <td>{ago(r.created_at)}</td><td>{projectLabel(r.project_id)}</td>
              <td>{isTier(r.request_tier) ? <Tag>{r.request_tier}</Tag> : ' '}</td>
              <td className="font-mono text-[11px]">{r.model_used ?? ' '}</td>
              <td>{(r.tokens_used ?? 0).toLocaleString()}</td><td>{fmtMoney(r.estimated_cost_usd ?? 0, 4)}</td><td>{r.steps_taken ?? 0}</td>
              <td><Dot tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'} /> {r.status ?? 'unknown'}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </Page>
  );
}
