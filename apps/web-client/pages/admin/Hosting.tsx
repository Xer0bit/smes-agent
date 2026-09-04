import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Search, Server, Globe, Trash2, RefreshCw, ExternalLink, Activity,
  CheckCircle2, XCircle, Clock, Loader2, Shield, HardDrive, Play, Pause, Rocket,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import SmesLoader from '@/components/SmesLoader';
import { toast } from 'sonner';
import { domainService } from '@/eCG/Publish';

// ── Types ────────────────────────────────────────────────────────────────────

interface HostingHealth {
  status: string;
  node: string;
  publicIp: string | null;
  sites: number;
  domains: number;
  uptime: number;
}

interface DomainMapping {
  domain: string;
  projectId: string;
  projectName?: string;
}

interface LiveSite {
  id: string;
  project_id: string;
  project_name: string;
  subdomain: string | null;
  deployment_url: string | null;
  published_at: string;
  org_name: string | null;
  custom_domains: CustomDomainRow[];
}

interface CustomDomainRow {
  id: string;
  domain: string;
  status: string;
  ssl_status: string;
  hosting_active: boolean;
  verified_at: string | null;
  created_at: string;
}

interface TenantDeployment {
  id: string;
  project_id: string;
  hosting_server_id: string;
  status: string;
  postgres_port: number | null;
  postgrest_port: number | null;
  edge_runtime_port: number | null;
  subdomain: string | null;
  custom_domain: string | null;
  deployed_at: string | null;
  created_at: string;
  // joined
  project_name?: string;
  server_name?: string;
  server_ip?: string;
}

interface HostingServerBasic {
  id: string;
  name: string;
  public_ip: string;
  api_port: number;
  api_key: string | null;
  status: string;
  capacity_used: number;
  capacity_total: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const STATUS_BADGE: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  active: { variant: 'default', label: 'Active' },
  pending_dns: { variant: 'secondary', label: 'Pending DNS' },
  verifying: { variant: 'secondary', label: 'Verifying' },
  failed: { variant: 'destructive', label: 'Failed' },
  inactive: { variant: 'outline', label: 'Inactive' },
};

// ── Component ────────────────────────────────────────────────────────────────

export default function AdminHosting() {
  const [health, setHealth] = useState<HostingHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [domains, setDomains] = useState<DomainMapping[]>([]);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [liveSites, setLiveSites] = useState<LiveSite[]>([]);
  const [filteredSites, setFilteredSites] = useState<LiveSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [removingDomain, setRemovingDomain] = useState<string | null>(null);
  const [removingSite, setRemovingSite] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ type: 'domain' | 'site'; id: string; label: string } | null>(null);

  // Tenant deployment state
  const [tenantDeployments, setTenantDeployments] = useState<TenantDeployment[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [hostingServers, setHostingServers] = useState<HostingServerBasic[]>([]);
  const [tenantActioning, setTenantActioning] = useState<string | null>(null);

  // ── Load hosting node health ──────────────────────────────────────────────
  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const data = await domainService.getHostingHealth();
      if (!data) throw new Error('Hosting service unreachable');
      setHealth(data);
    } catch (e: any) {
      setHealthError(e.message || 'Failed to reach hosting service');
      setHealth(null);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  // ── Load live sites from DB ───────────────────────────────────────────────
  const loadLiveSites = useCallback(async () => {
    setSitesLoading(true);
    try {
      // Published versions with latest per project
      const { data: publishedData, error: pubErr } = await supabase
        .from('published_versions')
        .select('id, project_id, subdomain, deployment_url, published_at, status')
        .eq('status', 'published')
        .order('published_at', { ascending: false });
      if (pubErr) throw pubErr;

      // Deduplicate: keep latest per project
      const seenProjects = new Set<string>();
      const uniquePublished = (publishedData || []).filter((p: any) => {
        if (seenProjects.has(p.project_id)) return false;
        seenProjects.add(p.project_id);
        return true;
      });

      // Fetch project names + org names
      const projectIds = uniquePublished.map((p: any) => p.project_id);
      let projectMap: Record<string, { name: string; org_name: string | null }> = {};
      if (projectIds.length > 0) {
        const { data: projectData } = await supabase
          .from('projects')
          .select('id, name, organizations(name)')
          .in('id', projectIds);
        (projectData || []).forEach((p: any) => {
          projectMap[p.id] = {
            name: p.name,
            org_name: p.organizations?.name || null,
          };
        });
      }

      // Fetch custom domains for all published projects
      let domainMap: Record<string, CustomDomainRow[]> = {};
      if (projectIds.length > 0) {
        const { data: domainData } = await supabase
          .from('project_custom_domains')
          .select('id, project_id, domain, status, ssl_status, hosting_active, verified_at, created_at')
          .in('project_id', projectIds);
        (domainData || []).forEach((d: any) => {
          if (!domainMap[d.project_id]) domainMap[d.project_id] = [];
          domainMap[d.project_id].push(d);
        });
      }

      const sites: LiveSite[] = uniquePublished.map((p: any) => ({
        id: p.id,
        project_id: p.project_id,
        project_name: projectMap[p.project_id]?.name || p.project_id.slice(0, 8),
        subdomain: p.subdomain,
        deployment_url: p.deployment_url,
        published_at: p.published_at,
        org_name: projectMap[p.project_id]?.org_name || null,
        custom_domains: domainMap[p.project_id] || [],
      }));

      setLiveSites(sites);
      setFilteredSites(sites);

      // Also load hosting domains from the service
      const { domains: hostingDomains, error: hostingErr } = await domainService.listHostingDomains();
      setDomainsError(hostingErr || null);
      if (hostingErr) toast.error(`Domain mappings: ${hostingErr}`);
      // Enrich with project names
      const enriched = hostingDomains.map(d => ({
        ...d,
        projectName: projectMap[d.projectId]?.name || d.projectId.slice(0, 8),
      }));
      setDomains(enriched);
    } catch (error) {
      console.error('Failed to load live sites:', error);
      toast.error('Failed to load hosting data');
    } finally {
      setSitesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadLiveSites();
    loadTenants();
  }, [loadHealth, loadLiveSites]);

  // ── Load tenant deployments ───────────────────────────────────────────────
  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError(null);
    try {
      // Load servers
      const { data: srvData } = await supabase
        .from('hosting_servers')
        .select('id, name, public_ip, api_port, api_key, status, capacity_used, capacity_total');
      const srvs = (srvData as unknown as HostingServerBasic[]) || [];
      setHostingServers(srvs);
      const srvMap = Object.fromEntries(srvs.map(s => [s.id, s]));

      // Load deployments
      const { data: depData } = await supabase
        .from('tenant_deployments')
        .select('*')
        .order('created_at', { ascending: false });
      const deps = (depData as unknown as TenantDeployment[]) || [];

      // Enrich with project + server names
      const projectIds = deps.map(d => d.project_id);
      let projMap: Record<string, string> = {};
      if (projectIds.length > 0) {
        const { data: pData } = await supabase.from('projects').select('id, name').in('id', projectIds);
        (pData || []).forEach((p: any) => { projMap[p.id] = p.name; });
      }

      const enriched = deps.map(d => ({
        ...d,
        project_name: projMap[d.project_id] || d.project_id.slice(0, 8),
        server_name: srvMap[d.hosting_server_id]?.name || '?',
        server_ip: srvMap[d.hosting_server_id]?.public_ip || '?',
      }));
      setTenantDeployments(enriched);
    } catch (e: any) {
      console.error('Failed to load tenants:', e);
      setTenantsError(e?.message || 'Failed to load tenant deployments');
      toast.error('Failed to load tenant deployments');
    } finally {
      setTenantsLoading(false);
    }
  }, []);

  // ── Tenant actions (suspend / resume) ─────────────────────────────────────
  const callTenantAction = async (dep: TenantDeployment, action: 'suspend' | 'resume') => {
    const server = hostingServers.find(s => s.id === dep.hosting_server_id);
    if (!server) { toast.error('Server not found'); return; }

    setTenantActioning(dep.id);
    try {
      const url = `http://${server.public_ip}:${server.api_port}/tenants/${dep.project_id}/${action}`;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (server.api_key) headers['Authorization'] = `Bearer ${server.api_key}`;
      const res = await fetch(url, { method: 'POST', headers });
      if (!res.ok) throw new Error(await res.text());

      const newStatus = action === 'suspend' ? 'suspended' : 'running';
      await supabase.from('tenant_deployments')
        .update({ status: newStatus, ...(action === 'suspend' ? { suspended_at: new Date().toISOString() } : {}) } as any)
        .eq('id', dep.id);
      toast.success(`Tenant ${action}ed`);
      loadTenants();
    } catch (e: any) {
      toast.error(`${action} failed: ${e.message}`);
    } finally {
      setTenantActioning(null);
    }
  };

  // ── Search filter ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredSites(liveSites);
    } else {
      const q = searchQuery.toLowerCase();
      setFilteredSites(liveSites.filter(s =>
        s.project_name.toLowerCase().includes(q) ||
        (s.subdomain || '').toLowerCase().includes(q) ||
        (s.org_name || '').toLowerCase().includes(q) ||
        s.custom_domains.some(d => d.domain.toLowerCase().includes(q))
      ));
    }
  }, [searchQuery, liveSites]);

  // ── Remove domain ─────────────────────────────────────────────────────────
  const handleRemoveDomain = async (domain: string) => {
    setRemovingDomain(domain);
    try {
      const result = await domainService.adminRemoveHostingDomain(domain);
      if (!result.success) throw new Error(result.error);
      toast.success(`Domain ${domain} removed from hosting`);
      await loadLiveSites();
      await loadHealth();
    } catch (e: any) {
      toast.error(e.message || 'Failed to remove domain');
    } finally {
      setRemovingDomain(null);
      setConfirmRemove(null);
    }
  };

  // ── Remove site deployment ────────────────────────────────────────────────
  const handleRemoveSite = async (projectId: string) => {
    setRemovingSite(projectId);
    try {
      const result = await domainService.removeHostingDeployment(projectId);
      if (!result.success) throw new Error(result.error);
      toast.success('Hosting deployment removed');
      await loadLiveSites();
      await loadHealth();
    } catch (e: any) {
      toast.error(e.message || 'Failed to remove deployment');
    } finally {
      setRemovingSite(null);
      setConfirmRemove(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Hosting Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor hosting nodes, live sites, and custom domain configurations
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { loadHealth(); loadLiveSites(); }}
          className="gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Node Health Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Node Status */}
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Server className="h-3.5 w-3.5" />
              Node Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : healthError ? (
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-400" />
                <span className="text-sm text-red-400">Offline</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span className="text-sm text-emerald-400 font-semibold">{health?.node || 'Online'}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Public IP */}
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Globe className="h-3.5 w-3.5" />
              Public IP
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className={cn("text-sm font-mono", health?.publicIp ? "text-white" : "text-muted-foreground")}>
              {healthLoading ? '...' : health?.publicIp || 'Not configured'}
            </span>
          </CardContent>
        </Card>

        {/* Live Sites */}
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <HardDrive className="h-3.5 w-3.5" />
              Deployed Sites
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-white">
              {healthLoading ? '...' : health?.sites ?? liveSites.length}
            </span>
          </CardContent>
        </Card>

        {/* Uptime */}
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Activity className="h-3.5 w-3.5" />
              Uptime
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-medium text-white">
              {healthLoading ? '...' : health ? formatUptime(health.uptime) : 'N/A'}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* ── Tenant Deployments ──────────────────────────────────────────── */}
      <Card className="border-white/[0.06] bg-white/[0.02]">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
            <Rocket className="h-4 w-4 text-muted-foreground" />
            Tenant Deployments
            <Badge variant="secondary" className="ml-2">{tenantDeployments.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tenantsLoading ? (
            <div className="flex items-center justify-center py-8">
              <SmesLoader variant="bars" />
            </div>
          ) : tenantsError ? (
            <div className="text-center py-8 text-red-400 text-sm">
              Failed to load tenant deployments: {tenantsError}
            </div>
          ) : tenantDeployments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No tenant deployments yet. Publish a project to provision a tenant.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-white/[0.06]">
                  <TableHead className="text-muted-foreground">Project</TableHead>
                  <TableHead className="text-muted-foreground">Server</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Domain</TableHead>
                  <TableHead className="text-muted-foreground">Ports</TableHead>
                  <TableHead className="text-muted-foreground">Deployed</TableHead>
                  <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantDeployments.map((dep) => (
                  <TableRow key={dep.id} className="border-white/[0.04]">
                    <TableCell className="text-white font-medium text-sm">{dep.project_name}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{dep.server_name}</TableCell>
                    <TableCell>
                      <Badge variant={
                        dep.status === 'running' ? 'default' :
                        dep.status === 'suspended' ? 'secondary' :
                        dep.status === 'failed' ? 'destructive' : 'outline'
                      } className="text-[10px]">
                        {dep.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {dep.custom_domain || dep.subdomain || ' '}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {dep.postgres_port ? `pg:${dep.postgres_port}` : ' '}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {dep.deployed_at ? new Date(dep.deployed_at).toLocaleDateString() : ' '}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {dep.status === 'running' && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-400 hover:text-amber-300"
                            disabled={tenantActioning === dep.id}
                            onClick={() => callTenantAction(dep, 'suspend')}>
                            {tenantActioning === dep.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                        {dep.status === 'suspended' && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-emerald-400 hover:text-emerald-300"
                            disabled={tenantActioning === dep.id}
                            onClick={() => callTenantAction(dep, 'resume')}>
                            {tenantActioning === dep.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Active Domain Mappings */}
      {(domains.length > 0 || domainsError || !sitesLoading) && (
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Active Domain Mappings on Caddy
              <Badge variant="secondary" className="ml-2">{domains.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {domainsError ? (
              <div className="text-center py-8 text-red-400 text-sm">
                Failed to load domain mappings: {domainsError}
              </div>
            ) : domains.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No active domain mappings.
              </div>
            ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-white/[0.06]">
                  <TableHead className="text-muted-foreground">Domain</TableHead>
                  <TableHead className="text-muted-foreground">Project</TableHead>
                  <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow key={d.domain} className="border-white/[0.04]">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Globe className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="font-mono text-sm text-white">{d.domain}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-foreground/80">{d.projectName}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => window.open(`https://${d.domain}`, '_blank')}
                          className="h-7 px-2 text-muted-foreground hover:text-white"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removingDomain === d.domain}
                          onClick={() => setConfirmRemove({ type: 'domain', id: d.domain, label: d.domain })}
                          className="h-7 px-2 text-muted-foreground hover:text-red-400"
                        >
                          {removingDomain === d.domain ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Live Published Sites */}
      <Card className="border-white/[0.06] bg-white/[0.02]">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              Published Sites
              <Badge variant="secondary" className="ml-2">{liveSites.length}</Badge>
            </CardTitle>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search sites, domains..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-white/[0.03] border-white/[0.08] text-sm"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {sitesLoading ? (
            <div className="flex items-center justify-center py-12">
              <SmesLoader variant="bars" />
            </div>
          ) : filteredSites.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {searchQuery ? 'No sites match your search' : 'No published sites yet'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-white/[0.06]">
                  <TableHead className="text-muted-foreground">Project</TableHead>
                  <TableHead className="text-muted-foreground">Organization</TableHead>
                  <TableHead className="text-muted-foreground">Subdomain</TableHead>
                  <TableHead className="text-muted-foreground">Custom Domains</TableHead>
                  <TableHead className="text-muted-foreground">Published</TableHead>
                  <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSites.map((site) => (
                  <TableRow key={site.id} className="border-white/[0.04]">
                    <TableCell>
                      <span className="text-sm font-medium text-white">{site.project_name}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{site.org_name || ' '}</span>
                    </TableCell>
                    <TableCell>
                      {site.subdomain ? (
                        <a
                          href={site.deployment_url || `https://preview.SMEsAgent.app/p/${site.subdomain}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-mono text-muted-foreground hover:underline"
                        >
                          {site.subdomain}
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground"> </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {site.custom_domains.length === 0 ? (
                        <span className="text-sm text-muted-foreground">None</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {site.custom_domains.map((cd) => {
                            const badgeConf = STATUS_BADGE[cd.status] || STATUS_BADGE.inactive;
                            return (
                              <div key={cd.id} className="flex items-center gap-2">
                                <span className="text-sm font-mono text-white">{cd.domain}</span>
                                <Badge variant={badgeConf.variant} className="text-[10px] h-5">
                                  {badgeConf.label}
                                </Badge>
                                {cd.hosting_active && (
                                  <span title="Active on Caddy"><CheckCircle2 className="h-3 w-3 text-emerald-400" /></span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {new Date(site.published_at).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {site.deployment_url && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => window.open(site.deployment_url!, '_blank')}
                            className="h-7 px-2 text-muted-foreground hover:text-white"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removingSite === site.project_id}
                          onClick={() => setConfirmRemove({
                            type: 'site',
                            id: site.project_id,
                            label: site.project_name,
                          })}
                          className="h-7 px-2 text-muted-foreground hover:text-red-400"
                        >
                          {removingSite === site.project_id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Confirm Remove Dialog */}
      <Dialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
        <DialogContent className="bg-background border-white/[0.08]">
          <DialogHeader>
            <DialogTitle className="text-white">
              Remove {confirmRemove?.type === 'domain' ? 'Domain' : 'Deployment'}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmRemove?.type === 'domain'
              ? `This will remove "${confirmRemove.label}" from Caddy and disable HTTPS for this domain.`
              : `This will remove the hosted files for "${confirmRemove?.label}" and all associated domain mappings.`
            }
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRemove(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!confirmRemove) return;
                if (confirmRemove.type === 'domain') handleRemoveDomain(confirmRemove.id);
                else handleRemoveSite(confirmRemove.id);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
