import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ICPFilingForm } from "./ICPFilingForm";
import { PlanUsageContent } from "./PlanUsageContent";
import { CollaboratorManager } from "./CollaboratorManager";
import { ReferralContent } from "./ReferralContent";
import { DomainSettings } from "./DomainSettings";
import { IntegrationsSettings } from "./IntegrationsSettings";
import { CustomizerSettings } from "./CustomizerSettings";
import { GitHubSettings } from "./GitHubSettings";
import { DatabaseSettings } from "./DatabaseSettings";
import { EdgeFunctionsSettings } from "./EdgeFunctionsSettings";
import { KnowledgeSettings } from "./KnowledgeSettings";
import { SecretsSettings } from "./SecretsSettings";
import { SeoSettingsPanel } from "@/components/seo/SeoSettingsPanel";
import { Globe, Smartphone, CreditCard, ExternalLink, Trash2 } from "lucide-react";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { getApiServerUrl } from "@/config/external-api";

interface SettingsContentProps {
  activeSection: string;
  projectId?: string;
  workspaceFiles?: { path: string; content: string }[];
  onSectionChange?: (section: string) => void;
}

export const SettingsContent = ({ activeSection, projectId, workspaceFiles = [], onSectionChange }: SettingsContentProps) => {
  const { hasFeature, tierLabel } = useSubscription();
  const [project, setProject] = useState<any>(null);
  const [projectName, setProjectName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projectVisibility, setProjectVisibility] = useState<'org_all' | 'org_restricted'>('org_all');
  const [savingProjectSettings, setSavingProjectSettings] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingProject, setDeletingProject] = useState(false);
  const navigate = useNavigate();

  const handleDeleteProject = async () => {
    if (!projectId) return;
    setDeletingProject(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');
      const res = await fetch(getApiServerUrl(`/api/v1/projects/${projectId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Server error ${res.status}`);
      }
      toast.success('Project deleted');
      navigate('/dashboard/projects');
    } catch (err) {
      toast.error(`Failed to delete project: ${(err as Error).message}`);
    } finally {
      setDeletingProject(false);
      setDeleteDialogOpen(false);
      setDeleteConfirmText('');
    }
  };

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
          <Card className="bg-workspace-surface border-white/[0.07]">
            <CardContent className="p-6">
              <p className="text-sm text-white/45">{title} configuration coming soon...</p>
            </CardContent>
          </Card>
        );
      }

      return (
        <Card className="bg-workspace-surface border-indigo-500/30">
          <CardHeader>
            <CardTitle className="text-base text-white/85">{title}   Paid Plan Feature</CardTitle>
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

      case "ecomgear-functions":
        return <EdgeFunctionsSettings projectId={projectId} />;

      case "ecomgear-llm":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">LLM</h2>
              <p className="text-sm text-white/45">Configure large language model settings</p>
            </div>
            <Card className="bg-workspace-surface border-white/[0.07]">
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

      case "workspace-referrals":
        return <ReferralContent />;
        
      case "project-seo":
        return <SeoSettingsPanel projectId={projectId} />;

      case "integrations":
        return <IntegrationsSettings projectId={projectId} />;

      case "ecg-customizer":
        return <CustomizerSettings projectId={projectId} />;

      case "project-git":
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
              <Card className="bg-workspace-surface border-white/[0.07]">
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
                    onClick={() => onSectionChange?.('china-icp')}
                    className="w-full"
                  >
                    Start ICP Filing
                  </Button>
                </CardContent>
              </Card>

              {/* QQ Authentication */}
              <Card className="bg-workspace-surface border-white/[0.07] opacity-60">
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
              <Card className="bg-workspace-surface border-white/[0.07] opacity-60">
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
                <Card className="bg-workspace-surface border-white/[0.07] opacity-60">
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

                <Card className="bg-workspace-surface border-white/[0.07] opacity-60">
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

            <Card className="bg-workspace-surface border-white/[0.07]">
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

            <Card className="bg-workspace-surface border-white/[0.07]">
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

            <Card className="bg-workspace-surface border-destructive/30">
              <CardHeader>
                <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
                <CardDescription className="text-xs text-white/45">
                  Permanently delete this project. This app cannot be recovered once deleted.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)} disabled={!projectId} className="gap-2">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete project
                </Button>
              </CardContent>
            </Card>

            <Dialog open={deleteDialogOpen} onOpenChange={(o) => { if (!o) { setDeleteDialogOpen(false); setDeleteConfirmText(''); } }}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Trash2 className="h-4 w-4 text-destructive" />
                    Delete project
                  </DialogTitle>
                  <DialogDescription>
                    <span className="block font-medium text-destructive/90 mb-1.5">This app cannot be recovered once deleted.</span>
                    This permanently removes the project's code, its published site and custom domain, its hosted database, and every setting and collaborator. This cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <p className="text-xs text-white/45">
                    Type <span className="font-mono text-white/85 bg-white/[0.06] px-1.5 py-0.5 rounded">delete my project</span> to confirm.
                  </p>
                  <Input
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="delete my project"
                    className="font-mono text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && deleteConfirmText.trim().toLowerCase() === 'delete my project') {
                        handleDeleteProject();
                      }
                    }}
                    autoFocus
                  />
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="ghost" onClick={() => { setDeleteDialogOpen(false); setDeleteConfirmText(''); }}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={deleteConfirmText.trim().toLowerCase() !== 'delete my project' || deletingProject}
                    onClick={handleDeleteProject}
                  >
                    {deletingProject ? 'Deleting…' : 'Delete project'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
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


      default:
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-white/85 mb-1">Settings</h2>
              <p className="text-sm text-white/45">Select a section from the sidebar.</p>
            </div>
            <Card className="bg-workspace-surface border-white/[0.07]">
              <CardContent className="p-6">
                <p className="text-sm text-white/45">Content for this section coming soon...</p>
              </CardContent>
            </Card>
          </div>
        );
    }
  };

  // SEO panel owns its own two-pane layout + independent scroll regions  
  // wrapping it in the standard p-6/ScrollArea shell would break that layout.
  if (activeSection === "project-seo") {
    return <div className="h-full w-full">{renderContent()}</div>;
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="p-6">
        {renderContent()}
      </div>
    </ScrollArea>
  );
};
