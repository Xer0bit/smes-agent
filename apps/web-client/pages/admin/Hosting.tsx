import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/adminClient';
import { domainService } from '@/eCG/Publish';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Page, Stats, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';

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

interface CustomDomainRow {
  id: string;
  domain: string;
  status: string;
  ssl_status: string;
  hosting_active: boolean;
  verified_at: string | null;
  created_at: string;
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

interface PublishedRow { id: string; project_id: string; subdomain: string | null; deployment_url: string | null; published_at: string }
type Org = { name: string } | { name: string }[] | null;
const orgName = (o: Org): string | null => (Array.isArray(o) ? o[0]?.name ?? null : o?.name ?? null);
interface ProjectRow { id: string; name: string; organizations: Org }
interface DomainRow extends CustomDomainRow { project_id: string }

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'gray'> = {
  active: 'ok', pending_dns: 'warn', verifying: 'warn', failed: 'bad', inactive: 'gray',
};

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function AdminHosting() {
  const [health, setHealth] = useState<HostingHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [domains, setDomains] = useState<DomainMapping[]>([]);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [sites, setSites] = useState<LiveSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'domain' | 'site'; id: string; label: string } | null>(null);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      setHealth(await domainService.getHostingHealth());
    } catch {
      setHealth(null);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const loadSites = useCallback(async () => {
    setLoading(true);
    try {
      const { data: publishedData, error: pubErr } = await supabase
        .from('published_versions')
        .select('id, project_id, subdomain, deployment_url, published_at, status')
        .eq('status', 'published')
        .order('published_at', { ascending: false });
      if (pubErr) throw pubErr;

      const seen = new Set<string>();
      const published: PublishedRow[] = (publishedData ?? []).filter((p: PublishedRow) => {
        if (seen.has(p.project_id)) return false;
        seen.add(p.project_id);
        return true;
      });
      const projectIds = published.map((p) => p.project_id);

      const projectMap: Record<string, { name: string; org_name: string | null }> = {};
      const domainMap: Record<string, CustomDomainRow[]> = {};
      if (projectIds.length > 0) {
        const { data: projectData } = await supabase.from('projects').select('id, name, organizations(name)').in('id', projectIds);
        const projects: ProjectRow[] = projectData ?? [];
        for (const p of projects) projectMap[p.id] = { name: p.name, org_name: orgName(p.organizations) };

        const { data: domainData } = await supabase
          .from('project_custom_domains')
          .select('id, project_id, domain, status, ssl_status, hosting_active, verified_at, created_at')
          .in('project_id', projectIds);
        const domainRows: DomainRow[] = domainData ?? [];
        for (const d of domainRows) (domainMap[d.project_id] ??= []).push(d);
      }

      setSites(published.map((p) => ({
        id: p.id,
        project_id: p.project_id,
        project_name: projectMap[p.project_id]?.name ?? p.project_id.slice(0, 8),
        subdomain: p.subdomain,
        deployment_url: p.deployment_url,
        published_at: p.published_at,
        org_name: projectMap[p.project_id]?.org_name ?? null,
        custom_domains: domainMap[p.project_id] ?? [],
      })));

      const { domains: hostingDomains, error: hostingErr } = await domainService.listHostingDomains();
      setDomainsError(hostingErr ?? null);
      if (hostingErr) toast.error(`Domain mappings: ${hostingErr}`);
      setDomains(hostingDomains.map((d) => ({ ...d, projectName: projectMap[d.projectId]?.name ?? d.projectId.slice(0, 8) })));
    } catch (e) {
      console.error('Failed to load live sites:', e);
      toast.error('Failed to load hosting data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHealth(); loadSites(); }, [loadHealth, loadSites]);

  const reload = () => { loadHealth(); loadSites(); };

  const remove = async () => {
    if (!confirm) return;
    setBusy(confirm.id);
    try {
      const result = confirm.type === 'domain'
        ? await domainService.adminRemoveHostingDomain(confirm.id)
        : await domainService.removeHostingDeployment(confirm.id);
      if (!result.success) throw new Error(result.error);
      toast.success(confirm.type === 'domain' ? `Domain ${confirm.label} removed` : 'Deployment removed');
      await loadSites();
      await loadHealth();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Remove failed');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? sites.filter((s) =>
      s.project_name.toLowerCase().includes(needle) ||
      (s.subdomain ?? '').toLowerCase().includes(needle) ||
      (s.org_name ?? '').toLowerCase().includes(needle) ||
      s.custom_domains.some((d) => d.domain.toLowerCase().includes(needle)))
    : sites;

  return (
    <Page title="Hosting" actions={<button className={btn.ghost} onClick={reload}>Refresh</button>}>
      <Stats items={[
        { label: 'Node', value: healthLoading ? '...' : health ? health.node || 'Online' : 'Offline', tone: healthLoading ? undefined : health ? 'ok' : 'bad' },
        { label: 'Public IP', value: healthLoading ? '...' : health?.publicIp ?? '—' },
        { label: 'Sites', value: healthLoading ? '...' : health?.sites ?? sites.length },
        { label: 'Uptime', value: healthLoading ? '...' : health ? uptime(health.uptime) : '—' },
      ]} />

      <Panel title={`Domain mappings (${domains.length})`}>
        <Table head={['Domain', 'Project', '']} empty={domainsError ?? 'No active domain mappings'}>
          {domains.map((d) => (
            <tr key={d.domain}>
              <td className="font-mono">{d.domain}</td>
              <td>{d.projectName}</td>
              <td className="text-right">
                <a href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer" className={btn.ghost + ' inline-flex items-center mr-1'}>Open</a>
                <button className={btn.icon} disabled={busy === d.domain} onClick={() => setConfirm({ type: 'domain', id: d.domain, label: d.domain })}><Trash2 className="h-3.5 w-3.5" /></button>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel title={`Published sites (${sites.length})`} actions={<input className={input + ' w-56'} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <Table head={['Project', 'Organization', 'Subdomain', 'Custom domains', 'Published', '']} empty={loading ? 'Loading' : needle ? 'No matches' : 'No published sites'}>
          {filtered.map((s) => (
            <tr key={s.id}>
              <td className="text-white">{s.project_name}</td>
              <td className="text-gray-400">{s.org_name ?? '—'}</td>
              <td>
                {s.subdomain
                  ? <a href={s.deployment_url ?? `https://preview.ecomgear.app/p/${s.subdomain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-indigo-300 hover:underline">{s.subdomain}</a>
                  : '—'}
              </td>
              <td>
                {s.custom_domains.length === 0 ? '—' : s.custom_domains.map((cd) => (
                  <div key={cd.id} className="flex items-center gap-2">
                    <span className="font-mono">{cd.domain}</span>
                    <Tag tone={STATUS_TONE[cd.status] ?? 'gray'}>{cd.status}</Tag>
                    {cd.hosting_active && <Tag tone="ok">caddy</Tag>}
                  </div>
                ))}
              </td>
              <td className="text-gray-400">{when(s.published_at)}</td>
              <td className="text-right">
                {s.deployment_url && <a href={s.deployment_url} target="_blank" rel="noopener noreferrer" className={btn.ghost + ' inline-flex items-center mr-1'}>Open</a>}
                <button className={btn.icon} disabled={busy === s.project_id} onClick={() => setConfirm({ type: 'site', id: s.project_id, label: s.project_name })}><Trash2 className="h-3.5 w-3.5" /></button>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="bg-[#0d0f14] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Remove {confirm?.type === 'domain' ? 'domain' : 'deployment'} {confirm?.label}?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button className={btn.ghost} onClick={() => setConfirm(null)}>Cancel</button>
            <button className={btn.danger} disabled={busy !== null} onClick={remove}>Remove</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
