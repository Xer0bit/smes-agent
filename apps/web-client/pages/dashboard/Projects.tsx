/* Hallmark · macrostructure: Workbench (adapted, dashboard-scope) · genre: editorial
 * theme: brand (preserved: cyan/orange/purple HSL tokens + Fraunces/Manrope)
 * tone: luxury · audience: indie builders · enrichment: none (real project
 * thumbnails are the imagery) · motion: framer-motion, restrained (350-450ms)
 * simplified per user request: card shows only thumbnail + name; settings/
 * delete live behind small icon buttons; clicking the card opens the editor.
 * templates moved to their own page (Designs.tsx).
 */
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { supabase, lovableCloud } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { getApiServerUrl } from '@/config/external-api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, Plus, Grid3x3, List, Database, Settings, Trash2, Paperclip, FileText, X } from 'lucide-react';
import { uploadChatAttachment, isAllowedFile } from '@/services/chatAttachmentService';
import { stashPendingPrompt } from '@/services/pendingPromptHandoff';
import type { AgentAttachment } from '@/eCG/UserPrompt/types';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { ProjectThumbnail } from '@/components/dashboard/ProjectThumbnail';

type ProjectStatus = 'active' | 'deleted' | 'suspended';
type ProjectVisibility = 'org_all' | 'org_restricted';

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
  thumbnail_url?: string | null;
  organizations?: {
    name: string;
  } | null;
  user_org_role?: 'admin' | 'billing_admin' | 'member' | null;
}

export default function DashboardProjects() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentOrganizationId, currentOrganization, setCurrentOrganizationId } = useOrganization();

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

  const [creating, setCreating] = useState(false);
  // Files staged before the project exists. They cannot be uploaded yet --
  // uploadChatAttachment is scoped to a projectId -- so they are held as raw
  // File objects and uploaded in handleCreateProject once the id is known.
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  const handleAttachFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (attachedFiles.length + files.length > 10) {
      toast.error('Maximum 10 files allowed');
      return;
    }
    // Gate on isAllowedFile -- the same check the uploader enforces. Accepting
    // anything wider here just defers the failure to a point where the user
    // has already navigated away from this screen.
    for (const file of Array.from(files)) {
      const check = isAllowedFile(file);
      if (!check.ok) {
        toast.error(`${file.name}: ${check.reason}`);
        return;
      }
    }
    setAttachedFiles((prev) => [...prev, ...Array.from(files)]);
  };

  const removeAttachedFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Delete confirmation
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'deleted' | 'all'>('active');

  // Current user (for permissions)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    checkAuthAndLoad();
  }, []);

  // Real-time subscription for revision/project updates   debounced to avoid
  // a full reload for every row in a batch change.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks which projects already had a thumbnail-capture request sent this
  // session, so a debounced reload (real-time subscription) or a manual
  // refresh doesn't re-request the same still-pending capture.
  const requestedThumbnailsRef = useRef<Set<string>>(new Set());
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
          thumbnail_url,
          organizations(name)
        `)
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      if (userOrgIds.length > 0) {
        projectQuery = projectQuery.or(`user_id.eq.${user.id},created_by.eq.${user.id},organization_id.in.(${userOrgIds.join(',')})`);
      } else {
        projectQuery = projectQuery.or(`user_id.eq.${user.id},created_by.eq.${user.id}`);
      }

      const { data, error } = await projectQuery;

      if (error) throw error;

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
      const allProjects: Project[] = (data || []).map((p: any) => ({
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
        thumbnail_url: p.thumbnail_url ?? null,
        organizations: Array.isArray(p.organizations) ? p.organizations[0] : p.organizations,
        user_org_role: p.organization_id ? userOrgRoles[p.organization_id] : null
      }));

      // Client-side role-based filtering (safety net   RLS handles this server-side)
      // Billing admins should not see any projects
      const filteredByRole = allProjects.filter((p) => {
        if (p.user_org_role === 'billing_admin') return false;
        return true;
      });

      setProjects(filteredByRole);

      // Fetch preview URLs for ALL projects in ONE call instead of one
      // RPC round-trip per project (was N parallel requests via Promise.all
      // -- confirmed live contributor to excessive request count/load time
      // on this page, found via network audit 2026-08-06). Same underlying
      // resolution logic, batched server-side.
      const urls: Record<string, string> = {};
      if (allProjects.length > 0) {
        const { data: urlRows, error: urlErr } = await supabase.rpc('get_latest_preview_urls', {
          p_project_ids: allProjects.map(p => p.id),
        });
        if (urlErr) {
          console.error('Error fetching preview URLs (batched):', urlErr);
        } else {
          for (const row of (urlRows || []) as { project_id: string; preview_url: string | null }[]) {
            if (row.preview_url) urls[row.project_id] = row.preview_url;
          }
        }
      }
      setPreviewUrls(urls);

      // Auto-trigger thumbnail capture for projects that have a preview URL but no thumbnail yet.
      // Fire-and-forget   the real-time projects subscription will reload when thumbnails land.
      // Capped per page load: this used to fire one POST per missing thumbnail
      // unconditionally, so a workspace with many un-thumbnailed projects sent
      // that many requests on every single dashboard visit. A thumbnail only
      // needs to be captured once ever, so a small per-load cap plus a
      // client-side "already requested" guard is enough -- the rest catch up
      // on subsequent loads instead of all firing at once.
      const THUMBNAIL_CAPTURE_CAP = 5;
      const session = (await supabase.auth.getSession()).data.session;
      if (session?.access_token) {
        const needsCapture = allProjects
          .filter(p => !p.thumbnail_url && !requestedThumbnailsRef.current.has(p.id))
          .slice(0, THUMBNAIL_CAPTURE_CAP);
        for (const p of needsCapture) {
          requestedThumbnailsRef.current.add(p.id);
          fetch(getApiServerUrl(`/api/v1/projects/${p.id}/capture-thumbnail`), {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(urls[p.id] ? { previewUrl: urls[p.id] } : {}),
          }).catch(() => { /* silent   thumbnail is best-effort */ });
        }
      }
    } catch (error) {
      console.error('Error loading projects:', error);
      toast.error('Failed to load projects');
    } finally {
      setIsLoading(false);
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

      const projectName = `project-${Date.now()}`;
      const orgId = currentOrganizationId || null;

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
        // authenticated insert   the projects RLS allows users to create their own.
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

      // Initialize project folder structure in storage   CRITICAL, the edge
      // function doesn't do it.
      try {
        const mod = await import('@/services/projectLifecycleService');
        const svc = mod.projectLifecycleService ?? (mod as any).default;
        if (!svc?.initializeProject) throw new Error('projectLifecycleService not available');
        await svc.initializeProject(newProject.id, user.id);
      } catch (initError) {
        console.error('[Projects] Failed to initialize storage:', initError);
      }

      // Upload staged files now that a projectId exists. Same pipeline the
      // chat composer uses, so an image reaches the model's vision path and
      // place_asset rather than being flattened to text.
      const attachments: AgentAttachment[] = [];
      if (attachedFiles.length > 0) {
        toast.info('Uploading attached files…');
        for (const file of attachedFiles) {
          try {
            const att = await uploadChatAttachment(file, user.id, newProject.id);
            attachments.push({ name: att.name, type: att.type, category: att.category, tempPath: att.tempPath, publicUrl: att.publicUrl });
          } catch (err) {
            console.error('[Projects] Attachment upload failed:', err);
            // Say so rather than degrading silently: the project is already
            // created and we are about to navigate away, so a dropped file
            // would otherwise just never appear with no explanation.
            toast.error(`Couldn't attach ${file.name}. You can add it again from the chat.`);
          }
        }
      }

      toast.success('Project created');
      if (orgId) {
        setCurrentOrganizationId(orgId);
      }
      setAttachedFiles([]);

      if (attachments.length > 0) {
        // Both carriers, for the reason pendingPromptHandoff.ts documents:
        // RequireAuth's redirect rebuilds the URL and drops router state.
        // No initialPrompt -- this surface has no prompt box, so the files
        // land in the chat composer and the user says what they want next.
        stashPendingPrompt(newProject.id, { attachments });
        navigate(`/project/${newProject.id}`, { state: { attachments } });
      } else {
        navigate(`/project/${newProject.id}`);
      }
    } catch (error) {
      console.error('Failed to create project:', error);
      const extractFunctionErrorMessage = async (err: unknown) => {
        const defaultMessage = (err as any)?.message || (typeof err === 'string' ? err : '');
        try {
          const response = (err as any)?.context;
          if (response && typeof response.text === 'function') {
            const raw = await response.text();
            if (raw) {
              const parsed = JSON.parse(raw) as { error?: string; message?: string; details?: string };
              const parts = [parsed.error || parsed.message, parsed.details].filter(Boolean);
              if (parts.length > 0) return parts.join(' - ');
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

  const openProjectWorkspace = (project: Pick<Project, 'id' | 'organization_id'>) => {
    if (project.organization_id) {
      setCurrentOrganizationId(project.organization_id);
    }
    navigate(`/project/${project.id}`);
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
    } catch (error) {
      console.error('Failed to update project status:', error);
      toast.error('Failed to update project status');
    }
  };

  const handleDeleteProject = async () => {
    if (!deleteProjectId) return;

    const projectId = deleteProjectId;

    // 1. Instant UI   remove from list and close the dialog before the network call
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setDeleteProjectId(null);
    toast.success('Project deleted');

    // 2. Fire the backend delete   show error and restore project in list if it fails
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    fetch(getApiServerUrl(`/api/v1/projects/${projectId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Server error ${res.status}`);
      }
    }).catch((err) => {
      console.error('Project deletion failed:', err);
      toast.error(`Failed to delete project: ${(err as Error).message}`);
      loadProjects(); // restore the project in the list
    });
  };

  const canDelete = (project: Project) =>
    !!currentUserId && (project.created_by === currentUserId || project.user_org_role === 'admin');

  const filteredProjects = projects.filter(project => {
    const matchesSearch = project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (project.slug && project.slug.toLowerCase().includes(searchQuery.toLowerCase()));

    // When an org workspace is selected, show ONLY that org's projects.
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
      <div className="p-6 sm:p-8">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
              <div className="h-48 animate-pulse bg-card/60" />
              <div className="flex items-center gap-3 p-4">
                <div className="h-4 w-2/3 animate-pulse rounded bg-card/60" />
              </div>
            </div>
          ))}
        </div>
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
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search projects"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 rounded-full border-border/60 bg-card/60 pl-10 transition-colors focus-visible:border-primary/50"
          />
        </div>

        <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-card/60 p-1">
          <button
            type="button"
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-200 ${viewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Grid3x3 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            aria-label="List view"
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-200 ${viewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={createFileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { handleAttachFiles(e.target.files); e.target.value = ''; }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0 rounded-full border-border/60 p-0"
            onClick={() => createFileInputRef.current?.click()}
            disabled={creating}
            aria-label="Attach files to the new project"
            title="Attach files to the new project"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Button
            className="h-10 gap-1.5 rounded-full bg-primary px-5 font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
            onClick={handleCreateProject}
            disabled={creating}
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Creating…' : 'New project'}
          </Button>
        </div>
      </div>

      {attachedFiles.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            Attached to the next new project:
          </span>
          {attachedFiles.map((file, i) => (
            <span key={`${file.name}-${i}`} className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/80 py-1 pl-2.5 pr-1.5 text-xs text-foreground">
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="max-w-[10rem] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeAttachedFile(i)}
                aria-label={`Remove ${file.name}`}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Tabs
        value={statusFilter}
        onValueChange={(value) => setStatusFilter(value as 'active' | 'deleted' | 'all')}
        className="mb-6"
      >
        <TabsList className="rounded-full border border-border/60 bg-card/40 p-1">
          <TabsTrigger value="active" className="rounded-full data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Active</TabsTrigger>
          <TabsTrigger value="deleted" className="rounded-full data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Archived</TabsTrigger>
          <TabsTrigger value="all" className="rounded-full data-[state=active]:bg-primary/15 data-[state=active]:text-primary">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {filteredProjects.length === 0 ? (
        <Card className="rounded-xl border-dashed border-border/60 bg-card/40">
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <Database className="h-6 w-6 text-primary" />
            </div>
            <h3 className="font-display text-xl font-semibold text-foreground">No projects found</h3>
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">
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
                className="mt-6 h-10 gap-1.5 rounded-full bg-primary px-5 font-medium text-primary-foreground"
              >
                <Plus className="h-4 w-4" />
                {creating ? 'Creating…' : 'Create project'}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3' : 'space-y-3'}>
          {filteredProjects.map((project, i) => (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: Math.min(i, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
            >
              <Card
                className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl transition-all duration-300 hover:-translate-y-0.5 ${project.organization_id
                  ? 'border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)] hover:border-primary/40 hover:shadow-[0_18px_44px_hsl(220_45%_5%/0.3)]'
                  : 'border-amber-500/40 bg-amber-500/[0.04] hover:border-amber-500/60'
                  }`}
                onClick={() => {
                  if (project.status === 'deleted') return;
                  openProjectWorkspace(project);
                }}
              >
                {viewMode === 'grid' && (
                  <ProjectThumbnail
                    projectName={project.name}
                    thumbnailUrl={project.thumbnail_url ?? null}
                    previewUrl={previewUrls[project.id] ?? null}
                  />
                )}
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-display text-base font-semibold text-foreground transition-colors group-hover:text-primary">
                      {project.name}
                    </h3>
                    {!project.organization_id && (
                      <Badge variant="outline" className="mt-1.5 w-fit border-amber-500/30 bg-amber-500/10 text-amber-600">
                        No organization
                      </Badge>
                    )}
                  </div>

                  {project.status === 'deleted' ? (
                    <Button
                      size="sm"
                      className="shrink-0 rounded-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUpdateProjectStatus(project.id, 'active');
                      }}
                    >
                      Restore
                    </Button>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/project/${project.id}/settings`);
                        }}
                        className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
                        title="Project settings"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                      {canDelete(project) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteProjectId(project.id);
                          }}
                          className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-destructive"
                          title="Delete project"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Delete Project Confirmation */}
      <Dialog open={!!deleteProjectId} onOpenChange={(o) => { if (!o) { setDeleteProjectId(null); setDeleteConfirmText(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete project
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the project and all its data including settings and collaborators. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">delete my project</span> to confirm.
            </p>
            <Input
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
              placeholder="delete my project"
              className="font-mono text-sm"
              onKeyDown={e => {
                if (e.key === 'Enter' && deleteConfirmText.trim().toLowerCase() === 'delete my project') {
                  handleDeleteProject();
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => { setDeleteProjectId(null); setDeleteConfirmText(''); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirmText.trim().toLowerCase() !== 'delete my project'}
              onClick={handleDeleteProject}
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
