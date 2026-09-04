/**
 * Domain Service - Publish Module
 * Connects to the preview-service publish endpoints.
 */

import type {
  DomainConfiguration,
  DomainStatus,
  ProjectSubdomain,
  ProjectCustomDomain,
  PublishRequest,
  PublishResponse,
} from './types';

const rawPreviewUrl = import.meta.env.VITE_PREVIEW_SERVICE_URL || '';
const PREVIEW_BASE = rawPreviewUrl.replace(/\/$/, '');

const rawHostingUrl = import.meta.env.VITE_HOSTING_SERVICE_URL || '';
const HOSTING_BASE = rawHostingUrl.replace(/\/$/, '');

// Domain/deploy operations that need VITE_HOSTING_SERVICE_SECRET now go through
// the API server's /api/v1/hosting proxy instead of hitting HOSTING_BASE
// directly   Vite bundles VITE_-prefixed vars into the public JS, so the
// secret used to be extractable from the built output. The proxy holds the
// secret server-side and checks project ownership / admin role instead.
async function apiAuthHeaders(): Promise<HeadersInit> {
  const { lovableCloud } = await import('@/integrations/supabase/client');
  const { data: { session } } = await lovableCloud.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['Authorization'] = `Bearer ${session.access_token}`;
  return headers;
}

async function hostingProxyUrl(path: string): Promise<string> {
  // /api/v1/hosting only runs on the API server (VPS1, SERVICE_ROLE=api)   NOT
  // the gen server (VPS3, SERVICE_ROLE=gen only mounts /api/v1/ai).
  const { getApiServerUrl } = await import('@/config/external-api');
  return getApiServerUrl(`/api/v1/hosting${path}`);
}

// Hosting node IP is fetched dynamically from the hosting-service /config endpoint.
// Cached after first fetch so the DNS config UI doesn't need repeated calls.
let _hostingPublicIp: string | null = null;
let _hostingIpFetched = false;

async function getHostingPublicIp(): Promise<string> {
  if (_hostingIpFetched && _hostingPublicIp) return _hostingPublicIp;
  if (!HOSTING_BASE) return '';
  try {
    const res = await fetch(`${HOSTING_BASE}/config`);
    if (res.ok) {
      const data = await res.json();
      _hostingPublicIp = data.publicIp || '';
      _hostingIpFetched = true;
    }
  } catch { /* silent   will retry next call */ }
  return _hostingPublicIp || '';
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function previewHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' };
}

class DomainService {
  /**
   * Check whether a slug is available on the publish server.
   */
  async checkSubdomainAvailability(slug: string, projectId?: string): Promise<{ available: boolean; reason?: string }> {
    if (!PREVIEW_BASE) return { available: false, reason: 'Preview server not configured' };
    const normalised = slug.toLowerCase().trim();
    try {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const res = await fetch(`${PREVIEW_BASE}/check-subdomain/${encodeURIComponent(normalised)}${qs}`);
      if (!res.ok) return { available: false, reason: `Server error ${res.status}` };
      return res.json();
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : 'Network error' };
    }
  }


  async getDomainConfiguration(domain: string): Promise<DomainConfiguration> {
    const hostingIp = await getHostingPublicIp();
    const verifyToken = `ecg_${btoa(domain).slice(0, 16)}`;
    // Apex domain = exactly 2 parts (e.g. example.com).
    // Subdomain = 3+ parts (e.g. shop.example.com, www.example.com).
    const parts = domain.split('.');
    const isApex = parts.length <= 2;

    if (isApex) {
      return {
        a_record: { type: 'A', host: '@', value: hostingIp || '(configure HOSTING_PUBLIC_IP on hosting node)' },
        cname_record: undefined,
        txt_record: { type: 'TXT', host: '_SMEsAgent-verify', value: verifyToken },
        is_apex: true,
      };
    }
    // Subdomain   A record pointing directly to the hosting node IP.
    // (Previously used CNAME → hosting.SMEsAgent.app, but that resolves to
    // VPS2/preview which runs nginx, causing 404 for custom domains.)
    const hostPart = parts.slice(0, parts.length - 2).join('.');
    return {
      a_record: { type: 'A', host: hostPart, value: hostingIp || '(configure HOSTING_PUBLIC_IP on hosting node)' },
      cname_record: undefined,
      txt_record: { type: 'TXT', host: `_SMEsAgent-verify.${hostPart}`, value: verifyToken },
      is_apex: false,
    };
  }

  /**
   * Verify domain DNS records via the VPS4 hosting service.
   * Returns detailed per-record check results so the UI can show exactly what's missing.
   */
  async verifyDomainDNS(projectId: string, domain: string): Promise<{
    verified: boolean;
    status: DomainStatus;
    pointingOk?: boolean;
    txtOk?: boolean;
    cloudflare_proxied?: boolean;
    detail?: {
      a_record?: { expected: string; found: string[]; ok: boolean; cloudflare_proxied?: boolean };
      cname_record?: { expected: string; found: string[]; ok: boolean; cloudflare_proxied?: boolean };
      txt_record?: { expected: string; host: string; found: string[]; ok: boolean };
    };
    error?: string;
  }> {
    if (!HOSTING_BASE) return { verified: false, status: 'pending_dns', error: 'Hosting service not configured' };
    try {
      const res = await fetch(await hostingProxyUrl(`/${projectId}/verify-domain`), {
        method: 'POST',
        headers: await apiAuthHeaders(),
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) return { verified: false, status: 'pending_dns', error: `Hosting service error ${res.status}` };
      const data = await res.json();
      const pointingOk = data.a_record?.ok || data.cname_record?.ok || false;
      const txtOk = data.txt_record?.ok || false;
      return {
        verified: data.verified === true,
        status: data.verified ? 'active' : 'pending_dns',
        pointingOk,
        txtOk,
        cloudflare_proxied: data.cloudflare_proxied === true,
        detail: {
          a_record: data.a_record,
          cname_record: data.cname_record,
          txt_record: data.txt_record,
        },
      };
    } catch (e) {
      return { verified: false, status: 'pending_dns', error: e instanceof Error ? e.message : 'Network error' };
    }
  }

  /**
   * Publish to a subdomain on the China server.
   */
  async createSubdomain(
    projectId: string,
    slug: string,
    files: { path: string; content: string }[],
  ): Promise<ProjectSubdomain> {
    if (!PREVIEW_BASE) throw new Error('Preview service URL (VITE_PREVIEW_SERVICE_URL) not configured');

    const res = await fetch(`${PREVIEW_BASE}/publish/${projectId}`, {
      method: 'POST',
      headers: previewHeaders(),
      body: JSON.stringify({ files, slug }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Publish failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const publishedUrl = data.publishedUrl || `${PREVIEW_BASE}/p/${data.slug}`;

    // Persist to published_versions in DB
    const { supabase } = await import('@/integrations/supabase/client');
    const { error } = await supabase.from('published_versions').upsert(
      {
        project_id: projectId,
        subdomain: data.slug,
        deployment_url: publishedUrl,
        status: 'published',
        published_at: new Date().toISOString(),
      },
      { onConflict: 'subdomain' }
    );

    if (error) {
      throw new Error(`Failed to persist publish state: ${error.message}`);
    }

    return {
      id: `sub_${Date.now()}`,
      project_id: projectId,
      subdomain: data.slug,
      full_domain: stripProtocol(`${PREVIEW_BASE}/p/${data.slug}`),
      is_primary: true,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Add custom domain (Pro/Agency only)   placeholder.
   */
  async addCustomDomain(projectId: string, domain: string): Promise<ProjectCustomDomain> {
    const config = await this.getDomainConfiguration(domain);
    return {
      id: `cd_${Date.now()}`,
      project_id: projectId,
      domain,
      status: 'pending_dns',
      dns_a_record: config.a_record.value,
      dns_txt_record: config.txt_record.value,
      ssl_status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Get project domains from DB via Supabase.
   */
  async getProjectDomains(
    projectId: string,
  ): Promise<{ subdomain: ProjectSubdomain | null; customDomains: ProjectCustomDomain[] }> {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('published_versions')
      .select('id, project_id, subdomain, deployment_url, published_at')
      .eq('project_id', projectId)
      .eq('status', 'published')
      .not('subdomain', 'is', null)
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return { subdomain: null, customDomains: [] };

    // Also load custom domains from DB
    const { data: customDomainsData } = await supabase
      .from('project_custom_domains')
      .select('*')
      .eq('project_id', projectId);

    return {
      subdomain: {
        id: data.id,
        project_id: data.project_id,
        subdomain: data.subdomain!,
        full_domain: data.deployment_url
          ? stripProtocol(data.deployment_url)
          : `preview.SMEsAgent.app/p/${data.subdomain}`,
        is_primary: true,
        status: 'active',
        created_at: data.published_at || new Date().toISOString(),
        updated_at: data.published_at || new Date().toISOString(),
      },
      customDomains: customDomainsData || [],
    };
  }

  /**
   * Publish to subdomain or custom domain.
   */
  async publishToDomain(
    request: PublishRequest,
    files: { path: string; content: string }[],
  ): Promise<PublishResponse> {
    try {
      const sub = await this.createSubdomain(request.projectId, request.domain, files);
      return {
        success: true,
        publishedUrl: `${PREVIEW_BASE}/p/${sub.subdomain}`,
        domainStatus: 'active',
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : 'Publish failed',
        domainStatus: 'failed',
      };
    }
  }

  /**
   * Deploy the latest published build to VPS4 hosting service.
   * First exports a production build from VPS2, then deploys the built files to VPS4.
   */
  async deployToHosting(
    projectId: string,
    slug: string,
    _files: { path: string; content: string }[],
  ): Promise<{ success: boolean; hostingUrl?: string; error?: string }> {
    if (!HOSTING_BASE) return { success: false, error: 'Hosting service URL not configured' };
    if (!PREVIEW_BASE) return { success: false, error: 'Preview service URL not configured' };
    try {
      // Step 1: Export a production build from VPS2 (preview service).
      // /export now requires the caller's JWT (preview-service verifies
      // project access itself) rather than being open to anyone who knew the
      // project id.
      const { lovableCloud } = await import('@/integrations/supabase/client');
      const { data: { session } } = await lovableCloud.auth.getSession();
      const exportRes = await fetch(`${PREVIEW_BASE}/preview/${projectId}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
      });
      if (!exportRes.ok) {
        const text = await exportRes.text().catch(() => '');
        return { success: false, error: `Build export failed: ${exportRes.status} ${text}` };
      }
      const exportData = await exportRes.json();
      if (!exportData.success || !Array.isArray(exportData.files)) {
        return { success: false, error: exportData.error || 'Export returned no files' };
      }

      // Step 2: Deploy the built files to VPS4 (hosting service), via the API
      // server's proxy so the deploy secret never reaches the browser.
      const res = await fetch(await hostingProxyUrl(`/${projectId}/deploy`), {
        method: 'POST',
        headers: await apiAuthHeaders(),
        body: JSON.stringify({ files: exportData.files, slug }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Deploy failed: ${res.status} ${text}` };
      }
      const data = await res.json();
      return { success: true, hostingUrl: data.hostingUrl || undefined };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Deploy error' };
    }
  }

  /**
   * Activate a verified custom domain on the hosting Caddy node.
   */
  async activateCustomDomain(
    domain: string,
    projectId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!HOSTING_BASE) return { success: false, error: 'Hosting service URL not configured' };
    try {
      const res = await fetch(await hostingProxyUrl(`/${projectId}/activate-domain`), {
        method: 'POST',
        headers: await apiAuthHeaders(),
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Activation failed: ${res.status} ${text}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Activation error' };
    }
  }

  /**
   * Get hosting service health + config (admin panel only).
   */
  async getHostingHealth(): Promise<{
    status: string;
    node: string;
    publicIp: string | null;
    sites: number;
    domains: number;
    uptime: number;
  } | null> {
    if (!HOSTING_BASE) return null;
    try {
      const res = await fetch(await hostingProxyUrl('/admin/health'), { headers: await apiAuthHeaders() });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /**
   * List all active domain mappings from the hosting service (admin panel only).
   */
  async listHostingDomains(): Promise<{ domains: { domain: string; projectId: string }[]; error?: string }> {
    if (!HOSTING_BASE) return { domains: [], error: 'Hosting service URL not configured' };
    try {
      const res = await fetch(await hostingProxyUrl('/admin/domains'), { headers: await apiAuthHeaders() });
      if (res.status === 401 || res.status === 403) {
        return { domains: [], error: 'Not authorized as admin.' };
      }
      if (!res.ok) {
        return { domains: [], error: `Hosting service error: ${res.status}` };
      }
      const data = await res.json();
      return { domains: data.domains || [], error: data.error };
    } catch (e: any) {
      return { domains: [], error: e?.message || 'Failed to reach hosting service' };
    }
  }

  /**
   * Remove a domain from a project's own custom-domain list (project owner only).
   */
  async removeHostingDomain(projectId: string, domain: string): Promise<{ success: boolean; error?: string }> {
    if (!HOSTING_BASE) return { success: false, error: 'Hosting service URL not configured' };
    try {
      const res = await fetch(await hostingProxyUrl(`/${projectId}/domain/${encodeURIComponent(domain)}`), {
        method: 'DELETE',
        headers: await apiAuthHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Remove failed: ${res.status} ${text}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Remove error' };
    }
  }

  /**
   * Remove any domain mapping from the hosting service (admin panel only  
   * no project-ownership check, gated by admin role server-side instead).
   */
  async adminRemoveHostingDomain(domain: string): Promise<{ success: boolean; error?: string }> {
    if (!HOSTING_BASE) return { success: false, error: 'Hosting service URL not configured' };
    try {
      const res = await fetch(await hostingProxyUrl(`/admin/domains/${encodeURIComponent(domain)}`), {
        method: 'DELETE',
        headers: await apiAuthHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Remove failed: ${res.status} ${text}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Remove error' };
    }
  }

  /**
   * Remove a deployed project from the hosting service (admin panel only  
   * no project-ownership check, gated by admin role server-side instead).
   */
  async removeHostingDeployment(projectId: string): Promise<{ success: boolean; error?: string }> {
    if (!HOSTING_BASE) return { success: false, error: 'Hosting service URL not configured' };
    try {
      const res = await fetch(await hostingProxyUrl(`/admin/deployment/${projectId}`), {
        method: 'DELETE',
        headers: await apiAuthHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Remove failed: ${res.status} ${text}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Remove error' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-Server Tenant Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get available hosting servers (online + has capacity).
   */
  async getAvailableServers(): Promise<{
    id: string;
    name: string;
    public_ip: string;
    region: string;
    capacity_used: number;
    capacity_total: number;
  }[]> {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('hosting_servers')
      .select('id, name, public_ip, region, capacity_used, capacity_total, api_port')
      .eq('status', 'online')
      .order('capacity_used', { ascending: true });

    return ((data as any[]) || []).filter(
      (s: any) => s.capacity_used < s.capacity_total
    );
  }

  /**
   * Pick a server using round-robin (least-loaded).
   */
  async pickServer(): Promise<{ id: string; name: string; public_ip: string; api_port: number; api_key: string | null } | null> {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('hosting_servers')
      .select('id, name, public_ip, api_port, api_key, capacity_used, capacity_total')
      .eq('status', 'online')
      .order('capacity_used', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data as any;
  }

  /**
   * Provision a tenant on a hosting server.
   * Creates Docker stack (Postgres + PostgREST + Edge Runtime).
   */
  async provisionTenant(
    projectId: string,
    serverId: string,
    subdomain?: string,
  ): Promise<{ success: boolean; domain?: string; ports?: any; error?: string }> {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data: server } = await supabase
      .from('hosting_servers')
      .select('id, name, public_ip, api_port, api_key')
      .eq('id', serverId)
      .maybeSingle();
    if (!server) return { success: false, error: 'Server not found' };

    const srv = server as any;
    try {
      const url = `http://${srv.public_ip}:${srv.api_port}/tenants/provision`;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (srv.api_key) headers['Authorization'] = `Bearer ${srv.api_key}`;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectId, subdomain }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Provision failed: ${res.status} ${text}` };
      }
      const data = await res.json();

      // Save deployment record in DB
      await supabase.from('tenant_deployments').upsert({
        project_id: projectId,
        hosting_server_id: serverId,
        status: 'running',
        postgres_port: data.ports?.postgres,
        postgrest_port: data.ports?.postgrest,
        edge_runtime_port: data.ports?.edge,
        db_name: data.dbName,
        subdomain: data.domain,
        container_ids: data.containerIds || {},
        deployed_at: new Date().toISOString(),
      } as any, { onConflict: 'project_id' });

      // Increment server capacity
      try {
        await supabase.rpc('increment_capacity_used', { server_id: serverId } as any);
      } catch {
        // Fallback: manual increment if rpc doesn't exist
        await supabase.from('hosting_servers')
          .update({ capacity_used: (srv as any).capacity_used + 1 } as any)
          .eq('id', serverId);
      }

      return { success: true, domain: data.domain, ports: data.ports };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Provision error' };
    }
  }

  /**
   * Deploy app files to an existing tenant.
   */
  async deployToTenant(
    projectId: string,
    files: { path: string; content: string }[],
    edgeFunctions?: { name: string; code: string }[],
  ): Promise<{ success: boolean; error?: string }> {
    const { supabase } = await import('@/integrations/supabase/client');

    // Look up the deployment + server
    const { data: dep } = await supabase
      .from('tenant_deployments')
      .select('hosting_server_id')
      .eq('project_id', projectId)
      .maybeSingle();
    if (!dep) return { success: false, error: 'No tenant deployment for this project' };

    const { data: server } = await supabase
      .from('hosting_servers')
      .select('public_ip, api_port, api_key')
      .eq('id', (dep as any).hosting_server_id)
      .maybeSingle();
    if (!server) return { success: false, error: 'Server not found' };

    const srv = server as any;
    try {
      const url = `http://${srv.public_ip}:${srv.api_port}/tenants/${projectId}/deploy`;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (srv.api_key) headers['Authorization'] = `Bearer ${srv.api_key}`;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files, edgeFunctions }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Deploy failed: ${res.status} ${text}` };
      }

      // Update last_deploy_at
      await supabase.from('tenant_deployments')
        .update({ last_deploy_at: new Date().toISOString() } as any)
        .eq('project_id', projectId);

      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Deploy error' };
    }
  }

  /**
   * Get tenant deployment status.
   */
  async getTenantStatus(projectId: string): Promise<{
    exists: boolean;
    status?: string;
    domain?: string;
    serverId?: string;
  }> {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('tenant_deployments')
      .select('status, subdomain, custom_domain, hosting_server_id')
      .eq('project_id', projectId)
      .maybeSingle();

    if (!data) return { exists: false };
    const d = data as any;
    return {
      exists: true,
      status: d.status,
      domain: d.custom_domain || d.subdomain,
      serverId: d.hosting_server_id,
    };
  }
}

// Export singleton instance
export const domainService = new DomainService();

