import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/adminClient';
import { getApiServerUrl } from '@/config/external-api';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Page, Stats, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';

interface TenantDbRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  schema_name: string;
  status: string;
  error_message: string | null;
  created_at: string;
  owner_email: string | null;
  org_name: string | null;
}

type Org = { name: string } | { name: string }[] | null;
const orgName = (o: Org): string | null => (Array.isArray(o) ? o[0]?.name ?? null : o?.name ?? null);
interface DbRow { id: string; user_id: string; organization_id: string | null; schema_name: string; status: string; error_message: string | null; created_at: string; organizations: Org }
interface ProfileRow { id: string; email: string }

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'gray'> = {
  active: 'ok', provisioning: 'warn', deprovisioning: 'warn', error: 'bad', deprovisioned: 'gray',
};

const authedFetch = async (path: string, options: RequestInit = {}) => {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(getApiServerUrl(path), {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${session?.access_token ?? ''}` },
  });
};

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function DatabaseHosting() {
  const [rows, setRows] = useState<TenantDbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<TenantDbRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tenant_databases')
        .select('id, user_id, organization_id, schema_name, status, error_message, created_at, organizations(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const dbRows: DbRow[] = data ?? [];

      const userIds = [...new Set(dbRows.map((r) => r.user_id))];
      const emailById: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, email').in('id', userIds);
        const profileRows: ProfileRow[] = profiles ?? [];
        for (const p of profileRows) emailById[p.id] = p.email;
      }

      setRows(dbRows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        organization_id: r.organization_id,
        schema_name: r.schema_name,
        status: r.status,
        error_message: r.error_message,
        created_at: r.created_at,
        owner_email: emailById[r.user_id] ?? null,
        org_name: orgName(r.organizations),
      })));
    } catch (e) {
      console.error('Failed to load tenant databases:', e);
      toast.error('Failed to load hosted databases');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const ping = async (row: TenantDbRow) => {
    setBusyId(row.id);
    try {
      const res = await authedFetch(`/api/v1/admin/database/${row.id}/ping`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ping failed');
      toast.success(data.connected ? `Connected (${data.latencyMs}ms)` : `Not connected: ${data.error || 'unknown'}`);
    } catch (e) {
      toast.error(errMsg(e, 'Ping failed'));
    } finally {
      setBusyId(null);
    }
  };

  const dump = async (row: TenantDbRow) => {
    setBusyId(row.id);
    try {
      const res = await authedFetch(`/api/v1/admin/database/${row.id}/dump`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Dump failed');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${row.schema_name}-dump-${Date.now()}.sql`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Dump downloaded');
    } catch (e) {
      toast.error(errMsg(e, 'Dump failed'));
    } finally {
      setBusyId(null);
    }
  };

  const deprovision = async (row: TenantDbRow) => {
    setBusyId(row.id);
    try {
      const res = await authedFetch(`/api/v1/admin/database/${row.id}/deprovision`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deprovision failed');
      toast.success('Database deprovisioned');
      load();
    } catch (e) {
      toast.error(errMsg(e, 'Deprovision failed'));
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((r) =>
      r.schema_name.toLowerCase().includes(needle) ||
      (r.owner_email ?? '').toLowerCase().includes(needle) ||
      (r.org_name ?? '').toLowerCase().includes(needle))
    : rows;

  const count = (status: string) => rows.filter((r) => r.status === status).length;

  return (
    <Page title="Cloud databases" actions={<button className={btn.ghost} onClick={load} disabled={loading}>Refresh</button>}>
      <Stats items={[
        { label: 'Total', value: rows.length },
        { label: 'Active', value: count('active'), tone: 'ok' },
        { label: 'Provisioning', value: count('provisioning'), tone: count('provisioning') > 0 ? 'warn' : undefined },
        { label: 'Error', value: count('error'), tone: count('error') > 0 ? 'bad' : undefined },
      ]} />

      <Panel title={`Databases (${filtered.length})`} actions={<input className={input + ' w-56'} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <Table head={['Schema', 'Owner', 'Organization', 'Status', 'Created', '']} empty={loading ? 'Loading' : needle ? 'No matches' : 'No hosted databases'}>
          {filtered.map((r) => {
            const off = busyId === r.id || r.status === 'deprovisioned';
            return (
              <tr key={r.id}>
                <td className="font-mono">{r.schema_name}</td>
                <td>{r.owner_email ?? r.user_id}</td>
                <td className="text-gray-400">{r.org_name ?? '—'}</td>
                <td><span title={r.error_message ?? undefined}><Tag tone={STATUS_TONE[r.status] ?? 'gray'}>{r.status}</Tag></span></td>
                <td className="text-gray-400">{when(r.created_at)}</td>
                <td className="text-right whitespace-nowrap">
                  <button className={btn.ghost + ' mr-1'} disabled={off} onClick={() => ping(r)}>Ping</button>
                  <button className={btn.ghost + ' mr-1'} disabled={off} onClick={() => dump(r)}>Dump</button>
                  <button className={btn.danger} disabled={off} onClick={() => setConfirm(r)}>Deprovision</button>
                </td>
              </tr>
            );
          })}
        </Table>
      </Panel>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="bg-[#0d0f14] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Deprovision {confirm?.schema_name} ({confirm?.owner_email ?? confirm?.user_id})? This cannot be undone.</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button className={btn.ghost} disabled={busyId !== null} onClick={() => setConfirm(null)}>Cancel</button>
            <button className={btn.danger} disabled={busyId !== null} onClick={() => confirm && deprovision(confirm)}>
              {busyId !== null && busyId === confirm?.id ? 'Deprovisioning' : 'Deprovision'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
