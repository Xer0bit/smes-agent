import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Server, Plus, RefreshCw, Trash2, Activity, Shield, Loader2,
  CheckCircle2, XCircle, AlertTriangle, Wifi, WifiOff, Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// ── Types ────────────────────────────────────────────────────────────────────

interface HostingServer {
  id: string;
  name: string;
  public_ip: string;
  ssh_user: string;
  region: string;
  status: 'online' | 'offline' | 'maintenance' | 'draining';
  api_key: string | null;
  api_port: number;
  capacity_total: number;
  capacity_used: number;
  node_name: string | null;
  health_status: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  health_last_check: string | null;
  created_at: string;
  updated_at: string;
}

interface AddServerForm {
  name: string;
  public_ip: string;
  ssh_user: string;
  region: string;
  api_port: string;
  api_key: string;
  capacity_total: string;
}

const DEFAULT_FORM: AddServerForm = {
  name: '',
  public_ip: '',
  ssh_user: 'root',
  region: 'us-east',
  api_port: '4000',
  api_key: '',
  capacity_total: '20',
};

const STATUS_STYLES: Record<string, { color: string; icon: React.ElementType }> = {
  online:      { color: 'text-emerald-400', icon: CheckCircle2 },
  offline:     { color: 'text-red-400', icon: XCircle },
  maintenance: { color: 'text-amber-400', icon: AlertTriangle },
  draining:    { color: 'text-orange-400', icon: AlertTriangle },
};

const HEALTH_STYLES: Record<string, { color: string; icon: React.ElementType }> = {
  healthy:      { color: 'text-emerald-400', icon: Wifi },
  degraded:     { color: 'text-amber-400', icon: AlertTriangle },
  unreachable:  { color: 'text-red-400', icon: WifiOff },
  unknown:      { color: 'text-gray-500', icon: WifiOff },
};

const REGIONS = ['us-east', 'us-west', 'eu-west', 'ap-southeast', 'ap-south', 'sa-east'];

// ── Component ────────────────────────────────────────────────────────────────

export default function AdminServers() {
  const [servers, setServers] = useState<HostingServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<AddServerForm>({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<HostingServer | null>(null);

  // ── Load servers ─────────────────────────────────────────────────────────
  const loadServers = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('hosting_servers')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      toast.error('Failed to load servers');
      console.error(error);
    }
    setServers((data as unknown as HostingServer[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);

  // ── Add server ───────────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!form.name.trim() || !form.public_ip.trim()) {
      toast.error('Name and IP are required');
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('hosting_servers').insert({
      name: form.name.trim(),
      public_ip: form.public_ip.trim(),
      ssh_user: form.ssh_user.trim() || 'root',
      region: form.region,
      api_port: parseInt(form.api_port) || 4000,
      api_key: form.api_key.trim() || null,
      capacity_total: parseInt(form.capacity_total) || 20,
    } as any);

    setSaving(false);
    if (error) {
      toast.error('Failed to add server: ' + error.message);
      return;
    }
    toast.success(`Server "${form.name}" added`);
    setShowAdd(false);
    setForm({ ...DEFAULT_FORM });
    loadServers();
  };

  // ── Test connectivity ────────────────────────────────────────────────────
  const handleTest = async (server: HostingServer) => {
    setTesting(server.id);
    try {
      const url = `http://${server.public_ip}:${server.api_port}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        await supabase.from('hosting_servers').update({
          health_status: 'healthy',
          health_last_check: new Date().toISOString(),
          node_name: data.node || null,
        } as any).eq('id', server.id);
        toast.success(`${server.name}: healthy (node=${data.node})`);
      } else {
        await supabase.from('hosting_servers').update({
          health_status: 'degraded',
          health_last_check: new Date().toISOString(),
        } as any).eq('id', server.id);
        toast.warning(`${server.name}: responded with ${res.status}`);
      }
    } catch {
      await supabase.from('hosting_servers').update({
        health_status: 'unreachable',
        health_last_check: new Date().toISOString(),
      } as any).eq('id', server.id);
      toast.error(`${server.name}: unreachable`);
    }
    setTesting(null);
    loadServers();
  };

  // ── Remove server ────────────────────────────────────────────────────────
  const handleRemove = async () => {
    if (!confirmRemove) return;
    setRemoving(confirmRemove.id);
    const { error } = await supabase.from('hosting_servers').delete().eq('id', confirmRemove.id);
    setRemoving(null);
    setConfirmRemove(null);
    if (error) {
      toast.error('Failed to remove: ' + error.message);
      return;
    }
    toast.success(`Removed ${confirmRemove.name}`);
    loadServers();
  };

  // ── Toggle status ────────────────────────────────────────────────────────
  const toggleStatus = async (server: HostingServer, newStatus: string) => {
    await supabase.from('hosting_servers').update({ status: newStatus } as any).eq('id', server.id);
    toast.success(`${server.name} → ${newStatus}`);
    loadServers();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Hosting Servers</h2>
          <p className="text-sm text-gray-500 mt-1">Manage hosting VPS nodes for tenant deployments</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadServers} disabled={loading}
            className="border-white/10 hover:bg-white/5">
            <RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} /> Refresh
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}
            className="bg-purple-600 hover:bg-purple-700">
            <Plus className="h-4 w-4 mr-2" /> Add Server
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardContent className="pt-5">
            <div className="text-2xl font-bold text-white">{servers.length}</div>
            <p className="text-xs text-gray-500 mt-1">Total Servers</p>
          </CardContent>
        </Card>
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardContent className="pt-5">
            <div className="text-2xl font-bold text-emerald-400">
              {servers.filter(s => s.status === 'online').length}
            </div>
            <p className="text-xs text-gray-500 mt-1">Online</p>
          </CardContent>
        </Card>
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardContent className="pt-5">
            <div className="text-2xl font-bold text-white">
              {servers.reduce((sum, s) => sum + s.capacity_used, 0)}
            </div>
            <p className="text-xs text-gray-500 mt-1">Total Tenants</p>
          </CardContent>
        </Card>
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardContent className="pt-5">
            <div className="text-2xl font-bold text-white">
              {servers.reduce((sum, s) => sum + s.capacity_total, 0) - servers.reduce((sum, s) => sum + s.capacity_used, 0)}
            </div>
            <p className="text-xs text-gray-500 mt-1">Available Slots</p>
          </CardContent>
        </Card>
      </div>

      {/* Server Table */}
      <Card className="bg-white/[0.02] border-white/[0.06]">
        <CardHeader>
          <CardTitle className="text-base text-white flex items-center gap-2">
            <Server className="h-4 w-4 text-purple-400" /> Registered Servers
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
            </div>
          ) : servers.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Server className="h-8 w-8 mx-auto mb-3 opacity-50" />
              <p>No hosting servers registered yet.</p>
              <Button size="sm" className="mt-4 bg-purple-600 hover:bg-purple-700" onClick={() => setShowAdd(true)}>
                <Plus className="h-4 w-4 mr-2" /> Add First Server
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-white/[0.06] hover:bg-transparent">
                  <TableHead className="text-gray-400">Name</TableHead>
                  <TableHead className="text-gray-400">IP / Port</TableHead>
                  <TableHead className="text-gray-400">Region</TableHead>
                  <TableHead className="text-gray-400">Status</TableHead>
                  <TableHead className="text-gray-400">Health</TableHead>
                  <TableHead className="text-gray-400">Capacity</TableHead>
                  <TableHead className="text-gray-400 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((s) => {
                  const sstyle = STATUS_STYLES[s.status] || STATUS_STYLES.offline;
                  const hstyle = HEALTH_STYLES[s.health_status] || HEALTH_STYLES.unknown;
                  const StatusIcon = sstyle.icon;
                  const HealthIcon = hstyle.icon;
                  return (
                    <TableRow key={s.id} className="border-white/[0.04] hover:bg-white/[0.02]">
                      <TableCell className="text-white font-medium">{s.name}</TableCell>
                      <TableCell className="text-gray-400 font-mono text-xs">{s.public_ip}:{s.api_port}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs border-white/10">{s.region}</Badge></TableCell>
                      <TableCell>
                        <span className={cn('flex items-center gap-1.5 text-xs font-medium', sstyle.color)}>
                          <StatusIcon className="h-3.5 w-3.5" /> {s.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={cn('flex items-center gap-1.5 text-xs', hstyle.color)}>
                          <HealthIcon className="h-3.5 w-3.5" /> {s.health_status}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-purple-500"
                              style={{ width: `${s.capacity_total ? (s.capacity_used / s.capacity_total) * 100 : 0}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-400">{s.capacity_used}/{s.capacity_total}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white"
                            onClick={() => handleTest(s)} disabled={testing === s.id}>
                            {testing === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
                          </Button>
                          {s.status === 'online' ? (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-400 hover:text-amber-300"
                              onClick={() => toggleStatus(s, 'maintenance')}>
                              <Settings className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-emerald-400 hover:text-emerald-300"
                              onClick={() => toggleStatus(s, 'online')}>
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-300"
                            onClick={() => setConfirmRemove(s)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Add Server Dialog ────────────────────────────────────────────── */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-lg bg-[hsl(var(--admin-surface))] border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">Add Hosting Server</DialogTitle>
            <DialogDescription className="text-gray-400">
              Register a new VPS as a hosting node for tenant deployments.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">Server Name</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="hosting-mx-1" className="bg-white/[0.03] border-white/10 text-white" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">Public IP</Label>
                <Input value={form.public_ip} onChange={e => setForm(f => ({ ...f, public_ip: e.target.value }))}
                  placeholder="187.77.157.231" className="bg-white/[0.03] border-white/10 text-white" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">SSH User</Label>
                <Input value={form.ssh_user} onChange={e => setForm(f => ({ ...f, ssh_user: e.target.value }))}
                  className="bg-white/[0.03] border-white/10 text-white" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">Region</Label>
                <Select value={form.region} onValueChange={v => setForm(f => ({ ...f, region: v }))}>
                  <SelectTrigger className="bg-white/[0.03] border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[hsl(var(--admin-surface))] border-white/10">
                    {REGIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">API Port</Label>
                <Input value={form.api_port} onChange={e => setForm(f => ({ ...f, api_port: e.target.value }))}
                  className="bg-white/[0.03] border-white/10 text-white" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">API Key (Bearer Token)</Label>
                <Input value={form.api_key} onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
                  placeholder="optional" type="password" className="bg-white/[0.03] border-white/10 text-white" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-gray-400 text-xs">Max Tenants</Label>
                <Input value={form.capacity_total} onChange={e => setForm(f => ({ ...f, capacity_total: e.target.value }))}
                  className="bg-white/[0.03] border-white/10 text-white" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} className="border-white/10">Cancel</Button>
            <Button onClick={handleAdd} disabled={saving} className="bg-purple-600 hover:bg-purple-700">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
              Add Server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Remove Confirmation Dialog ───────────────────────────────────── */}
      <Dialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
        <DialogContent className="sm:max-w-md bg-[hsl(var(--admin-surface))] border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">Remove Server</DialogTitle>
            <DialogDescription className="text-gray-400">
              This will unregister <span className="text-red-400 font-medium">{confirmRemove?.name}</span> from the platform.
              Any active tenants on this server will become orphaned.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)} className="border-white/10">Cancel</Button>
            <Button variant="destructive" onClick={handleRemove} disabled={removing === confirmRemove?.id}>
              {removing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
