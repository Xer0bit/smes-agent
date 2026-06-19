import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, lovableCloud } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { getGenServerUrl } from '@/config/external-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Search, Plus, Grid3x3, List, Database, Cloud, Settings, Users, Trash2, Edit, Crown, Shield, Share2, Globe, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { SettingsDialog } from '@/components/referral/settings/SettingsDialog';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { ProjectThumbnail } from '@/components/dashboard/ProjectThumbnail';
import { DESIGN_TEMPLATES, type DesignTemplate, buildTemplatePrompt } from '@/data/designTemplates';
import { useSubscription } from '@/hooks/useSubscription';
import { TemplateQuestionnaire } from '@/components/TemplateQuestionnaire';

// Types
type ProjectStatus = 'active' | 'deleted' | 'suspended';
type ProjectVisibility = 'org_all' | 'org_restricted';
type CollaboratorRole = 'editor' | 'viewer' | 'client';

interface Organization {
  id: string;
  name: string;
  slug: string;
}

interface Project {
  id: string;
  name: string;
  slug: string | null;
  description?: string;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  organization_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_storage_bytes?: number;
  revision_count?: number;
  latest_revision_size?: number;
  organizations?: {
    name: string;
  } | null;
  user_org_role?: 'admin' | 'billing_admin' | 'member' | null;
}

const formatBytes = (bytes: number) => {
  if (!bytes || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
};


interface Collaborator {
  id: string;
  user_id: string;
  role: CollaboratorRole;
  added_at: string;
  profiles: {
    email: string;
    full_name?: string;
  };
}

// Validation schemas
const createProjectSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  slug: z.string().trim().min(2).max(50).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  description: z.string().max(500).optional(),
  organization_id: z.string().uuid('Please select an organization'),
  visibility: z.enum(['org_all', 'org_restricted']),
});

export default function DashboardProjects() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentOrganizationId, organizations, currentOrganization, setCurrentOrganizationId } = useOrganization();
  const { hasFeature } = useSubscription();
  const canUseTemplates = hasFeature('premium_templates');

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

  // Create project dialog
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectSlug, setNewProjectSlug] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [projectVisibility, setProjectVisibility] = useState<ProjectVisibility>('org_all');
  const [creating, setCreating] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<DesignTemplate | null>(null);
  const [questionnaireOpen, setQuestionnaireOpen] = useState(false);

  // View project dialog
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);

  // Delete confirmation
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'active' | 'deleted' | 'all'>('active');

  // Current user (for permissions)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Edit project name
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const [updatingProjectName, setUpdatingProjectName] = useState(false);
  const [reassignOrgId, setReassignOrgId] = useState('');
  const [updatingOrg, setUpdatingOrg] = useState(false);

  // Project settings dialog
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [projectSettingsSection, setProjectSettingsSection] = useState('project-settings');

  useEffect(() => {
    if (!selectedProject?.id) return;
    const latest = projects.find((p) => p.id === selectedProject.id);
    if (latest) {
      // Merge stats/counts from the fresh DB record but preserve any name
      // the user just saved locally — avoids a flicker where the DB echo
      // arrives before the optimistic update settles.
      setSelectedProject(prev => prev ? { ...latest, name: prev.name } : latest);
    }
  }, [projects, selectedProject?.id]);

  useEffect(() => {
    checkAuthAndLoad();
  }, []);

  // Real-time subscription for revision/project updates — debounced to avoid
  // a full reload for every row in a batch change.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedReload = () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => loadProjects(), 2000);
  };

  useEffect(() => {
    const revisionsChannel = supabase
      .channel('projects-revisions-updates')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'revisions' }, debouncedReload)
      .subscribe();

    const projectsChannel = supabase
      .channel('projects-live-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, debouncedReload)
      .subscribe();

    return () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      supabase.removeChannel(revisionsChannel);
      supabase.removeChannel(projectsChannel);
    };
  }, []);

  const checkAuthAndLoad = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }
      await loadProjects();
    } catch (error) {
      console.error('Auth check failed:', error);
      toast.error('Authentication failed');
    }
  };

  const loadProjects = async () => {
    try {
      setIsLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error('Please log in to view projects');
        navigate('/auth');
        return;
      }
      setCurrentUserId(user.id);

      // Fetch org IDs the user belongs to (member or created)
      const { data: memberRows } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id);
      const userOrgIds = (memberRows || []).map(r => r.org_id).filter(Boolean);

      // Build scoped query: only own projects or projects in the user's orgs
      let projectQuery = supabase
        .from('projects')
        .select(`
          id,
          name,
          slug,
          description,
          status,
          visibility,
          organization_id,
          created_by,
          created_at,
          updated_at,
          message_count,
          total_storage_bytes,
          latest_revision_size,
          organizations(name)
        `)
        .in('status', ['active', 'deleted', 'suspended'])
        .order('created_at', { ascending: false });

      if (userOrgIds.length > 0) {
        projectQuery = projectQuery.or(`user_id.eq.${user.id},organization_id.in.(${userOrgIds.join(',')})`);
      } else {
        projectQuery = projectQuery.eq('user_id', user.id);
      }

      const { data, error } = await projectQuery;

      if (error) throw error;

      // Use counts/sizes already stored on the projects row — avoids N×3 extra requests.
      const projectsWithCounts = (data || []).map((project) => ({
        ...project,
        message_count: project.message_count || 0,
        revision_count: 0,
        latest_revision_size: project.latest_revision_size || 0,
      }));

      // Get user's role in each organization (reuse org_members rows already fetched above)
      let userOrgRoles: Record<string, 'admin' | 'billing_admin' | 'member'> = {};
      if (userOrgIds.length > 0) {
        const { data: memberData } = await supabase
          .from('org_members')
          .select('org_id, role')
          .eq('user_id', user.id)
          .in('org_id', userOrgIds);

        userOrgRoles = (memberData || []).reduce((acc, m) => {
          acc[m.org_id] = m.role as 'admin' | 'billing_admin' | 'member';
          return acc;
        }, {} as Record<string, 'admin' | 'billing_admin' | 'member'>);
      }

      // Map projects with user's org role
      const allProjects: Project[] = projectsWithCounts.map((p: any) => ({
        id: p.id,
        name: p.name,
        slug: p.slug || '',
        description: p.description,
        status: p.status,
        visibility: p.visibility,
        organization_id: p.organization_id,
        created_by: p.created_by,
        created_at: p.created_at,
        updated_at: p.updated_at,
        message_count: p.message_count || 0,
        total_storage_bytes: p.total_storage_bytes || 0,
        revision_count: p.revision_count || 0,
        latest_revision_size: p.latest_revision_size || 0,
        organizations: Array.isArray(p.organizations) ? p.organizations[0] : p.organizations,
        user_org_role: p.organization_id ? userOrgRoles[p.organization_id] : null
      }));

      // Client-side role-based filtering (safety net — RLS handles this server-side)
      // Billing admins should not see any projects
      const filteredByRole = allProjects.filter((p) => {
        if (p.user_org_role === 'billing_admin') return false;
        return true;
      });

      setProjects(filteredByRole);

      // Fetch preview URLs for all projects
      const urls: Record<string, string> = {};
      await Promise.all(
        allProjects.map(async (project) => {
          const { data } = await supabase.rpc('get_latest_preview_url', {
            p_project_id: project.id
          });
          if (data) {
            urls[project.id] = data;
          }
        })
      );
      setPreviewUrls(urls);
    } catch (error) {
      console.error('Error loading projects:', error);
      toast.error('Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  };

  const refreshPreviewUrl = async (projectId: string) => {
    const { data } = await supabase.rpc('get_latest_preview_url', { p_project_id: projectId });
    if (data) {
      setPreviewUrls(prev => ({ ...prev, [projectId]: data }));
    }
  };

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  const handleNameChange = (name: string) => {
    setNewProjectName(name);
    if (!newProjectSlug || newProjectSlug === generateSlug(newProjectName)) {
      setNewProjectSlug(generateSlug(name));
    }
  };

  const handleCreateProject = async () => {
    try {
      setCreating(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
      const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
      if (!sessionToken) throw new Error('Not authenticated');

      // Use the form name if provided, otherwise fall back to timestamp
      const projectName = newProjectName.trim() || `project-${Date.now()}`;

      // Prefer current org, fallback to first available org, otherwise omit
      const orgId = currentOrganizationId || organizations[0]?.id || null;

      // Create project via backend edge function (bypasses RLS)
      let newProject: { id: string } | null = null;
      const { data, error } = await lovableCloud.functions.invoke<{
        success: boolean;
        project: { id: string };
      }>('revision-create-project', {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          apikey,
        },
        body: {
          name: projectName,
          user_id: user.id,
          organization_id: orgId,
        },
      });

      if (error) {
        // 401 from the edge function means the session JWT couldn't be validated
        // server-side (common after local Supabase restarts). Fall back to a direct
        // authenticated insert — the projects RLS allows users to create their own.
        const isAuthError = error.message?.includes('non-2xx') || error.message?.includes('401');
        if (!isAuthError) throw error;

        console.warn('[Projects] Edge function returned auth error, falling back to direct insert');
        const { data: directData, error: directError } = await supabase
          .from('projects')
          .insert({
            name: projectName,
            user_id: user.id,
            created_by: user.id,
            organization_id: orgId,
          })
          .select()
          .single();

        if (directError) throw directError;
        newProject = directData;
      } else {
        newProject = data?.project ?? null;
      }

      if (!newProject || !newProject.id) throw new Error('Project not created');

      // Initialize project folder structure in storage
      // This is CRITICAL since the edge function doesn't do it
      try {
        console.log('[Projects] Initializing storage for new project:', newProject.id);
        const mod = await import('@/services/projectLifecycleService');
        const svc = mod.projectLifecycleService ?? (mod as any).default;
        if (!svc?.initializeProject) throw new Error('projectLifecycleService not available');
        await svc.initializeProject(newProject.id, user.id);
        console.log('[Projects] Storage initialized successfully');
      } catch (initError) {
        console.error('[Projects] Failed to initialize storage:', initError);
        // Don't fail the whole creation flow, but log it
      }

      toast.success('Project created');
      if (orgId) {
        setCurrentOrganizationId(orgId);
      }
      navigate(`/project/${newProject.id}`);
    } catch (error) {
      console.error('Failed to create project:', error);
      const extractFunctionErrorMessage = async (err: unknown) => {
        const defaultMessage = (err as any)?.message || (typeof err === 'string' ? err : '');

        try {
          const response = (err as any)?.context;
          if (response && typeof response.text === 'function') {
            const raw = await response.text();
            if (raw) {
              const parsed = JSON.parse(raw) as {
                error?: string;
                message?: string;
                details?: string;
              };
              const parts = [parsed.error || parsed.message, parsed.details].filter(Boolean);
              if (parts.length > 0) {
                return parts.join(' - ');
              }
            }
          }
        } catch {
          // Keep default message when response body is not JSON.
        }

        return defaultMessage;
      };

      const message = await extractFunctionErrorMessage(error);
      toast.error(`Failed to create project${message ? `: ${message}` : ''}`);
    } finally {
      setCreating(false);
    }
  };

  const resetCreateForm = () => {
    setNewProjectName('');
    setNewProjectSlug('');
    setNewProjectDesc('');
    setProjectVisibility('org_all');
  };

  const handleCreateFromTemplate = async (tpl: DesignTemplate, prompt?: string) => {
    if (!canUseTemplates) {
      toast.error('Design templates are not available on this plan.');
      return;
    }

    // If no custom prompt yet, open questionnaire first
    if (!prompt) {
      setPendingTemplate(tpl);
      setQuestionnaireOpen(true);
      return;
    }

    try {
      setCreating(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const orgId = currentOrganizationId || organizations[0]?.id || null;
      const projectName = `${tpl.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;

      const { data, error } = await lovableCloud.functions.invoke<{
        success: boolean;
        project: { id: string };
      }>('revision-create-project', {
        body: { name: projectName, user_id: user.id, organization_id: orgId },
      });

      if (error) throw error;
      const newProject = data?.project;
      if (!newProject?.id) throw new Error('Failed to create project');

      if (orgId) setCurrentOrganizationId(orgId);

      navigate(`/project/${newProject.id}`, {
        state: {
          initialPrompt: prompt,
          shouldGenerate: true,
          isGuest: false,
        },
      });
    } catch (error) {
      console.error('Failed to create project from template:', error);
      toast.error('Failed to create project from template');
    } finally {
      setCreating(false);
    }
  };

  const handleQuestionnaireSubmit = (template: DesignTemplate, answers: Record<string, string>) => {
    setQuestionnaireOpen(false);
    const enhancedPrompt = buildTemplatePrompt(template, answers);
    setPendingTemplate(null);
    handleCreateFromTemplate(template, enhancedPrompt);
  };

  const openProjectWorkspace = (project: Pick<Project, 'id' | 'organization_id'>) => {
    if (project.organization_id) {
      setCurrentOrganizationId(project.organization_id);
    }
    navigate(`/project/${project.id}`);
  };

  const handleViewProject = (project: Project) => {
    setSelectedProject(project);
    setEditProjectName(project.name);
    setReassignOrgId(project.organization_id || '');
    setIsEditingProjectName(false);
    setIsViewOpen(true);
  };

  const handleUpdateProjectOrganization = async () => {
    if (!selectedProject || !reassignOrgId) return;

    try {
      setUpdatingOrg(true);
      const { data, error } = await supabase.rpc('assign_project_to_organization', {
        p_project_id: selectedProject.id,
        p_organization_id: reassignOrgId,
        p_send_requests: true,
      });

      if (error) throw error;

      const payload = (data || {}) as {
        success?: boolean;
        error?: string;
        invited_count?: number;
        invited_recipients?: Array<{ email: string; token: string }>;
      };

      if (payload.success === false) {
        throw new Error(payload.error || 'Failed to update organization');
      }

      const invitedCount = Number(payload.invited_count || 0);
      const invitedRecipients = Array.isArray(payload.invited_recipients)
        ? payload.invited_recipients.filter((item) => item?.email && item?.token)
        : [];

      if (invitedRecipients.length > 0) {
        void (async () => {
          try {
            const { data: { user } } = await supabase.auth.getUser();
            let inviterName = 'A team member';

            if (user?.id) {
              const { data: inviterProfile } = await supabase
                .from('profiles')
                .select('full_name, email')
                .eq('id', user.id)
                .single();

              inviterName = inviterProfile?.full_name || inviterProfile?.email || inviterName;
            }

            await Promise.allSettled(
              invitedRecipients.map((recipient) =>
                supabase.functions.invoke('send-project-invitation', {
                  body: {
                    project_name: selectedProject.name || 'Project',
                    inviter_name: inviterName,
                    email: recipient.email,
                    token: recipient.token,
                  },
                })
              )
            );
          } catch (emailErr) {
            console.warn('Failed to send assignment invitation emails:', emailErr);
          }
        })();
      }

      toast.success(
        invitedCount > 0
          ? `Project organization updated. Sent ${invitedCount} access request${invitedCount === 1 ? '' : 's'} to organization members.`
          : 'Project organization updated'
      );
      setSelectedProject({ ...selectedProject, organization_id: reassignOrgId });
      // Cancel any in-progress name edit so the dialog doesn't show a stale
      // unsaved name after the org reassignment reloads the project.
      setIsEditingProjectName(false);
      setEditProjectName(selectedProject.name);
      await loadProjects();
    } catch (error) {
      console.error('Failed to update organization:', error);
      toast.error('Failed to update organization');
    } finally {
      setUpdatingOrg(false);
    }
  };

  const handleUpdateProjectName = async () => {
    if (!selectedProject) return;

    try {
      const trimmedName = editProjectName.trim();

      if (!trimmedName) {
        toast.error('Project name cannot be empty');
        return;
      }

      if (trimmedName.length < 2 || trimmedName.length > 100) {
        toast.error('Project name must be between 2 and 100 characters');
        return;
      }

      setUpdatingProjectName(true);

      const { error } = await supabase
        .from('projects')
        .update({ name: trimmedName })
        .eq('id', selectedProject.id);

      if (error) throw error;

      toast.success('Project name updated');
      setSelectedProject({ ...selectedProject, name: trimmedName });
      setIsEditingProjectName(false);
      await loadProjects();
    } catch (error) {
      console.error('Failed to update project name:', error);
      toast.error('Failed to update project name');
    } finally {
      setUpdatingProjectName(false);
    }
  };

  const handleUpdateProjectStatus = async (projectId: string, status: ProjectStatus) => {
    try {
      const { error } = await supabase
        .from('projects')
        .update({ status })
        .eq('id', projectId);

      if (error) throw error;

      toast.success(`Project ${status}`);
      await loadProjects();
      if (selectedProject?.id === projectId) {
        setSelectedProject({ ...selectedProject, status });
      }
    } catch (error) {
      console.error('Failed to update project status:', error);
      toast.error('Failed to update project status');
    }
  };

  const handleDeleteProject = async () => {
    if (!deleteProjectId) return;

    const projectId = deleteProjectId;

    // 1. Instant UI — remove from list and close dialogs before the network call
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setDeleteProjectId(null);
    setIsViewOpen(false);
    setSelectedProject(null);
    toast.success('Project deleted');

    // 2. Fire the backend call in the background — cleanup happens server-side async
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    fetch(getGenServerUrl(`/api/v1/projects/${projectId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch((err) => {
      console.error('Background project deletion failed:', err);
      // Silently refetch to restore state if the call actually failed
      loadProjects();
    });
  };

  const getStatusBadge = (status: ProjectStatus) => {
    const colors = {
      active: 'bg-green-500/20 text-green-500',
      deleted: 'bg-gray-500/20 text-gray-500',
      suspended: 'bg-red-500/20 text-red-500',
    };
    return colors[status] || colors.active;
  };

  const getOrgRoleIcon = (role?: 'admin' | 'billing_admin' | 'member' | null) => {
    if (role === 'admin') return <Crown className="h-3.5 w-3.5 text-amber-600" />;
    return null;
  };

  const filteredProjects = projects.filter(project => {
    const matchesSearch = project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (project.slug && project.slug.toLowerCase().includes(searchQuery.toLowerCase()));

    // When an org workspace is selected, show ONLY that org's projects.
    // Never leak projects from other organizations into the current workspace view.
    // Note: don't fall back to created_by here — a project keeps its creator's id
    // forever, even after being reassigned to an organization, so matching on
    // created_by would leak reassigned projects back into the personal workspace.
    const matchesWorkspace = currentOrganizationId
      ? project.organization_id === currentOrganizationId
      : project.organization_id === null;

    if (!matchesSearch) return false;
    if (!matchesWorkspace) return false;
    if (statusFilter === 'all') return true;
    return project.status === statusFilter;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title={t('dashboard.projects')}
        description={currentOrganization ? `Showing projects in ${currentOrganization.name}.` : t('dashboard.projectsDesc')}
      />

      <div className="mb-6 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search projects"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-background"
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={() => setViewMode('grid')}
        >
          <Grid3x3 className={`h-4 w-4 ${viewMode === 'grid' ? 'text-foreground' : 'text-muted-foreground'}`} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={() => setViewMode('list')}
        >
          <List className={`h-4 w-4 ${viewMode === 'list' ? 'text-foreground' : 'text-muted-foreground'}`} />
        </Button>

        <Button
          className="bg-primary hover:bg-trigger"
          onClick={handleCreateProject}
          disabled={creating}
        >
          <Plus className="h-4 w-4 mr-2" />
          {creating ? 'Creating...' : 'New project'}
        </Button>
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={(value) => setStatusFilter(value as 'active' | 'deleted' | 'all')}
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="deleted">Archived</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Design Templates Section */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Sparkles className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold">Design Templates</h3>
          <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase bg-primary/10 text-primary rounded">Included</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {DESIGN_TEMPLATES.map((tpl) => (
            <Card
              key={tpl.id}
              className="border overflow-hidden cursor-pointer group transition-all hover:border-primary/50 hover:shadow-lg"
              onClick={() => handleCreateFromTemplate(tpl)}
            >
              <div className="relative aspect-video overflow-hidden bg-muted">
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: tpl.accent, color: tpl.fg }}
                >
                  <span className="text-2xl font-semibold opacity-60">{tpl.name}</span>
                </div>
                <img
                  src={tpl.image}
                  alt={tpl.name}
                  className="relative z-[1] w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-105"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                <span className="absolute top-2 right-2 z-[2] px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase bg-primary text-primary-foreground rounded">
                  Template
                </span>
              </div>
              <CardContent className="p-3">
                <h4 className="font-medium text-sm truncate">{tpl.name}</h4>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{tpl.description}</p>
                <div className="flex gap-1 mt-2 flex-wrap">
                  {tpl.tag.split(' · ').map((t) => (
                    <span key={t} className="px-1.5 py-0.5 text-[10px] bg-muted rounded">{t}</span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {filteredProjects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Database className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No projects found</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {searchQuery
                ? 'Try a different search term'
                : currentOrganizationId
                ? 'No projects in this workspace yet'
                : 'Create your first project to get started'}
            </p>
            {!searchQuery && (
              <Button
                onClick={handleCreateProject}
                disabled={creating}
              >
                <Plus className="h-4 w-4 mr-2" />
                {creating ? 'Creating...' : 'Create Project'}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'space-y-3'}>
          {filteredProjects.map((project) => (
            <Card
              key={project.id}
              className={`border transition-colors cursor-pointer group overflow-hidden flex flex-col ${project.organization_id
                ? 'border-border hover:border-primary/50'
                : 'border-yellow-500/50 bg-yellow-50/5'
                }`}
              onClick={() => {
                if (project.status === 'deleted') {
                  handleViewProject(project);
                  return;
                }
                openProjectWorkspace(project);
              }}
            >
              {viewMode === 'grid' && (
                <ProjectThumbnail
                  projectName={project.name}
                  previewUrl={previewUrls[project.id] ?? null}
                  onRefresh={() => refreshPreviewUrl(project.id)}
                />
              )}
              <CardContent className="p-4 flex flex-col flex-1">
                {!project.organization_id && (
                  <Badge variant="outline" className="mb-2 bg-yellow-500/10 text-yellow-600 border-yellow-500/30">
                    ⚠️ No Organization
                  </Badge>
                )}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-base truncate group-hover:text-primary transition-colors">
                        {project.name}
                      </h3>
                    </div>
                    <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                      <span>{project.organizations?.name || 'Unassigned'}</span>
                      {getOrgRoleIcon(project.user_org_role)}
                    </p>
                  </div>
                </div>

                {project.description && (
                  <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
                    {project.description}
                  </p>
                )}

                {project.status === 'deleted' ? (
                  <div className="mt-auto pt-3 border-t">
                    <Button
                      className="w-full"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUpdateProjectStatus(project.id, 'active');
                      }}
                    >
                      Restore Project
                    </Button>
                  </div>
                ) : (
                <div className="flex items-center justify-between mt-auto pt-3 border-t">
                  <Badge className={getStatusBadge(project.status)}>
                    {project.status}
                  </Badge>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      💬 {project.message_count}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      📝 {project.revision_count || 0}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ✏️ {formatBytes(project.latest_revision_size || 0)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      💾 {formatBytes(project.total_storage_bytes || 0)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const previewUrl = previewUrls[project.id];
                        if (previewUrl) {
                          await navigator.clipboard.writeText(previewUrl);
                          toast.success('Preview link copied!');
                        } else {
                          toast.error('No preview available for this project');
                        }
                      }}
                      className="h-8"
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewProject(project);
                      }}
                      className="h-8"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* View Project Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader className="flex flex-row items-start justify-between space-y-0">
            <div className="flex items-center gap-3 flex-1">
              <div className="h-12 w-12 rounded-md bg-primary/10 flex items-center justify-center">
                <Database className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                {isEditingProjectName ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editProjectName}
                      onChange={(e) => setEditProjectName(e.target.value)}
                      className="text-xl font-semibold h-10"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleUpdateProjectName();
                        if (e.key === 'Escape') {
                          setIsEditingProjectName(false);
                          setEditProjectName(selectedProject?.name || '');
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={handleUpdateProjectName}
                      disabled={updatingProjectName}
                    >
                      {updatingProjectName ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setIsEditingProjectName(false);
                        setEditProjectName(selectedProject?.name || '');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-xl">{selectedProject?.name}</DialogTitle>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsEditingProjectName(true)}
                      className="h-8 w-8 p-0"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
            <Button
              onClick={() => selectedProject && openProjectWorkspace(selectedProject)}
              className="bg-primary hover:bg-primary/90 text-primary-foreground mr-[3px]"
            >
              Start building
            </Button>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <Card className={!selectedProject?.organization_id ? 'border-yellow-500/50 bg-yellow-50/5' : ''}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <span>{selectedProject?.organization_id ? '🏢' : '⚠️'}</span>
                  {selectedProject?.organization_id ? 'Organization Assignment' : 'Orphaned Project'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  {selectedProject?.organization_id
                    ? 'Move this project to a different organization if ownership has changed.'
                    : 'This project is not assigned to any organization. Assign it to continue managing it.'}
                </p>
                <div className="flex gap-2">
                  <Select
                    value={reassignOrgId}
                    onValueChange={setReassignOrgId}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="Select organization" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleUpdateProjectOrganization}
                    disabled={!reassignOrgId || updatingOrg || reassignOrgId === (selectedProject?.organization_id || '')}
                  >
                    {updatingOrg ? 'Saving...' : selectedProject?.organization_id ? 'Update Organization' : 'Assign to Organization'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Project Stats</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground mb-1">Status</p>
                    <Badge className={getStatusBadge(selectedProject?.status || 'active')}>
                      {selectedProject?.status}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Message Count</p>
                    <p className="font-medium">💬 {selectedProject?.message_count || 0}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Storage Used</p>
                    <p className="font-medium">💾 {formatBytes(selectedProject?.total_storage_bytes || 0)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Revisions</p>
                    <p className="font-medium">📝 {selectedProject?.revision_count || 0}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Latest Code Edit Size</p>
                    <p className="font-medium">✏️ {formatBytes(selectedProject?.latest_revision_size || 0)}</p>
                  </div>
                </div>

                {selectedProject?.description && (
                  <div>
                    <p className="text-muted-foreground mb-1">Description</p>
                    <p className="text-sm">{selectedProject.description}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sharing & Publishing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={async () => {
                      const previewUrl = selectedProject?.id ? previewUrls[selectedProject.id] : null;
                      if (previewUrl) {
                        await navigator.clipboard.writeText(previewUrl);
                        toast.success('Preview link copied!');
                      } else {
                        toast.error('No preview available for this project');
                      }
                    }}
                    className="flex-1"
                  >
                    <Share2 className="h-4 w-4 mr-2" />
                    Copy Preview Link
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const url = `${window.location.origin}/project/${selectedProject?.id}`;
                      await navigator.clipboard.writeText(url);
                      toast.success('Editor link copied!');
                    }}
                    className="flex-1"
                  >
                    <Edit className="h-4 w-4 mr-2" />
                    Copy Editor Link
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Share this link with collaborators to give them access to your project
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Collaborators
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Manage who can access and edit this project
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsViewOpen(false);
                      setProjectSettingsSection('project-collaborators');
                      setIsProjectSettingsOpen(true);
                    }}
                  >
                    <Settings className="h-4 w-4 mr-1" />
                    Manage
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleUpdateProjectStatus(selectedProject?.id || '', 'active')}
                    disabled={selectedProject?.status === 'active'}
                  >
                    Activate
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleUpdateProjectStatus(selectedProject?.id || '', 'deleted')}
                    disabled={selectedProject?.status === 'deleted'}
                  >
                    Archive
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      if (!selectedProject || !currentUserId) return;
                      const canDelete =
                        selectedProject.created_by === currentUserId ||
                        selectedProject.user_org_role === 'admin';
                      if (canDelete) {
                        setDeleteProjectId(selectedProject.id);
                      } else {
                        toast.error('You can only delete projects you created or where you are an org admin');
                      }
                    }}
                    disabled={
                      !selectedProject ||
                      !currentUserId ||
                      (selectedProject.created_by !== currentUserId &&
                        selectedProject.user_org_role !== 'admin')
                    }
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete Project
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Project Confirmation */}
      <AlertDialog open={!!deleteProjectId} onOpenChange={() => setDeleteProjectId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the project
              and all associated data including settings and collaborators.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsDialog
        open={isProjectSettingsOpen}
        onOpenChange={setIsProjectSettingsOpen}
        defaultSection={projectSettingsSection}
        projectId={selectedProject?.id}
      />

      <TemplateQuestionnaire
        template={pendingTemplate}
        open={questionnaireOpen}
        onOpenChange={setQuestionnaireOpen}
        onSubmit={handleQuestionnaireSubmit}
      />
    </div>
  );
}
