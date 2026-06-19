import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Database, Server, Globe, Activity, Play, Pause, Trash2,
  Loader2, CheckCircle2, XCircle, Container, RefreshCw,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// ── Types ────────────────────────────────────────────────────────────────────

interface TenantDetail {
  id: string;
  project_id: string;
  hosting_server_id: string;
  status: string;
  postgres_port: number | null;
  postgrest_port: number | null;
  edge_runtime_port: number | null;
  db_name: string | null;
  subdomain: string | null;
  custom_domain: string | null;
  container_ids: Record<string, string>;
  deployed_at: string | null;
  last_deploy_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ServerInfo {
  id: string;
  name: string;
  public_ip: string;
  api_port: number;
  api_key: string | null;
}

interface ContainerStatus {
  postgres: { status: string; health: string };
  postgrest: { status: string; health: string };
  edge: { status: string; health: string };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AdminTenantDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [projectName, setProjectName] = useState('');
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [containers, setContainers] = useState<ContainerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  // ── Load deployment data ──────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { data: depData } = await supabase
        .from('tenant_deployments')
        .select('*')
        .eq('project_id', projectId)
        .maybeSingle();
      if (!depData) {
        toast.error('Tenant deployment not found');
        navigate('/admin/hosting');
        return;
      }
      setTenant(depData as unknown as TenantDetail);

      // Project name
      const { data: proj } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle();
      setProjectName((proj as any)?.name || projectId.slice(0, 8));

      // Server info
      const { data: srv } = await supabase
        .from('hosting_servers')
        .select('id, name, public_ip, api_port, api_key')
        .eq('id', (depData as any).hosting_server_id)
        .maybeSingle();
      setServer(srv as unknown as ServerInfo);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [projectId, navigate]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Fetch live container status from hosting service ──────────────────────
  const fetchContainerStatus = useCallback(async () => {
    if (!server || !projectId) return;
    try {
      const url = `http://${server.public_ip}:${server.api_port}/tenants/${projectId}/status`;
      const headers: HeadersInit = {};
      if (server.api_key) headers['Authorization'] = `Bearer ${server.api_key}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        setContainers(data.containers);
      }
    } catch {
      setContainers(null);
    }
  }, [server, projectId]);

  useEffect(() => {
    if (server) fetchContainerStatus();
  }, [server, fetchContainerStatus]);

  // ── Tenant actions ────────────────────────────────────────────────────────
  const callAction = async (action: 'suspend' | 'resume' | 'destroy') => {
    if (!server || !tenant) return;
    setActionLoading(action);
    try {
      const method = action === 'destroy' ? 'DELETE' : 'POST';
      const urlPath = action === 'destroy' ? `/tenants/${tenant.project_id}` : `/tenants/${tenant.project_id}/${action}`;
      const url = `http://${server.public_ip}:${server.api_port}${urlPath}`;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (server.api_key) headers['Authorization'] = `Bearer ${server.api_key}`;
      const res = await fetch(url, { method, headers });
      if (!res.ok) throw new Error(await res.text());

      if (action === 'destroy') {
        await supabase.from('tenant_deployments').delete().eq('id', tenant.id);
        toast.success('Tenant destroyed');
        navigate('/admin/hosting');
        return;
      }

      const newStatus = action === 'suspend' ? 'suspended' : 'running';
      await supabase.from('tenant_deployments')
        .update({ status: newStatus, ...(action === 'suspend' ? { suspended_at: new Date().toISOString() } : {}) } as any)
        .eq('id', tenant.id);
      toast.success(`Tenant ${action}ed`);
      loadData();
      fetchContainerStatus();
    } catch (e: any) {
      toast.error(`${action} failed: ${e.message}`);
    } finally {
      setActionLoading(null);
      setConfirmDestroy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (!tenant) return null;

  const statusColor = tenant.status === 'running' ? 'text-emerald-400' : tenant.status === 'suspended' ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/admin/hosting')}
          className="h-8 w-8 text-gray-400 hover:text-white">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-white">{projectName}</h2>
          <p className="text-sm text-gray-500">Tenant Deployment Detail</p>
        </div>
        <Badge variant="outline" className={cn('text-xs', statusColor)}>
          {tenant.status}
        </Badge>
        <Button variant="outline" size="sm" onClick={() => { loadData(); fetchContainerStatus(); }}
          className="border-white/10 hover:bg-white/5">
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Server className="h-3.5 w-3.5" /> Server
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-white font-medium">{server?.name || '—'}</div>
            <div className="text-xs text-gray-500 font-mono mt-1">{server?.public_ip}:{server?.api_port}</div>
          </CardContent>
        </Card>
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Globe className="h-3.5 w-3.5" /> Domain
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-blue-400 font-mono">{tenant.custom_domain || tenant.subdomain || 'Not configured'}</div>
          </CardContent>
        </Card>
        <Card className="bg-white/[0.02] border-white/[0.06]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Database className="h-3.5 w-3.5" /> Database
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-white font-mono">{tenant.db_name || '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Port: {tenant.postgres_port || '—'}</div>
          </CardContent>
        </Card>
      </div>

      {/* Container Status */}
      <Card className="bg-white/[0.02] border-white/[0.06]">
        <CardHeader>
          <CardTitle className="text-base text-white flex items-center gap-2">
            <Container className="h-4 w-4 text-purple-400" /> Container Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          {containers ? (
            <div className="grid grid-cols-3 gap-4">
              {(['postgres', 'postgrest', 'edge'] as const).map((svc) => {
                const c = containers[svc];
                const isRunning = c?.status === 'running';
                return (
                  <div key={svc} className="p-4 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-white capitalize">{svc}</span>
                      {isRunning ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-400" />
                      )}
                    </div>
                    <div className="text-xs text-gray-400">Status: <span className={isRunning ? 'text-emerald-400' : 'text-red-400'}>{c?.status || 'unknown'}</span></div>
                    <div className="text-xs text-gray-500 mt-1">
                      Port: {svc === 'postgres' ? tenant.postgres_port : svc === 'postgrest' ? tenant.postgrest_port : tenant.edge_runtime_port || '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-gray-500 text-center py-6">
              Unable to fetch container status from server
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Card className="bg-white/[0.02] border-white/[0.06]">
        <CardHeader>
          <CardTitle className="text-base text-white flex items-center gap-2">
            <Activity className="h-4 w-4 text-purple-400" /> Lifecycle Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {tenant.status === 'running' && (
              <Button variant="outline" onClick={() => callAction('suspend')} disabled={!!actionLoading}
                className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10">
                {actionLoading === 'suspend' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Pause className="h-4 w-4 mr-2" />}
                Suspend
              </Button>
            )}
            {tenant.status === 'suspended' && (
              <Button variant="outline" onClick={() => callAction('resume')} disabled={!!actionLoading}
                className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10">
                {actionLoading === 'resume' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                Resume
              </Button>
            )}
            <Button variant="destructive" onClick={() => setConfirmDestroy(true)} disabled={!!actionLoading}>
              <Trash2 className="h-4 w-4 mr-2" /> Destroy
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Destroy Confirmation */}
      <Dialog open={confirmDestroy} onOpenChange={setConfirmDestroy}>
        <DialogContent className="bg-[#0d0f14] border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">Destroy Tenant</DialogTitle>
            <DialogDescription className="text-gray-400">
              This will permanently remove all containers, data, and Caddy config for <span className="text-red-400 font-medium">{projectName}</span>.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDestroy(false)} className="border-white/10">Cancel</Button>
            <Button variant="destructive" onClick={() => callAction('destroy')} disabled={actionLoading === 'destroy'}>
              {actionLoading === 'destroy' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Destroy Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
