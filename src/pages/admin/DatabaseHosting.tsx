import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Database, Search, Loader2, RefreshCw, Radio, Download, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { getGenServerUrl } from '@/config/external-api';

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

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-500/15 text-green-400 border-green-500/30',
  provisioning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  deprovisioning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  error: 'bg-red-500/15 text-red-400 border-red-500/30',
  deprovisioned: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

export default function DatabaseHosting() {
  const [rows, setRows] = useState<TenantDbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [actioningId, setActioningId] = useState<string | null>(null);

  const authedFetch = async (path: string, options: RequestInit = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    return fetch(getGenServerUrl(path), {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${session?.access_token}` },
    });
  };

  const handlePing = async (row: TenantDbRow) => {
    setActioningId(row.id);
    try {
      const res = await authedFetch(`/api/v1/admin/database/${row.id}/ping`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ping failed');
      toast.success(data.connected ? `Connected (${data.latencyMs}ms)` : `Not connected: ${data.error || 'unknown'}`);
    } catch (err: any) {
      toast.error(err.message || 'Ping failed');
    } finally {
      setActioningId(null);
    }
  };

  const handleDump = async (row: TenantDbRow) => {
    setActioningId(row.id);
    try {
      const res = await authedFetch(`/api/v1/admin/database/${row.id}/dump`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Dump failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${row.schema_name}-dump-${Date.now()}.sql`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Dump downloaded');
    } catch (err: any) {
      toast.error(err.message || 'Dump failed');
    } finally {
      setActioningId(null);
    }
  };

  const handleDeprovision = async (row: TenantDbRow) => {
    if (row.status === 'deprovisioned') return;
    if (!confirm(`Deprovision database "${row.schema_name}" (owned by ${row.owner_email || row.user_id})? This cannot be undone.`)) return;
    setActioningId(row.id);
    try {
      const res = await authedFetch(`/api/v1/admin/database/${row.id}/deprovision`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deprovision failed');
      toast.success('Database deprovisioned');
      load();
    } catch (err: any) {
      toast.error(err.message || 'Deprovision failed');
    } finally {
      setActioningId(null);
    }
  };

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tenant_databases')
        .select('id, user_id, organization_id, schema_name, status, error_message, created_at, organizations(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const userIds = [...new Set((data || []).map((r: any) => r.user_id))];
      let profileMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, email')
          .in('id', userIds);
        profileMap = (profiles || []).reduce((acc: Record<string, string>, p: any) => {
          acc[p.id] = p.email;
          return acc;
        }, {});
      }

      setRows((data || []).map((r: any) => ({
        id: r.id,
        user_id: r.user_id,
        organization_id: r.organization_id,
        schema_name: r.schema_name,
        status: r.status,
        error_message: r.error_message,
        created_at: r.created_at,
        owner_email: profileMap[r.user_id] || null,
        org_name: r.organizations?.name || null,
      })));
    } catch (err) {
      console.error('Failed to load tenant databases:', err);
      toast.error('Failed to load hosted databases');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = rows.filter((r) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return r.schema_name.toLowerCase().includes(q) ||
      (r.owner_email || '').toLowerCase().includes(q) ||
      (r.org_name || '').toLowerCase().includes(q);
  });

  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    acc.total = (acc.total || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (loading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Database className="h-6 w-6" />ECG CLAUDE DBs</h1>
          <p className="text-sm text-muted-foreground">Tenant databases provisioned on VPS5, across all projects and organizations.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search schema, owner, org…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-8" />
          </div>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Total', value: counts.total || 0 },
          { label: 'Active', value: counts.active || 0 },
          { label: 'Provisioning', value: counts.provisioning || 0 },
          { label: 'Error', value: counts.error || 0 },
          { label: 'Deprovisioned', value: counts.deprovisioned || 0 },
        ].map((c) => (
          <Card key={c.label}>
            <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{c.label}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-bold">{c.value}</p></CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schema</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">No hosted databases yet.</TableCell></TableRow>
              ) : filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.schema_name}</TableCell>
                  <TableCell className="text-sm">{r.owner_email || r.user_id}</TableCell>
                  <TableCell className="text-sm">{r.org_name || '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(STATUS_STYLES[r.status] || '')} title={r.error_message || undefined}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost" size="sm" className="h-7 w-7 p-0"
                        title="Ping"
                        disabled={actioningId === r.id || r.status === 'deprovisioned'}
                        onClick={() => handlePing(r)}
                      >
                        {actioningId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7 w-7 p-0"
                        title="Download dump"
                        disabled={actioningId === r.id || r.status === 'deprovisioned'}
                        onClick={() => handleDump(r)}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                        title="Deprovision"
                        disabled={actioningId === r.id || r.status === 'deprovisioned'}
                        onClick={() => handleDeprovision(r)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
