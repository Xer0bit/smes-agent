import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/adminClient';
import { Page, Stats, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';

interface EcgDashboardRow {
  projectId: string;
  projectName: string;
  ownerEmail: string | null;
  orgName: string | null;
  ecgOrgName: string | null;
  agentCount: number;
  agentNames: string[];
  modules: string[];
  updatedAt: string | null;
}

interface SecretRow { project_id: string }
type Org = { name: string } | { name: string }[] | null;
const orgName = (o: Org): string | null => (Array.isArray(o) ? o[0]?.name ?? null : o?.name ?? null);
interface ProjectRow { id: string; name: string; user_id: string | null; updated_at: string | null; organizations: Org }
interface SettingRow { project_id: string; setting_value: EcgCustomizer | null }
interface ProfileRow { id: string; email: string }
interface EcgCustomizer { agentIds?: unknown; agentNames?: Record<string, string>; modules?: unknown; orgName?: string | null }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export default function AdminEcgAgents() {
  const [rows, setRows] = useState<EcgDashboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: secretData, error: secretsErr } = await supabase
        .from('project_secrets')
        .select('project_id')
        .eq('key_name', 'ECG_MCP_API_KEY');
      if (secretsErr) throw secretsErr;
      const secretRows: SecretRow[] = secretData ?? [];
      const projectIds = [...new Set(secretRows.map((r) => r.project_id))];
      if (projectIds.length === 0) { setRows([]); return; }

      const [{ data: projectData, error: projErr }, { data: settingData, error: settingsErr }] = await Promise.all([
        supabase.from('projects').select('id, name, user_id, updated_at, organizations(name)').in('id', projectIds),
        supabase.from('project_settings').select('project_id, setting_value').eq('setting_key', 'ecg_customizer').in('project_id', projectIds),
      ]);
      if (projErr) throw projErr;
      if (settingsErr) throw settingsErr;
      const projects: ProjectRow[] = projectData ?? [];
      const settings: SettingRow[] = settingData ?? [];

      const ownerIds = [...new Set(projects.map((p) => p.user_id).filter((id): id is string => Boolean(id)))];
      const emailByOwner: Record<string, string> = {};
      if (ownerIds.length > 0) {
        const { data: profileData } = await supabase.from('profiles').select('id, email').in('id', ownerIds);
        const profiles: ProfileRow[] = profileData ?? [];
        for (const p of profiles) emailByOwner[p.id] = p.email;
      }

      const cfgByProject: Record<string, EcgCustomizer> = {};
      for (const s of settings) cfgByProject[s.project_id] = s.setting_value ?? {};

      setRows(projects.map((p) => {
        const cfg = cfgByProject[p.id] ?? {};
        const agentIds = strings(cfg.agentIds);
        const names = cfg.agentNames ?? {};
        return {
          projectId: p.id,
          projectName: p.name,
          ownerEmail: p.user_id ? emailByOwner[p.user_id] ?? null : null,
          orgName: orgName(p.organizations),
          ecgOrgName: cfg.orgName ?? null,
          agentCount: agentIds.length,
          agentNames: agentIds.map((id) => names[id] ?? id),
          modules: strings(cfg.modules),
          updatedAt: p.updated_at ?? null,
        };
      }));
    } catch (e) {
      console.error('Failed to load eCG fleet:', e);
      setError(e instanceof Error && e.message ? e.message : 'Failed to load eCG-connected dashboards');
      toast.error('Failed to load eCG fleet');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((r) =>
      r.projectName.toLowerCase().includes(needle) ||
      (r.ownerEmail ?? '').toLowerCase().includes(needle) ||
      (r.orgName ?? '').toLowerCase().includes(needle) ||
      (r.ecgOrgName ?? '').toLowerCase().includes(needle) ||
      r.agentNames.some((n) => n.toLowerCase().includes(needle)))
    : rows;

  return (
    <Page title="eCG agent dashboards" actions={<button className={btn.ghost} onClick={load} disabled={loading}>Refresh</button>}>
      <Stats items={[
        { label: 'Dashboards', value: loading ? '...' : rows.length },
        { label: 'Managed agents', value: loading ? '...' : rows.reduce((sum, r) => sum + r.agentCount, 0) },
        { label: 'Multi-agent', value: loading ? '...' : rows.filter((r) => r.agentCount > 1).length },
      ]} />

      <Panel title={`Dashboards (${filtered.length})`} actions={<input className={input + ' w-56'} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <Table head={['Dashboard', 'Owner', 'eCG org', 'Agents', 'Modules', 'Updated', '']} empty={loading ? 'Loading' : error ?? (needle ? 'No matches' : 'No connected dashboards')}>
          {filtered.map((r) => (
            <tr key={r.projectId}>
              <td className="text-white">{r.projectName}</td>
              <td>
                <div>{r.ownerEmail ?? '—'}</div>
                {r.orgName && <div className="text-[11px] text-gray-500">{r.orgName}</div>}
              </td>
              <td className="text-gray-400">{r.ecgOrgName ?? '—'}</td>
              <td>
                {r.agentCount === 0 ? '—' : (
                  <div className="flex flex-wrap gap-1">
                    {r.agentNames.slice(0, 4).map((name, i) => <Tag key={i}>{name}</Tag>)}
                    {r.agentCount > 4 && <Tag tone="accent">+{r.agentCount - 4}</Tag>}
                  </div>
                )}
              </td>
              <td className="text-gray-400">{r.modules.length > 0 ? r.modules.join(', ') : 'all'}</td>
              <td className="text-gray-400">{when(r.updatedAt)}</td>
              <td className="text-right">
                <a href={`/project/${r.projectId}`} target="_blank" rel="noopener noreferrer" className={btn.ghost + ' inline-flex items-center'}>Open</a>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </Page>
  );
}
