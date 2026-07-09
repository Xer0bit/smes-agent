import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ICPFilingForm } from "./ICPFilingForm";
import { SubscriptionContent } from "./SubscriptionContent";
import { UsageContent } from "./UsageContent";
import { PlanUsageContent } from "./PlanUsageContent";
import { CollaboratorManager } from "./CollaboratorManager";
import { ReferralContent } from "./ReferralContent";
import { DomainSettings } from "./DomainSettings";
import { SeoSettings } from "./SeoSettings";
import { HeaderIntegrationsSettings } from "./HeaderIntegrationsSettings";
import { GitHubSettings } from "./GitHubSettings";
import { DatabaseSettings } from "./DatabaseSettings";
import { KnowledgeSettings } from "./KnowledgeSettings";
import { SecretsSettings } from "./SecretsSettings";
import { Globe, Smartphone, CreditCard, ExternalLink } from "lucide-react";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useSubscription } from "@/contexts/SubscriptionContext";

interface SettingsContentProps {
  activeSection: string;
  projectId?: string;
  workspaceFiles?: { path: string; content: string }[];
}

export const SettingsContent = ({ activeSection, projectId, workspaceFiles = [] }: SettingsContentProps) => {
  const { hasFeature, tierLabel } = useSubscription();
  const [project, setProject] = useState<any>(null);
  const [projectName, setProjectName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projectVisibility, setProjectVisibility] = useState<'org_all' | 'org_restricted'>('org_all');
  const [savingProjectSettings, setSavingProjectSettings] = useState(false);

  useEffect(() => {
    if (projectId) {
      const fetchProject = async () => {
        const { data } = await supabase
          .from('projects')
          .select('id, name, slug, description, visibility, organization_id, created_at, message_count, updated_at')
          .eq('id', projectId)
          .single();
        setProject(data);
      };
      fetchProject();
    }
  }, [projectId]);

  useEffect(() => {
    if (!project) return;
    setProjectName(project.name || '');
    setProjectSlug(project.slug || '');
    setProjectDescription(project.description || '');
    setProjectVisibility(project.visibility || 'org_all');
  }, [project]);

  const handleSaveProjectSettings = async () => {
    if (!projectId) {
      toast.error('No project selected');
      return;
    }

    if (!projectName.trim()) {
      toast.error('Project name is required');
      return;
    }

    if (!projectSlug.trim()) {
      toast.error('Project slug is required');
      return;
    }

    setSavingProjectSettings(true);
    try {
      const normalizedSlug = projectSlug.trim().toLowerCase();
      const { error } = await supabase
        .from('projects')
        .update({
          name: projectName.trim(),
          slug: normalizedSlug,
          description: projectDescription.trim() || null,
          visibility: projectVisibility,
        })
        .eq('id', projectId);

      if (error) throw error;

      setProject((prev: any) => prev ? {
        ...prev,
        name: projectName.trim(),
        slug: normalizedSlug,
        description: projectDescription.trim(),
        visibility: projectVisibility,
      } : prev);
      toast.success('Project settings saved');
    } catch (error) {
      console.error('Failed to save project settings:', error);
      toast.error('Failed to save project settings');
    } finally {
      setSavingProjectSettings(false);
    }
  };

  const renderContent = () => {
    const renderPlanLocked = (title: string, description: string, featureKey: string) => {
      const enabled = hasFeature(featureKey);
      if (enabled) {
        return (
          <Card className="bg-[#0f0f12] border-white/[0.07]">
            <CardContent className="p-6">
              <p className="text-sm text-white/45">{title} configuration coming soon...</p>
            </CardContent>
          </Card>
        );
      }

      return (
        <Card className="bg-[#0f0f12] border-indigo-500/30">
          <CardHeader>
            <CardTitle className="text-base text-white/85">{title} — Paid Plan Feature</CardTitle>
            <CardDescription className="text-xs text-white/45">
              {description} Upgrade from {tierLabel} to unlock this feature.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')} className="w-full" size="sm">
              Manage Billing
            </Button>
          </CardContent>
        </Card>
      );
    };

    switch (activeSection) {
      case "ecomgear-database":
        return <DatabaseSettings organizationId={project?.organization_id ?? null} projectId={projectId} />;
        
      case "ecomgear-llm":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">LLM</h2>
              <p className="text-sm text-white/45">Configure large language model settings</p>
            </div>
            <Card className="bg-[#0f0f12] border-white/[0.07]">
              <CardContent className="p-6">
                <p className="text-sm text-white/45">LLM configuration coming soon...</p>
              </CardContent>
            </Card>
          </div>
        );
      
      case "china-icp":
        return <ICPFilingForm />;
        
      case "workspace-plans":
        return <PlanUsageContent />;

      case "workspace-analytics":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Analytics</h2>
              <p className="text-sm text-white/45">Monitor project insights and usage analytics.</p>
            </div>
            {renderPlanLocked('Analytics Dashboard', 'Advanced analytics is available on higher tiers.', 'analytics')}
          </div>
        );

      case "workspace-api-access":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">API Access</h2>
              <p className="text-sm text-white/45">Manage API keys and programmatic access.</p>
            </div>
            {renderPlanLocked('API Access', 'API access is restricted by plan tier.', 'api_access')}
          </div>
        );

      case "workspace-white-label":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">White-label</h2>
              <p className="text-sm text-white/45">Control branding and remove platform labels.</p>
            </div>
            {renderPlanLocked('White-label Controls', 'White-label and remove-branding controls are plan-gated.', 'remove_branding')}
          </div>
        );

      case "workspace-autopilot":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Autopilot</h2>
              <p className="text-sm text-white/45">Automate generation and optimization workflows.</p>
            </div>
            {renderPlanLocked('Autopilot', 'Autopilot workflows are available on higher tiers.', 'auto_pilot')}
          </div>
        );

      case "workspace-subscription":
        return <SubscriptionContent />;
        
      case "workspace-usage":
        return <UsageContent />;
        
      case "workspace-referrals":
        return <ReferralContent />;
        
      case "project-seo":
        return <SeoSettings projectId={projectId} />;

      case "project-integrations":
        return <HeaderIntegrationsSettings projectId={projectId} />;

      case "connector-github":
        return <GitHubSettings projectId={projectId} />;

      case "project-collaborators":
        return <CollaboratorManager projectId={projectId} />;
        
      case "project-knowledge":
        return <KnowledgeSettings projectId={projectId} />;

      case "project-secrets":
        return <SecretsSettings projectId={projectId} />;
        
      case "integrations-china":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">China Ecosystem</h2>
              <p className="text-sm text-white/45">Essential services for operating in mainland China market</p>
            </div>

            <div className="grid gap-4">
              {/* ICP Filing */}
              <Card className="bg-[#0f0f12] border-white/[0.07]">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-primary" />
                      <CardTitle className="text-base text-white/85">.cn ICP Filing</CardTitle>
                    </div>
                    <Badge className="bg-secondary/20 text-secondary">APPLY</Badge>
                  </div>
                  <CardDescription className="text-xs text-white/45">
                    Required for hosting websites in mainland China
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-white/45">
                    Complete the Internet Content Provider (ICP) filing required by MIIT for all websites hosted in China.
                  </p>
                  <Button 
                    onClick={() => window.open('/dashboard/settings?section=integrations-china', '_self')}
                    className="w-full"
                  >
                    View All Services
                  </Button>
                </CardContent>
              </Card>

              {/* QQ Authentication */}
              <Card className="bg-[#0f0f12] border-white/[0.07] opacity-60">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base text-white/85">QQ Authentication</CardTitle>
                    <Badge variant="outline" className="text-xs">Coming Soon</Badge>
                  </div>
                  <CardDescription className="text-xs text-white/45">
                    Enable QQ login for your application
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button variant="outline" className="w-full" disabled>
                    Configure QQ
                  </Button>
                </CardContent>
              </Card>

              {/* Payment Integration */}
              <Card className="bg-[#0f0f12] border-white/[0.07] opacity-60">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      <CardTitle className="text-base text-white/85">Payment Integration</CardTitle>
                    </div>
                    <Badge variant="outline" className="text-xs">Coming Soon</Badge>
                  </div>
                  <CardDescription className="text-xs text-white/45">
                    Alipay & WeChat Pay integration
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button variant="outline" className="w-full" disabled>
                    Setup Payment
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Hong Kong Ecosystem */}
            <div className="mt-8">
              <h3 className="text-lg font-semibold text-white/85 mb-3">Hong Kong Ecosystem</h3>
              <div className="grid gap-4">
                <Card className="bg-[#0f0f12] border-white/[0.07] opacity-60">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <Smartphone className="h-4 w-4" />
                        <CardTitle className="text-base text-white/85">iAM Smart</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-xs">Coming Soon</Badge>
                    </div>
                    <CardDescription className="text-xs text-white/45">
                      Hong Kong government digital identity authentication
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" className="w-full" disabled>
                      Configure iAM Smart
                    </Button>
                  </CardContent>
                </Card>

                <Card className="bg-[#0f0f12] border-white/[0.07] opacity-60">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4" />
                        <CardTitle className="text-base text-white/85">Payment</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-xs">Coming Soon</Badge>
                    </div>
                    <CardDescription className="text-xs text-white/45">
                      AlipayHK & local payment methods
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" className="w-full" disabled>
                      Setup Payment
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        );

      case "project-settings":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Project Settings</h2>
              <p className="text-sm text-white/45">Manage your project details, visibility, and preferences.</p>
            </div>

            <Card className="bg-[#0f0f12] border-white/[0.07]">
              <CardHeader>
                <CardTitle className="text-base text-white/85">Overview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="display-name" className="text-xs">Display name</Label>
                    <Input
                      id="display-name"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      className="h-8 text-sm"
                      placeholder="Project name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="url-slug" className="text-xs">URL slug</Label>
                    <Input
                      id="url-slug"
                      value={projectSlug}
                      onChange={(e) => setProjectSlug(e.target.value.replace(/[^a-z0-9-]/g, '-'))}
                      className="h-8 text-sm"
                      placeholder="project-slug"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-description" className="text-xs">Description</Label>
                  <Input
                    id="project-description"
                    value={projectDescription}
                    onChange={(e) => setProjectDescription(e.target.value)}
                    className="h-8 text-sm"
                    placeholder="Short project description"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-white/45">Created at</p>
                    <p className="font-medium">{project?.created_at ? new Date(project.created_at).toLocaleString() : '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-white/45">Messages count</p>
                    <p className="font-medium">{project?.message_count ?? 0}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-[#0f0f12] border-white/[0.07]">
              <CardHeader>
                <CardTitle className="text-base text-white/85">Project Visibility</CardTitle>
                <CardDescription className="text-xs text-white/45">
                  Keep your project hidden and prevent others from remixing it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select value={projectVisibility} onValueChange={(value: 'org_all' | 'org_restricted') => setProjectVisibility(value)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org_all">All organization members</SelectItem>
                    <SelectItem value="org_restricted">Restricted collaborators only</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            <Button onClick={handleSaveProjectSettings} disabled={savingProjectSettings || !projectId}>
              {savingProjectSettings ? 'Saving...' : 'Save Project Settings'}
            </Button>
          </div>
        );
      
      case "project-domains":
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium">Domains</h3>
              <p className="text-sm text-white/45">
                Manage your project domains and publishing settings
              </p>
            </div>
            <DomainSettings 
              projectId={projectId || ''}
              projectName={project?.name || 'Project'}
              organizationId={project?.organization_id || null}
              workspaceFiles={workspaceFiles}
            />
          </div>
        );
      
      case "integrations-stripe":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Stripe</h2>
              <p className="text-sm text-white/45">Accept payments and manage subscriptions via Stripe.</p>
            </div>
            {renderPlanLocked('Stripe Integration', 'Connect Stripe to enable payment processing in your apps.', 'integrations')}
          </div>
        );

      case "integrations-alipay":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Alipay</h2>
              <p className="text-sm text-white/45">Accept Alipay payments for Chinese market customers.</p>
            </div>
            {renderPlanLocked('Alipay Integration', 'Connect Alipay to accept payments from Chinese customers.', 'integrations')}
          </div>
        );

      case "integrations-airwallex":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Airwallex</h2>
              <p className="text-sm text-white/45">Multi-currency payments and global payouts via Airwallex.</p>
            </div>
            {renderPlanLocked('Airwallex Integration', 'Connect Airwallex for multi-currency payment support.', 'integrations')}
          </div>
        );

      default:
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Settings</h2>
              <p className="text-sm text-white/45">Select a section from the sidebar.</p>
            </div>
            <Card className="bg-[#0f0f12] border-white/[0.07]">
              <CardContent className="p-6">
                <p className="text-sm text-white/45">Content for this section coming soon...</p>
              </CardContent>
            </Card>
          </div>
        );
    }
  };

  return (
    <ScrollArea className="h-full w-full">
      <div className="p-6">
        {renderContent()}
      </div>
    </ScrollArea>
  );
};
