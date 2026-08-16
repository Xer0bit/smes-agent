/* Hallmark · macrostructure: Marquee Hero (studied DNA: Lovable dashboard
 * reference — greeting + centered prompt bar + recents grid) · genre: editorial
 * theme: minimal (single-accent cyan, secondary/accent tokens flattened to
 * neutral — supersedes the prior multi-hue "brand" decision recorded here;
 * see src/index.css tokens) · Fraunces/Manrope retained
 * tone: restrained · enrichment: none (real project thumbnails are the imagery)
 * motion: framer-motion, restrained · differs from prior Workbench pick
 * pre-emit critique: P4 H4 E4 S4 R4 V4
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  ArrowRight,
  Building2,
  FolderKanban,
  RefreshCw,
  Bot,
  Zap,
  Settings,
  Clock,
  Sparkles,
  Send,
  Check,
  X,
  Loader2,
  ChevronRight,
  Paperclip,
  FileText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useUsage } from '@/contexts/UsageContext';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { getUsageColor, getProgressColor } from '@/hooks/useUsage';
import { ProjectThumbnail } from '@/components/dashboard/ProjectThumbnail';
import { toast } from 'sonner';
import { uploadChatAttachment, isAllowedFile } from '@/services/chatAttachmentService';
import { stashPendingPrompt } from '@/services/pendingPromptHandoff';
import type { AgentAttachment } from '@/eCG/UserPrompt/types';

type PendingProjectInvitation = {
  id: string;
  token: string;
  project_id: string;
  project_name: string;
  inviter_name?: string;
  expires_at: string;
};

type PendingOrgInvitation = {
  id: string;
  token: string;
  org_id: string;
  org_name: string;
  role: string;
  inviter_name?: string;
  expires_at: string;
};

type RecentProject = {
  id: string;
  name: string;
  updated_at: string;
  thumbnail_url: string | null;
};

const HERO_PROMPT_EXAMPLES = [
  'a landing page for my SaaS product',
  'an online store for handmade candles',
  'a portfolio site with a project gallery',
  'a booking page for a fitness studio',
  'a blog with a newsletter signup',
];

const HERO_TEXTAREA_LINE_HEIGHT = 24;
const HERO_TEXTAREA_MAX_LINES = 6;

export default function DashboardHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentOrganizationId, organizations, setCurrentOrganizationId } = useOrganization();
  const [pendingProjectInvitations, setPendingProjectInvitations] = useState<PendingProjectInvitation[]>([]);
  const [pendingOrgInvitations, setPendingOrgInvitations] = useState<PendingOrgInvitation[]>([]);
  const [loadingInvitations, setLoadingInvitations] = useState(true);
  const [actingInvitationKey, setActingInvitationKey] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');

  useEffect(() => {
    loadPendingInvitations();
    const invitationsChannel = supabase
      .channel('dashboard-home-invitations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_invitations' }, () => loadPendingInvitations())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'org_invitations' }, () => loadPendingInvitations())
      .subscribe();
    return () => { supabase.removeChannel(invitationsChannel); };
  }, []);

  const loadPendingInvitations = async () => {
    try {
      setLoadingInvitations(true);
      const { data, error } = await supabase.rpc('list_my_pending_invitations');
      if (error) { setPendingProjectInvitations([]); setPendingOrgInvitations([]); return; }
      const rows = (data || []) as any[];
      setPendingProjectInvitations(rows.filter((r) => r.invitation_type === 'project').map((r) => ({ id: r.invitation_id, token: r.token, project_id: r.project_id, project_name: r.project_name || 'Untitled Project', inviter_name: r.inviter_name, expires_at: r.expires_at })));
      setPendingOrgInvitations(rows.filter((r) => r.invitation_type === 'organization').map((r) => ({ id: r.invitation_id, token: r.token, org_id: r.org_id, org_name: r.org_name || 'Organization', role: r.role || 'member', inviter_name: r.inviter_name, expires_at: r.expires_at })));
    } catch { setPendingProjectInvitations([]); setPendingOrgInvitations([]); }
    finally { setLoadingInvitations(false); }
  };

  const handleAcceptProjectInvitation = async (inv: PendingProjectInvitation) => {
    const key = `project-accept-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { data, error } = await supabase.rpc('accept_project_invitation', { p_token: inv.token });
      if (error) throw error;
      if (!data?.success) { toast.error(data?.error || 'Failed to accept project invitation'); return; }
      const { data: project } = await supabase.from('projects').select('organization_id').eq('id', inv.project_id).maybeSingle();
      if (project?.organization_id) setCurrentOrganizationId(project.organization_id);
      toast.success(`You now have access to "${inv.project_name}".`);
      await loadPendingInvitations();
      navigate(`/project/${inv.project_id}`);
    } catch (error: any) { toast.error(error?.message || 'Failed to accept project invitation'); }
    finally { setActingInvitationKey(null); }
  };

  const handleDeclineProjectInvitation = async (inv: PendingProjectInvitation) => {
    const key = `project-decline-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { error } = await supabase.from('project_invitations').update({ status: 'declined' }).eq('id', inv.id);
      if (error) throw error;
      toast.info('Project invitation declined.');
      await loadPendingInvitations();
    } catch (error: any) { toast.error(error?.message || 'Failed'); }
    finally { setActingInvitationKey(null); }
  };

  const handleAcceptOrgInvitation = async (inv: PendingOrgInvitation) => {
    const key = `org-accept-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const user = userData.user;
      if (!user) { toast.error('Please sign in again and retry.'); return; }
      const { data: existingMember } = await supabase.from('org_members').select('id').eq('org_id', inv.org_id).eq('user_id', user.id).maybeSingle();
      if (!existingMember) {
        const { error: memberError } = await supabase.from('org_members').insert({ org_id: inv.org_id, user_id: user.id, role: inv.role, joined_at: new Date().toISOString() });
        if (memberError) throw memberError;
      }
      const { error: updateError } = await supabase.from('org_invitations').update({ status: 'accepted' }).eq('id', inv.id);
      if (updateError) throw updateError;
      toast.success(`You've joined ${inv.org_name}.`);
      setCurrentOrganizationId(inv.org_id);
      await loadPendingInvitations();
      navigate('/dashboard/organizations');
    } catch (error: any) { toast.error(error?.message || 'Failed'); }
    finally { setActingInvitationKey(null); }
  };

  const handleDeclineOrgInvitation = async (inv: PendingOrgInvitation) => {
    const key = `org-decline-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { error } = await supabase.from('org_invitations').update({ status: 'declined' }).eq('id', inv.id);
      if (error) throw error;
      toast.info('Organization invitation declined.');
      await loadPendingInvitations();
    } catch (error: any) { toast.error(error?.message || 'Failed'); }
    finally { setActingInvitationKey(null); }
  };

  /* ── usage ── */
  const { usageRecord, getUsagePercentage, getUsageLimit } = useUsage();
  const { limits, tierLabel, subscribed, publishLinesPercent } = useSubscription();
  const ecoPercent = getUsagePercentage();
  const ecoLimit = getUsageLimit();
  const fmtNum = (n: number) => new Intl.NumberFormat('en-US').format(n);
  const invitationCount = pendingProjectInvitations.length + pendingOrgInvitations.length;

  const [projectCount, setProjectCount] = useState(0);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      setFirstName((session.user.user_metadata?.full_name || '').trim().split(' ')[0] || '');
      supabase.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', session.user.id).neq('status', 'deleted').then(({ count }) => setProjectCount(count ?? 0));
      supabase.from('projects').select('id, name, updated_at, thumbnail_url').eq('user_id', session.user.id).neq('status', 'deleted').order('updated_at', { ascending: false }).limit(4)
        .then(({ data }) => { setRecentProjects(data || []); setLoadingRecent(false); });
    });
  }, []);

  const stats = [
    { label: 'Plan', value: tierLabel || 'Free', detail: subscribed ? 'Active' : 'Free tier', icon: Sparkles, onClick: () => navigate('/dashboard/settings') },
    { label: 'Eco Usage', value: fmtNum(usageRecord?.ai_gens_used ?? 0), detail: `of ${ecoLimit < 0 ? '∞' : fmtNum(ecoLimit)} today`, icon: Zap },
    { label: 'Projects', value: String(projectCount), detail: 'in workspace', icon: FolderKanban, onClick: () => navigate('/dashboard/projects') },
    { label: 'Publish Lines', value: fmtNum(limits?.publish_lines_used ?? 0), detail: `of ${fmtNum(limits?.publish_lines_limit ?? 30)} this month`, icon: Send },
  ];

  const quickActions = [
    { title: t('dashboard.projects'), href: '/dashboard/projects', icon: FolderKanban },
    { title: 'Workspace Settings', href: '/dashboard/organizations', icon: Building2 },
    { title: t('dashboard.settings'), href: '/dashboard/settings', icon: Settings },
  ];

  /* ── hero prompt → new project ── */
  const [heroPrompt, setHeroPrompt] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [launching, setLaunching] = useState(false);
  const heroFileInputRef = useRef<HTMLInputElement>(null);
  const heroTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Typewriter placeholder   cycles through example prompts while the
  // textarea is empty, pauses as soon as the user starts typing.
  const [typedPlaceholder, setTypedPlaceholder] = useState('');
  useEffect(() => {
    if (heroPrompt) return;
    let exampleIndex = 0;
    let charIndex = 0;
    let deleting = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const tick = () => {
      const full = `Ask AI to build ${HERO_PROMPT_EXAMPLES[exampleIndex]}`;
      if (!deleting) {
        charIndex++;
        setTypedPlaceholder(full.slice(0, charIndex));
        timeoutId = setTimeout(tick, charIndex === full.length ? 1800 : 35);
        if (charIndex === full.length) deleting = true;
      } else {
        charIndex--;
        setTypedPlaceholder(full.slice(0, charIndex));
        timeoutId = setTimeout(tick, charIndex === 0 ? 400 : 20);
        if (charIndex === 0) {
          deleting = false;
          exampleIndex = (exampleIndex + 1) % HERO_PROMPT_EXAMPLES.length;
        }
      }
    };
    timeoutId = setTimeout(tick, 300);
    return () => clearTimeout(timeoutId);
  }, [heroPrompt]);

  // Auto-grow the textarea as the user writes, capped at ~6 lines, then
  // it scrolls internally instead of pushing the rest of the hero down.
  useEffect(() => {
    const el = heroTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = HERO_TEXTAREA_LINE_HEIGHT * HERO_TEXTAREA_MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [heroPrompt]);

  const handleAttachFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (attachedFiles.length + files.length > 10) {
      toast.error('Maximum 10 files allowed');
      return;
    }
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        toast.error(`File ${file.name} exceeds 20MB limit`);
        return;
      }
    }
    setAttachedFiles((prev) => [...prev, ...Array.from(files)]);
  };

  const removeAttachedFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleLaunch = async () => {
    const prompt = heroPrompt.trim();
    if (!prompt || launching) return;
    setLaunching(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const orgId = currentOrganizationId || organizations[0]?.id || null;
      const projectName = `project-${Date.now()}`;

      const { data, error } = await supabase.functions.invoke<{ success: boolean; project: { id: string } }>('revision-create-project', {
        body: { name: projectName, user_id: user.id, organization_id: orgId },
      });
      if (error) throw error;
      const newProject = data?.project;
      if (!newProject?.id) throw new Error('Project not created');

      if (orgId) setCurrentOrganizationId(orgId);

      // Upload attachments through the agent pipeline so images actually
      // reach the model (vision + place_asset server-side). parse-file is
      // only the fallback for types the attachment service doesn't accept.
      let fileContext = '';
      const attachments: AgentAttachment[] = [];
      if (attachedFiles.length > 0) {
        toast.info('Processing attached files…');
        for (const file of attachedFiles) {
          if (isAllowedFile(file).ok) {
            try {
              const att = await uploadChatAttachment(file, user.id, newProject.id);
              attachments.push({ name: att.name, type: att.type, category: att.category, tempPath: att.tempPath, publicUrl: att.publicUrl });
              continue;
            } catch (err) {
              console.error('Attachment upload failed, falling back to parse-file:', err);
            }
          }
          const formData = new FormData();
          formData.append('file', file);
          const { data: parseData, error: parseError } = await supabase.functions.invoke('parse-file', { body: formData });
          if (parseError) {
            toast.error(`Failed to parse ${file.name}`);
          } else if (parseData?.extractedText) {
            fileContext += `\n\n${parseData.extractedText}`;
          }
        }
      }

      // See pendingPromptHandoff.ts: location.state alone isn't reliable
      // through RequireAuth's redirect, so also stash a sessionStorage
      // fallback Editor.tsx can consume if state comes back empty.
      stashPendingPrompt(newProject.id, { initialPrompt: prompt, fileContext, attachments: attachments.length > 0 ? attachments : undefined });

      navigate(`/project/${newProject.id}`, { state: { initialPrompt: prompt, shouldGenerate: true, fileContext, attachments: attachments.length > 0 ? attachments : undefined } });
    } catch (error: any) {
      console.error('Failed to launch project from prompt:', error);
      toast.error(error?.message || 'Failed to start a new project');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="space-y-6 px-5 py-6 sm:px-6 lg:px-8">

      {/* ── Hero: greeting + prompt bar ── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative overflow-hidden rounded-2xl border border-border/60 bg-card px-6 py-16 sm:px-10 lg:py-24"
      >
        <div className="relative mx-auto max-w-2xl text-center">
          {invitationCount > 0 && (
            <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400">
              {invitationCount} pending invitation{invitationCount !== 1 ? 's' : ''}
            </span>
          )}
          <h1 className="font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-[3.25rem]">
            Let&apos;s build something{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Describe what you want and I&apos;ll start a new project around it.
          </p>

          <div className="mt-9 rounded-2xl border border-border/60 bg-background/70 p-3 text-left shadow-[var(--elev-2)] transition-colors duration-150 focus-within:border-primary/50">
            {attachedFiles.length > 0 && (
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {attachedFiles.map((file, i) => (
                  <span key={`${file.name}-${i}`} className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/80 py-1 pl-2.5 pr-1.5 text-xs text-foreground">
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="max-w-[10rem] truncate">{file.name}</span>
                    <button type="button" onClick={() => removeAttachedFile(i)} className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={heroTextareaRef}
                rows={1}
                value={heroPrompt}
                onChange={(e) => setHeroPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleLaunch(); } }}
                placeholder={typedPlaceholder}
                className="min-h-[2.25rem] flex-1 resize-none overflow-y-auto border-0 bg-transparent text-sm text-foreground outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-muted-foreground"
                disabled={launching}
              />
              <input
                ref={heroFileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { handleAttachFiles(e.target.files); e.target.value = ''; }}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-9 w-9 shrink-0 rounded-full border-border/60"
                onClick={() => heroFileInputRef.current?.click()}
                disabled={launching}
                title="Attach a document"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                className="h-9 w-9 shrink-0 rounded-full"
                onClick={handleLaunch}
                disabled={!heroPrompt.trim() || launching}
              >
                {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── Recent projects ── */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-foreground">Recent projects</h2>
          <button type="button" onClick={() => navigate('/dashboard/projects')} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            View all
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {loadingRecent ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-48 animate-pulse rounded-xl border border-border/60 bg-card/40" />
            ))}
          </div>
        ) : recentProjects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-10 text-center">
            <p className="text-sm text-muted-foreground">No projects yet — describe what you want to build above to start your first one.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {recentProjects.map((project, i) => (
              <motion.button
                key={project.id}
                type="button"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => navigate(`/project/${project.id}`)}
                className="group overflow-hidden rounded-xl border border-border/60 bg-card text-left shadow-[var(--elev-1)] transition-shadow duration-200 hover:shadow-[var(--elev-2)]"
              >
                <ProjectThumbnail projectName={project.name} thumbnailUrl={project.thumbnail_url} previewUrl={null} />
                <div className="p-4">
                  <p className="truncate font-display text-sm font-semibold text-foreground">{project.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Updated {new Date(project.updated_at).toLocaleDateString()}</p>
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </div>

      {/* ── Main grid ── */}
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">

        {/* Left column */}
        <div className="space-y-4">

          {/* Usage card */}

          {/* Invitations */}
          {!loadingInvitations && invitationCount > 0 ? (
            <div className="rounded-xl border border-border/60 bg-card p-6 shadow-[var(--elev-1)]">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Collaboration</p>
                  <p className="mt-1.5 font-display text-base font-semibold text-foreground">
                    Pending invitations
                    <span className="ml-2 inline-flex h-5 items-center justify-center rounded-full bg-amber-500/15 px-2 text-[11px] font-semibold text-amber-400">{invitationCount}</span>
                  </p>
                </div>
                <button type="button" onClick={loadPendingInvitations} className="rounded-full p-1.5 text-muted-foreground hover:bg-card/80 hover:text-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-3">
                {pendingProjectInvitations.map((inv) => (
                  <div key={`project-${inv.id}`} className="rounded-lg border border-border/60 bg-background/60 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">Project invite: {inv.project_name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{inv.inviter_name || 'A team member'} invited you · expires {new Date(inv.expires_at).toLocaleDateString()}</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Pending
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" className="h-8 rounded-full px-3 text-xs" disabled={actingInvitationKey !== null} onClick={() => handleAcceptProjectInvitation(inv)}>
                        {actingInvitationKey === `project-accept-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}Accept
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 rounded-full border-border/60 px-3 text-xs" disabled={actingInvitationKey !== null} onClick={() => handleDeclineProjectInvitation(inv)}>
                        {actingInvitationKey === `project-decline-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <X className="mr-1.5 h-3 w-3" />}Decline
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 rounded-full border-border/60 px-3 text-xs" disabled={actingInvitationKey !== null} onClick={() => navigate(`/project-invite/${inv.token}`)}>
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
                {pendingOrgInvitations.map((inv) => (
                  <div key={`org-${inv.id}`} className="rounded-lg border border-border/60 bg-background/60 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">Organization invite: {inv.org_name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{inv.inviter_name || 'A team member'} invited you as {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Pending
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" className="h-8 rounded-full px-3 text-xs" disabled={actingInvitationKey !== null} onClick={() => handleAcceptOrgInvitation(inv)}>
                        {actingInvitationKey === `org-accept-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}Accept
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 rounded-full border-border/60 px-3 text-xs" disabled={actingInvitationKey !== null} onClick={() => handleDeclineOrgInvitation(inv)}>
                        {actingInvitationKey === `org-decline-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <X className="mr-1.5 h-3 w-3" />}Decline
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 rounded-full border-border/60 px-3 text-xs" disabled={actingInvitationKey !== null} onClick={() => navigate(`/invite/${inv.token}`)}>
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border/60 bg-card p-6 shadow-[var(--elev-1)]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Collaboration</p>
                  <p className="mt-1.5 font-display text-base font-semibold text-foreground">No pending invitations</p>
                  <p className="mt-1 text-sm text-muted-foreground">New project and organization requests will appear here.</p>
                </div>
                <button type="button" onClick={loadPendingInvitations} className="flex shrink-0 items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">

          {/* Quick access */}
          <div className="rounded-xl border border-border/60 bg-card p-5 shadow-[var(--elev-1)]">
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Actions</p>
            <p className="mt-1.5 text-sm font-medium text-foreground">Quick access</p>
            <div className="mt-4 space-y-1">
              {quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.href}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 hover:bg-background/60"
                    onClick={() => navigate(action.href)}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 text-sm text-foreground/80">{action.title}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* AI Agents promo */}
          <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-card p-5 shadow-[var(--elev-1)]">
            <div className="relative">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Bot className="h-5 w-5 text-primary" />
              </div>
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <p className="font-display text-sm font-semibold text-foreground">AI Agents</p>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">New</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">Build, edit, and operate without leaving the workspace.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
