import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import { Page, Stats, Panel, Table, Tag, when } from '@/components/admin/ui';

interface Counts {
  totalUsers: number;
  totalOrgs: number;
  totalProjects: number;
  activeProjects: number;
}

interface ActivityRow {
  id: string;
  status: string;
  prompt: string;
  started_at: string;
  email: string;
}

function tone(status: string): 'ok' | 'warn' | 'bad' | 'gray' {
  if (status === 'completed' || status === 'success') return 'ok';
  if (status === 'failed' || status === 'error') return 'bad';
  if (status === 'running') return 'warn';
  return 'gray';
}

export default function AdminDashboard() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    loadCounts();
    loadActivity();
  }, []);

  const loadCounts = async () => {
    try {
      const [orgs, projects, users, active] = await Promise.all([
        supabase.from('organizations').select('id', { count: 'exact', head: true }),
        supabase.from('projects').select('id', { count: 'exact', head: true }).neq('status', 'deleted'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      ]);
      setCounts({
        totalOrgs: orgs.count ?? 0,
        totalProjects: projects.count ?? 0,
        totalUsers: users.count ?? 0,
        activeProjects: active.count ?? 0,
      });
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadActivity = async () => {
    try {
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id, status, prompt, started_at, user_id')
        .order('started_at', { ascending: false })
        .limit(5);
      if (error) throw error;

      const runs = data ?? [];
      const userIds = Array.from(new Set(runs.map((r) => r.user_id).filter((id): id is string => Boolean(id))));
      const { data: profiles } = userIds.length
        ? await supabase.from('profiles').select('id, email').in('id', userIds)
        : { data: [] };
      const emailById = new Map((profiles ?? []).map((p) => [p.id, p.email]));

      setActivity(runs.map((r) => ({
        id: r.id,
        status: r.status ?? '',
        prompt: String(r.prompt ?? '').slice(0, 80),
        started_at: r.started_at ?? '',
        email: (r.user_id && emailById.get(r.user_id)) || 'Unknown',
      })));
    } catch (e) {
      console.error('Failed to load activity:', e);
    }
  };

  const n = (v: number | undefined) => (v === undefined ? '…' : v.toLocaleString());

  return (
    <Page title="Overview">
      <Stats items={[
        { label: 'Users', value: n(counts?.totalUsers) },
        { label: 'Organizations', value: n(counts?.totalOrgs) },
        { label: 'Projects', value: n(counts?.totalProjects) },
        { label: 'Active projects', value: n(counts?.activeProjects) },
      ]} />
      <Panel
        title="Recent activity"
        actions={<button type="button" className="text-xs text-indigo-300 hover:text-indigo-200" onClick={() => navigate('/admin/usage')}>View all</button>}
      >
        <Table head={['User', 'Status', 'Prompt', 'When']} empty="No recent activity">
          {activity.map((row) => (
            <tr key={row.id}>
              <td>{row.email}</td>
              <td><Tag tone={tone(row.status)}>{row.status || 'unknown'}</Tag></td>
              <td className="text-gray-400 truncate max-w-md">{row.prompt}</td>
              <td className="text-gray-500 whitespace-nowrap">{when(row.started_at)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </Page>
  );
}
