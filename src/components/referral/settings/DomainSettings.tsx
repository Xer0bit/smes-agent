import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, Globe, Copy, ExternalLink, CheckCircle2, AlertCircle, Clock, Zap, Trash2, TriangleAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { domainService } from '@/eCG/Publish';
import type { ProjectSubdomain, ProjectCustomDomain, DomainStatus } from '@/eCG/Publish/types';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { supabase } from '@/integrations/supabase/client';
import { SettingsSkeleton } from './SettingsSkeleton';

interface DomainSettingsProps {
  projectId: string;
  projectName: string;
  organizationId: string | null;
  workspaceFiles?: { path: string; content: string }[];
}

const STATUS_CONFIG: Record<DomainStatus, { label: string; icon: any; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending_dns: { label: 'Pending DNS', icon: Clock, variant: 'secondary' },
  verifying: { label: 'Verifying', icon: Loader2, variant: 'default' },
  active: { label: 'Active', icon: CheckCircle2, variant: 'default' },
  failed: { label: 'Failed', icon: AlertCircle, variant: 'destructive' },
  inactive: { label: 'Inactive', icon: AlertCircle, variant: 'outline' },
};

function buildPublishSlug(projectName: string, projectId: string): string {
  const normalized = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  if (normalized.length >= 3) {
    return normalized;
  }

  return `project-${projectId.slice(0, 8).toLowerCase()}`;
}

export function DomainSettings({ projectId, projectName, organizationId, workspaceFiles = [] }: DomainSettingsProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [subdomain, setSubdomain] = useState<ProjectSubdomain | null>(null);
  const [customDomains, setCustomDomains] = useState<ProjectCustomDomain[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [addingDomain, setAddingDomain] = useState(false);
  const [attachingDomain, setAttachingDomain] = useState<string | null>(null);
  const [orgDomains, setOrgDomains] = useState<Array<{ id: string; domain: string; status: DomainStatus; project_name: string }>>([]);
  const [publishingSubdomain, setPublishingSubdomain] = useState(false);
  const [verifyingDomain, setVerifyingDomain] = useState<string | null>(null);
  const [publishingDomain, setPublishingDomain] = useState<string | null>(null);
  const [showDnsConfig, setShowDnsConfig] = useState<string | null>(null);
  const [hostingIp, setHostingIp] = useState<string | null>(null);
  const [removingDomain, setRemovingDomain] = useState<string | null>(null);
  const [domainToRemove, setDomainToRemove] = useState<ProjectCustomDomain | null>(null);
  const [dnsCheckResults, setDnsCheckResults] = useState<Record<string, {
    pointingOk?: boolean;
    txtOk?: boolean;
    cloudflare_proxied?: boolean;
    detail?: {
      a_record?: { expected: string; found: string[]; ok: boolean; cloudflare_proxied?: boolean };
      cname_record?: { expected: string; found: string[]; ok: boolean; cloudflare_proxied?: boolean };
      txt_record?: { expected: string; host: string; found: string[]; ok: boolean };
    };
    error?: string;
    checkedAt?: string;
  }>>({}); 
  
  const { limits, loading: billingLoading, hasFeature } = useSubscription();
  const planTier = limits?.plan_tier || 'free';
  const canUseHosting = hasFeature('hosting');
  const canAddCustomDomain = canUseHosting && hasFeature('custom_domains');

  useEffect(() => {
    loadDomains();
    // Fetch the hosting node's public IP for DNS config display
    domainService.getDomainConfiguration('probe.test').then(cfg => {
      const ip = cfg.a_record?.value;
      if (ip && !ip.startsWith('(')) {
        setHostingIp(ip);
      }
    }).catch(() => {});
  }, [projectId]);

  // Auto-poll DNS verification every 60s for any pending/verifying domains.
  // When DNS propagates and verifies, auto-activate without user needing to click.
  useEffect(() => {
    const pendingDomains = customDomains.filter(
      d => d.status === 'pending_dns' || d.status === 'verifying'
    );
    if (pendingDomains.length === 0) return;

    const intervalId = setInterval(async () => {
      for (const domain of pendingDomains) {
        try {
          const result = await domainService.verifyDomainDNS(projectId, domain.domain);
          setDnsCheckResults(prev => ({
            ...prev,
            [domain.id]: {
              pointingOk: result.pointingOk,
              txtOk: result.txtOk,
              cloudflare_proxied: result.cloudflare_proxied,
            },
          }));

          if (result.verified) {
            // Auto-deploy files then activate
            const slug = buildPublishSlug(projectName, projectId);
            const deploy = await domainService.deployToHosting(projectId, slug, workspaceFiles);
            const activation = deploy.success
              ? await domainService.activateCustomDomain(domain.domain, projectId)
              : { success: false, error: deploy.error };

            if (!deploy.success || !activation.success) {
              await supabase
                .from('project_custom_domains')
                .update({
                  status: 'failed',
                  hosting_active: false,
                  last_dns_check: new Date().toISOString(),
                })
                .eq('id', domain.id);
              toast({
                title: 'Domain Ready but Publish Failed',
                description: activation.error || deploy.error || 'Could not publish this domain to production',
                variant: 'destructive',
              });
              await loadDomains();
              continue;
            }
            await supabase
              .from('project_custom_domains')
              .update({
                status: 'active',
                verified_at: new Date().toISOString(),
                dns_verified_at: new Date().toISOString(),
                hosting_active: true,
                last_dns_check: new Date().toISOString(),
              })
              .eq('id', domain.id);
            // Sync custom domain URL into projects table so Editor publish panel shows correct URL
            await supabase
              .from('projects')
              .update({
                published_url: `https://${domain.domain}`,
                published_at: new Date().toISOString(),
              })
              .eq('id', projectId);
            toast({
              title: 'Domain Activated!',
              description: `${domain.domain} is now live with your project`,
            });
            await loadDomains();
          } else {
            await supabase
              .from('project_custom_domains')
              .update({ last_dns_check: new Date().toISOString() })
              .eq('id', domain.id);
          }
        } catch { /* silent — retry next interval */ }
      }
    }, 60000);

    return () => clearInterval(intervalId);
  }, [customDomains, projectId]);

  const loadDomains = async () => {
    try {
      setLoading(true);

      const { subdomain: publishedSubdomain } = await domainService.getProjectDomains(projectId);

      let subdomainData = publishedSubdomain;
      if (!subdomainData) {
        const { data: legacySubdomainData } = await supabase
          .from('project_subdomains')
          .select('*')
          .eq('project_id', projectId)
          .maybeSingle();
        subdomainData = legacySubdomainData;
      }
      
      const { data: customDomainsData } = await supabase
        .from('project_custom_domains')
        .select('*')
        .eq('project_id', projectId);
      
      setSubdomain(subdomainData);
      setCustomDomains(customDomainsData || []);

      // Load all custom domains across the org so user can re-use them with one click
      if (organizationId) {
        const { data: orgDomainsRaw } = await supabase
          .from('project_custom_domains')
          .select('id, domain, status, project_id, projects!inner(name, organization_id)')
          .filter('projects.organization_id', 'eq', organizationId)
          .neq('project_id', projectId);

        const alreadyHere = new Set((customDomainsData || []).map(d => d.domain));
        const seen = new Set<string>();
        const deduped = (orgDomainsRaw || [])
          .filter((d: any) => {
            const proj = Array.isArray(d.projects) ? d.projects[0] : d.projects;
            if (!proj || alreadyHere.has(d.domain) || seen.has(d.domain)) return false;
            seen.add(d.domain);
            return true;
          })
          .map((d: any) => {
            const proj = Array.isArray(d.projects) ? d.projects[0] : d.projects;
            return { id: d.id, domain: d.domain, status: d.status as DomainStatus, project_name: proj?.name || 'Unknown' };
          });
        setOrgDomains(deduped);
      }
    } catch (error) {
      console.error('Error loading domains:', error);
      toast({
        title: 'Error',
        description: 'Failed to load domain settings',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePublishSubdomain = async () => {
    try {
      setPublishingSubdomain(true);

      if (workspaceFiles.length === 0) {
        throw new Error('No project files are loaded yet. Open the editor and wait for the workspace to finish loading, then publish again.');
      }

      const subdomainName = buildPublishSlug(projectName, projectId);
      const publishedSubdomain = await domainService.createSubdomain(projectId, subdomainName, workspaceFiles);

      const { error } = await supabase
        .from('projects')
        .update({
          status: 'active',
          published_subdomain: publishedSubdomain.subdomain,
          published_url: `https://${publishedSubdomain.full_domain}`,
          published_at: new Date().toISOString(),
        })
        .eq('id', projectId);

      if (error) throw error;

      setSubdomain(publishedSubdomain);
      
      toast({
        title: 'Subdomain Published',
        description: `Your site is live at https://${publishedSubdomain.full_domain}`,
      });
    } catch (error: any) {
      console.error('Error publishing subdomain:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to publish subdomain',
        variant: 'destructive',
      });
    } finally {
      setPublishingSubdomain(false);
    }
  };

  const handleAddCustomDomain = async () => {
    if (!newDomain.trim()) return;
    await attachDomain(newDomain.trim());
  };

  const handleAttachOrgDomain = async (domain: string) => {
    setAttachingDomain(domain);
    await attachDomain(domain);
    setAttachingDomain(null);
  };

  const attachDomain = async (domainName: string) => {
    try {
      setAddingDomain(true);

      // Check if domain already exists for this project
      const { data: existing } = await supabase
        .from('project_custom_domains')
        .select('id')
        .eq('domain', domainName)
        .eq('project_id', projectId)
        .maybeSingle();

      if (existing) {
        toast({
          title: 'Domain already added',
          description: `${domainName} is already configured for this project.`,
          variant: 'destructive',
        });
        return;
      }
      
      const config = await domainService.getDomainConfiguration(domainName);
      
      // Store the A record value (for both apex and subdomain)
      const dnsRecordValue = config.a_record?.value ?? '';

      const { data, error } = await supabase
        .from('project_custom_domains')
        .insert({
          project_id: projectId,
          domain: domainName,
          status: 'pending_dns',
          dns_a_record: dnsRecordValue,
          dns_txt_record: config.txt_record.value,
        })
        .select()
        .single();
      
      if (error) {
        // Unique constraint — domain in use by another project
        if (error.code === '23505') {
          toast({
            title: 'Domain already in use',
            description: `${domainName} is already connected to another project.`,
            variant: 'destructive',
          });
          return;
        }
        throw error;
      }
      
      setCustomDomains(prev => [...prev, data]);
      setNewDomain('');
      setShowDnsConfig(data.id);
      // Remove from the org quick-pick list since it's now attached here
      setOrgDomains(prev => prev.filter(d => d.domain !== domainName));
      
      toast({
        title: 'Custom Domain Added',
        description: 'Please configure your DNS records',
      });
    } catch (error: any) {
      console.error('Error adding custom domain:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to add custom domain',
        variant: 'destructive',
      });
    } finally {
      setAddingDomain(false);
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    try {
      setVerifyingDomain(domainId);

      const domain = customDomains.find(d => d.id === domainId);
      if (!domain) return;

      const result = await domainService.verifyDomainDNS(domain.domain);

      // Store granular DNS check results so the UI can show per-record status
      setDnsCheckResults(prev => ({
        ...prev,
        [domainId]: {
          pointingOk: result.pointingOk,
          txtOk: result.txtOk,
          cloudflare_proxied: result.cloudflare_proxied,
          detail: result.detail,
          error: result.error,
          checkedAt: new Date().toISOString(),
        },
      }));

      if (result.verified) {
        // DNS verified — deploy files to VPS4 then activate the domain in Caddy
        const slug = buildPublishSlug(projectName, projectId);
        const deploy = await domainService.deployToHosting(projectId, slug, workspaceFiles);
        if (!deploy.success) {
          toast({
            title: 'DNS Verified but Deploy Failed',
            description: deploy.error || 'Could not deploy project files to hosting',
            variant: 'destructive',
          });
        }
        const activation = deploy.success
          ? await domainService.activateCustomDomain(domain.domain, projectId)
          : { success: false, error: deploy.error || 'Deploy failed' };
        if (!activation.success) {
          toast({
            title: 'DNS Verified but Activation Failed',
            description: activation.error || 'Could not activate domain on hosting service',
            variant: 'destructive',
          });
        }

        if (!deploy.success || !activation.success) {
          const { error } = await supabase
            .from('project_custom_domains')
            .update({
              status: 'failed',
              verified_at: null,
              dns_verified_at: new Date().toISOString(),
              hosting_active: false,
              last_dns_check: new Date().toISOString(),
            })
            .eq('id', domainId);

          if (error) throw error;
          await loadDomains();
          return;
        }

        // Sync custom domain URL into projects table so Editor publish panel shows correct URL
        await supabase
          .from('projects')
          .update({
            published_url: `https://${domain.domain}`,
            published_at: new Date().toISOString(),
          })
          .eq('id', projectId);
      }

      const { error } = await supabase
        .from('project_custom_domains')
        .update({
          status: result.status,
          verified_at: result.verified ? new Date().toISOString() : null,
          dns_verified_at: result.verified ? new Date().toISOString() : null,
          hosting_active: result.verified,
          last_dns_check: new Date().toISOString(),
        })
        .eq('id', domainId);

      if (error) throw error;

      await loadDomains();

      if (result.verified) {
        toast({
          title: 'Domain Verified & Published',
          description: `${domain.domain} is now live with your project files`,
        });
      } else {
        // Build a human-readable message showing which records are missing
        const missing: string[] = [];
        if (!result.pointingOk) {
          const rec = result.detail?.a_record || result.detail?.cname_record;
          missing.push(`${rec ? 'A' : 'A'} record not found`);
        }
        if (!result.txtOk) missing.push('TXT verification record not found');
        const detail = missing.length > 0 ? missing.join(' · ') : 'DNS records not detected yet';
        toast({
          title: 'DNS Not Ready Yet',
          description: result.error ? result.error : `${detail}. Propagation can take up to 48 hours.`,
          variant: 'destructive',
        });
      }
    } catch (error: any) {
      console.error('Error verifying domain:', error);
      toast({
        title: 'Error',
        description: 'Failed to verify domain',
        variant: 'destructive',
      });
    } finally {
      setVerifyingDomain(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: 'Copied',
      description: 'Value copied to clipboard',
    });
  };

  const handlePublishToProduction = async (domainId: string) => {
    try {
      setPublishingDomain(domainId);
      const domain = customDomains.find(d => d.id === domainId);
      if (!domain) return;

      if (workspaceFiles.length === 0) {
        toast({
          title: 'No Project Files',
          description: 'Open the editor and wait for the workspace to finish loading, then try again.',
          variant: 'destructive',
        });
        return;
      }

      const slug = buildPublishSlug(projectName, projectId);
      const deploy = await domainService.deployToHosting(projectId, slug, workspaceFiles);
      if (!deploy.success) {
        throw new Error(deploy.error || 'Deploy failed');
      }

      toast({
        title: 'Published to Production',
        description: `${domain.domain} is now live with your latest project files`,
      });
    } catch (error: any) {
      toast({
        title: 'Publish Failed',
        description: error.message || 'Failed to publish to production',
        variant: 'destructive',
      });
    } finally {
      setPublishingDomain(null);
    }
  };

  const handleRemoveDomain = async () => {
    if (!domainToRemove) return;
    const { id: domainId, domain: domainName } = domainToRemove;
    setDomainToRemove(null);
    setRemovingDomain(domainId);
    try {
      // Remove from hosting service (best-effort — may not be activated yet)
      await domainService.removeHostingDomain(projectId, domainName);
      // Remove from DB
      const { error } = await supabase
        .from('project_custom_domains')
        .delete()
        .eq('id', domainId);
      if (error) throw error;
      setCustomDomains(prev => prev.filter(d => d.id !== domainId));
      setDnsCheckResults(prev => {
        const next = { ...prev };
        delete next[domainId];
        return next;
      });
      toast({ title: 'Domain Removed', description: `${domainName} has been disconnected.` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to remove domain', variant: 'destructive' });
    } finally {
      setRemovingDomain(null);
    }
  };

  if (loading || billingLoading) {
    return <SettingsSkeleton cards={2} />;
  }

  if (!canUseHosting) {
    return (
      <div className="space-y-6">
        <Card className="bg-workspace-surface border-indigo-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Domain Management — Plan Upgrade Required
            </CardTitle>
            <CardDescription>
              Upgrade from {planTier} to publish and manage project domains.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')} className="w-full">
              Manage Billing
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6">
      {/* Subdomain Section */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            eComGear Subdomain
          </CardTitle>
          <CardDescription>
            Free subdomain for your project under ecomgear.app
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {subdomain ? (
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1">
                <p className="font-medium">{subdomain.full_domain}</p>
                <div className="flex items-center gap-2">
                  {(() => {
                    const config = STATUS_CONFIG[subdomain.status];
                    const Icon = config.icon;
                    return (
                      <Badge variant={config.variant}>
                        <Icon className="h-3 w-3 mr-1" />
                        {config.label}
                      </Badge>
                    );
                  })()}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(`https://${subdomain.full_domain}`)}
                >
                  <Copy className="h-4 w-4 mr-1" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(`https://${subdomain.full_domain}`, '_blank')}
                >
                  <ExternalLink className="h-4 w-4 mr-1" />
                  Open
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-white/45 mb-4">
                No subdomain created yet. Click below to create one.
              </p>
              <Button onClick={handlePublishSubdomain} disabled={publishingSubdomain}>
                {publishingSubdomain && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create Subdomain
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Custom Domain Section */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Custom Domain
          </CardTitle>
          <CardDescription>
            {canAddCustomDomain 
              ? 'Add your own domain name'
              : 'Custom domains are available on Starter, Professional, and Enterprise plans'
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canAddCustomDomain ? (
            <Alert>
              <AlertDescription>
                Upgrade your plan to connect a custom domain.
                <Button variant="link" className="ml-2 p-0 h-auto" onClick={() => {
                  // Navigate to billing
                  toast({
                    title: 'Upgrade Required',
                    description: 'Please upgrade to a paid organization plan to use custom domains',
                  });
                }}>
                  Upgrade Now →
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {/* ── Quick-attach from other projects in the org ── */}
              {orgDomains.length > 0 && (
                <div className="rounded-lg border bg-white/[0.03] p-4 space-y-3 mb-2">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium">Available in your organization</p>
                  </div>
                  <div className="space-y-2">
                    {orgDomains.map(od => {
                      const cfg = STATUS_CONFIG[od.status];
                      const Icon = cfg.icon;
                      const isAttaching = attachingDomain === od.domain;
                      return (
                        <div key={od.id} className="flex items-center justify-between gap-3 bg-workspace-surface rounded-md px-3 py-2 border">
                          <div className="min-w-0">
                            <p className="text-sm font-mono truncate">{od.domain}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge variant={cfg.variant} className="text-[10px] h-4 px-1">
                                <Icon className="h-2.5 w-2.5 mr-0.5" />
                                {cfg.label}
                              </Badge>
                              <span className="text-[10px] text-white/45 truncate">from: {od.project_name}</span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            disabled={addingDomain || isAttaching}
                            onClick={() => handleAttachOrgDomain(od.domain)}
                          >
                            {isAttaching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Use this domain'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Input
                  placeholder="example.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddCustomDomain()}
                />
                <Button onClick={handleAddCustomDomain} disabled={addingDomain || !newDomain.trim()}>
                  {addingDomain && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Add Domain
                </Button>
              </div>

              {customDomains.length > 0 && (
                <div className="space-y-4 mt-4">
                  {customDomains.map((domain) => {
                    const config = STATUS_CONFIG[domain.status];
                    const Icon = config.icon;
                    const showDns = showDnsConfig === domain.id || domain.status !== 'active';
                    
                    return (
                      <div key={domain.id} className="border rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <p className="font-medium">{domain.domain}</p>
                            <Badge variant={config.variant}>
                              <Icon className="h-3 w-3 mr-1" />
                              {config.label}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            {domain.status === 'active' && (
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => handlePublishToProduction(domain.id)}
                                disabled={publishingDomain === domain.id}
                              >
                                {publishingDomain === domain.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                Publish to Production
                              </Button>
                            )}
                            <Button
                              size="sm"
                              onClick={() => handleVerifyDomain(domain.id)}
                              disabled={verifyingDomain === domain.id || removingDomain === domain.id}
                            >
                              {verifyingDomain === domain.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                              {domain.status === 'pending_dns' ? 'Done - Verify DNS' : 'Re-verify'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => setDomainToRemove(domain)}
                              disabled={removingDomain === domain.id}
                              title="Remove domain"
                            >
                              {removingDomain === domain.id
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Trash2 className="h-4 w-4" />}
                            </Button>
                          </div>
                        </div>

                        {showDns && (() => {
                          // Detect if this is a subdomain (3+ parts) or apex (2 parts)
                          const parts = domain.domain.split('.');
                          const isApex = parts.length <= 2;
                          const hostPart = isApex ? '@' : parts.slice(0, parts.length - 2).join('.');
                          const txtHost = isApex ? '_ecomgear-verify' : `_ecomgear-verify.${hostPart}`;
                          const checkResult = dnsCheckResults[domain.id];

                          return (
                            <div className="bg-white/[0.04] rounded-lg p-4 space-y-4">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium">DNS Configuration</p>
                                <Badge variant="outline" className="text-[10px]">
                                  {isApex ? 'Root domain' : 'Subdomain'}
                                </Badge>
                              </div>

                              {/* Step 1: Point domain */}
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-medium text-white/45">
                                    Step 1 — Point your domain to eCOMGear
                                  </p>
                                  {checkResult && (
                                    checkResult.pointingOk
                                      ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                                      : <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                                  )}
                                </div>
                                <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2 items-center text-sm">
                                  <span className="font-mono font-medium">A</span>
                                  <div className="flex items-center gap-1 min-w-0">
                                    <span className="font-mono text-white/45 truncate">{hostPart}</span>
                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" title="Copy host" onClick={() => copyToClipboard(hostPart)}>
                                      <Copy className="h-3 w-3" />
                                    </Button>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <code className="bg-workspace-surface px-2 py-1 rounded text-xs truncate max-w-[200px]">
                                      {hostingIp || domain.dns_a_record}
                                    </code>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => copyToClipboard(hostingIp || domain.dns_a_record || '')}
                                    >
                                      <Copy className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                                {checkResult && !checkResult.pointingOk && (() => {
                                  const rec = checkResult.detail?.a_record || checkResult.detail?.cname_record;
                                  if (checkResult.cloudflare_proxied || rec?.cloudflare_proxied) {
                                    return (
                                      <div className="flex items-start gap-1.5 mt-1 p-2 rounded bg-orange-500/10 border border-orange-500/30">
                                        <TriangleAlert className="h-3.5 w-3.5 text-orange-500 shrink-0 mt-0.5" />
                                        <p className="text-[11px] text-orange-600 dark:text-orange-400">
                                          <strong>Cloudflare proxy detected.</strong> In your Cloudflare DNS dashboard, set the A record to <strong>DNS only</strong> (gray cloud icon) instead of Proxied (orange cloud). Then click Verify DNS again.
                                        </p>
                                      </div>
                                    );
                                  }
                                  return rec && rec.found.length > 0 ? (
                                    <p className="text-[11px] text-destructive">
                                      Found: {rec.found.join(', ')} — expected: {rec.expected}
                                    </p>
                                  ) : (
                                    <p className="text-[11px] text-white/45">No A record found yet</p>
                                  );
                                })()}
                              </div>

                              {/* Step 2: Verify ownership */}
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-medium text-white/45">
                                    Step 2 — Verify domain ownership
                                  </p>
                                  {checkResult && (
                                    checkResult.txtOk
                                      ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                                      : <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                                  )}
                                </div>
                                <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2 items-center text-sm">
                                  <span className="font-mono font-medium">TXT</span>
                                  <div className="flex items-center gap-1 min-w-0">
                                    <span className="font-mono text-white/45 truncate">{txtHost}</span>
                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" title="Copy host" onClick={() => copyToClipboard(txtHost)}>
                                      <Copy className="h-3 w-3" />
                                    </Button>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <code className="bg-workspace-surface px-2 py-1 rounded text-xs truncate max-w-[200px]">{domain.dns_txt_record}</code>
                                    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(domain.dns_txt_record || '')}>
                                      <Copy className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                                {checkResult && !checkResult.txtOk && (() => {
                                  const rec = checkResult.detail?.txt_record;
                                  return rec && rec.found.length > 0 ? (
                                    <p className="text-[11px] text-destructive">
                                      Found: {rec.found.join(', ')} — expected: {rec.expected}
                                    </p>
                                  ) : (
                                    <p className="text-[11px] text-white/45">TXT record not found yet — add it at your DNS provider</p>
                                  );
                                })()}
                              </div>

                              {checkResult?.checkedAt && (
                                <p className="text-[11px] text-white/45">
                                  Last checked: {new Date(checkResult.checkedAt).toLocaleTimeString()} · Auto-rechecks every 60s
                                </p>
                              )}

                              <p className="text-xs text-white/45">
                                Add both records at your domain provider (Cloudflare, Namecheap, etc).
                                DNS propagation can take up to 48 hours. Click <strong>Verify DNS</strong> to check immediately.
                              </p>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>

    {/* Remove domain confirmation dialog */}
    <AlertDialog open={!!domainToRemove} onOpenChange={(open) => { if (!open) setDomainToRemove(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove Custom Domain</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to remove <strong>{domainToRemove?.domain}</strong>?
            This will disconnect it from your project and delete it from the hosting service.
            You can re-add it at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={handleRemoveDomain}
          >
            Remove Domain
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
