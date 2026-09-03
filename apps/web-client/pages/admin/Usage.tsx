import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Page, Stats, Panel, Table, btn } from '@/components/admin/ui';

function fmtMoney(n: number, d = 2) { return `$${n.toFixed(d)}`; }
function fmtNum(n: number) { return n.toLocaleString(); }

function shortModel(m: string): string {
  if (!m) return ' ';
  if (m.includes('gemini-2.5-pro')) return 'Gemini 2.5 Pro';
  if (m.includes('gemini-2.5-flash') || m.includes('gemini-flash-latest')) return 'Gemini Flash';
  if (m.includes('gemini')) return 'Gemini';
  if (m.includes('deepseek')) return 'DeepSeek';
  if (m.includes('claude')) return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '');
  return m;
}

function getStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

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
interface OrgRow { id: string; name: string; runs: number; tokens: number; cost: number; avgCost: number; pct: number; }
interface ProjectRow { id: string; name: string; orgName: string; runs: number; tokens: number; cost: number; avgCost: number; topModel: string; }
interface ModelRow { model: string; runs: number; tokens: number; cost: number; runPct: number; costPct: number; }

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
      runs: agg.runs, tokens: agg.tokens, cost: agg.cost,
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
      const orgName = proj?.organization_id ? (orgMap.get(proj.organization_id)?.name ?? ' ') : ' ';
      const topModel = Array.from(agg.models.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ' ';
      return {
        id: pid, name: proj?.name ?? pid.slice(0, 8) + '…', orgName,
        runs: agg.runs, tokens: agg.tokens, cost: agg.cost,
        avgCost: agg.runs ? agg.cost / agg.runs : 0, topModel,
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
      model, runs: agg.runs, tokens: agg.tokens, cost: agg.cost,
      runPct: totalRuns ? (agg.runs / totalRuns) * 100 : 0,
      costPct: totalCost ? (agg.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

const DATE_OPTS = [7, 30, 90];
type TabId = 'org' | 'project' | 'model';
const TABS: Array<[TabId, string]> = [['org', 'Organizations'], ['project', 'Projects'], ['model', 'Models']];

export default function AdminUsage() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<TabId>('org');
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<Run[]>([]);
  const [projMap, setProjMap] = useState<Map<string, Project>>(new Map());
  const [orgMap, setOrgMap] = useState<Map<string, Org>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: runData, error } = await supabase
        .from('agent_runs')
        .select('id, project_id, tokens_used, estimated_cost_usd, model_used, created_at')
        .gte('created_at', getStart(days))
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = (runData ?? []) as Run[];
      setRuns(rows);

      const pids = Array.from(new Set(rows.map((r) => r.project_id).filter((p): p is string => Boolean(p))));
      if (pids.length) {
        const { data: projs } = await supabase.from('projects').select('id, name, organization_id').in('id', pids);
        const list = (projs ?? []) as Project[];
        setProjMap(new Map(list.map((p) => [p.id, p])));
        const oids = Array.from(new Set(list.map((p) => p.organization_id).filter((o): o is string => Boolean(o))));
        if (oids.length) {
          const { data: orgs } = await supabase.from('organizations').select('id, name').in('id', oids);
          setOrgMap(new Map(((orgs ?? []) as Org[]).map((o) => [o.id, o])));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const totalCost = runs.reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0);
  const totalTokens = runs.reduce((s, r) => s + (r.tokens_used ?? 0), 0);
  const uniqueProjs = new Set(runs.map((r) => r.project_id).filter(Boolean)).size;
  const orgRows = buildOrgRows(runs, projMap, orgMap);
  const projRows = buildProjectRows(runs, projMap, orgMap);
  const modelRows = buildModelRows(runs);

  return (
    <Page
      title="Usage"
      actions={
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-8 w-24 text-xs border-white/10 bg-transparent"><SelectValue /></SelectTrigger>
          <SelectContent>{DATE_OPTS.map((d) => <SelectItem key={d} value={String(d)}>{d}d</SelectItem>)}</SelectContent>
        </Select>
      }
    >
      {loading ? (
        <p className="text-[13px] text-gray-500">Loading…</p>
      ) : (
        <>
          <Stats items={[
            { label: 'Runs', value: fmtNum(runs.length) },
            { label: 'Cost', value: fmtMoney(totalCost, 4) },
            { label: 'Tokens', value: fmtNum(totalTokens) },
            { label: 'Projects', value: fmtNum(uniqueProjs) },
          ]} />
          <Panel actions={TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? btn.primary : btn.ghost} onClick={() => setTab(id)}>{label}</button>
          ))}>
            {tab === 'org' && (
              <Table head={['Organization', 'Runs', 'Tokens', 'Cost', 'Avg / run', '% cost']} empty="No data for this period">
                {orgRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td><td>{fmtNum(r.runs)}</td><td>{fmtNum(r.tokens)}</td>
                    <td>{fmtMoney(r.cost, 4)}</td><td>{fmtMoney(r.avgCost, 4)}</td><td>{r.pct.toFixed(1)}%</td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'project' && (
              <Table head={['Project', 'Organization', 'Runs', 'Tokens', 'Cost', 'Avg / run', 'Top model']} empty="No data for this period">
                {projRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td><td>{r.orgName}</td><td>{fmtNum(r.runs)}</td><td>{fmtNum(r.tokens)}</td>
                    <td>{fmtMoney(r.cost, 4)}</td><td>{fmtMoney(r.avgCost, 4)}</td><td>{shortModel(r.topModel)}</td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'model' && (
              <Table head={['Model', 'Runs', 'Tokens', 'Cost', 'Avg / run', '% runs', '% cost']} empty="No data for this period">
                {modelRows.map((r) => (
                  <tr key={r.model}>
                    <td>{shortModel(r.model)} <span className="text-gray-500 font-mono text-[11px]">{r.model}</span></td>
                    <td>{fmtNum(r.runs)}</td><td>{fmtNum(r.tokens)}</td><td>{fmtMoney(r.cost, 4)}</td>
                    <td>{fmtMoney(r.runs ? r.cost / r.runs : 0, 4)}</td><td>{r.runPct.toFixed(1)}%</td><td>{r.costPct.toFixed(1)}%</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}
