import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  ArrowRight,
  Building2,
  FolderKanban,
  RefreshCw,
  User as UserIcon,
  Bot,
  Zap,
  Settings,
  Plus,
  Clock,
  Sparkles,
  Send,
  Check,
  X,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useUsage } from '@/contexts/UsageContext';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { getUsageColor, getProgressColor } from '@/hooks/useUsage';
import { toast } from 'sonner';

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

export default function DashboardHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setCurrentOrganizationId } = useOrganization();
  const [pendingProjectInvitations, setPendingProjectInvitations] = useState<PendingProjectInvitation[]>([]);
  const [pendingOrgInvitations, setPendingOrgInvitations] = useState<PendingOrgInvitation[]>([]);
  const [loadingInvitations, setLoadingInvitations] = useState(true);
  const [actingInvitationKey, setActingInvitationKey] = useState<string | null>(null);

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
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      supabase.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', session.user.id).neq('status', 'deleted').then(({ count }) => setProjectCount(count ?? 0));
    });
  }, []);

  const stats = [
    { label: 'Plan', value: tierLabel || 'Free', detail: subscribed ? 'Active' : 'Free tier', icon: Sparkles, color: 'text-indigo-400', onClick: () => navigate('/dashboard/settings') },
    { label: 'Eco Usage', value: fmtNum(usageRecord?.ai_gens_used ?? 0), detail: `of ${ecoLimit < 0 ? '∞' : fmtNum(ecoLimit)} today`, icon: Zap, color: 'text-amber-400' },
    { label: 'Projects', value: String(projectCount), detail: 'In workspace', icon: FolderKanban, color: 'text-emerald-400', onClick: () => navigate('/dashboard/projects') },
    { label: 'Publish Lines', value: fmtNum(limits?.publish_lines_used ?? 0), detail: `of ${fmtNum(limits?.publish_lines_limit ?? 30)} this month`, icon: Send, color: 'text-sky-400' },
  ];

  const quickActions = [
    { title: t('dashboard.projects'), href: '/dashboard/projects', icon: FolderKanban },
    { title: t('dashboard.organizations'), href: '/dashboard/organizations', icon: Building2 },
    { title: t('dashboard.profile'), href: '/dashboard/profile', icon: UserIcon },
    { title: t('dashboard.settings'), href: '/dashboard/settings', icon: Settings },
  ];

  return (
    <div className="space-y-5 px-5 py-6 sm:px-6 lg:px-8">

      {/* Hero banner */}
      <div className="relative overflow-hidden rounded-xl border border-white/[0.06] bg-[#0e0e10] px-6 py-6 lg:px-8 lg:py-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_0%_50%,rgba(99,102,241,0.08),transparent)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/30">Dashboard</p>
            <h1 className="mt-1.5 font-['Fraunces'] text-2xl font-semibold text-white/80 sm:text-3xl">
              {t('dashboard.welcome')}
            </h1>
            {invitationCount > 0 && (
              <p className="mt-1 text-sm text-amber-400/80">
                {invitationCount} pending invitation{invitationCount !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <Button
            className="h-9 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-500 shrink-0"
            onClick={() => navigate('/dashboard/projects')}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New Project
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <button
              key={stat.label}
              type="button"
              className={`group rounded-xl border border-white/[0.06] bg-[#0e0e10] p-5 text-left transition-colors duration-150 ${stat.onClick ? 'hover:border-white/[0.08] hover:bg-white/[0.04] cursor-pointer' : 'cursor-default'}`}
              onClick={stat.onClick}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-white/30">{stat.label}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-white/70">{stat.value}</p>
                  <p className="mt-1 text-xs text-white/30">{stat.detail}</p>
                </div>
                <div className={`mt-0.5 shrink-0 ${stat.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Main grid */}
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">

        {/* Left column */}
        <div className="space-y-4">

          {/* Usage card */}
          <div className="rounded-xl border border-white/[0.06] bg-[#0e0e10] p-6">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/30">Usage</p>
            <p className="mt-1.5 text-base font-medium text-white/80">Capacity &amp; output</p>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 text-amber-400" />
                    <span className="text-xs font-medium text-white/70">Eco Usage</span>
                  </div>
                  <span className={`text-xs font-semibold tabular-nums ${getUsageColor(ecoPercent)}`}>{ecoPercent.toFixed(0)}%</span>
                </div>
                {ecoLimit > 0 && <Progress value={ecoPercent} className={`mt-3 h-1 ${getProgressColor(ecoPercent)}`} />}
                <p className="mt-3 text-xs text-white/30">
                  {fmtNum(usageRecord?.ai_gens_used ?? 0)} of {ecoLimit < 0 ? 'unlimited' : fmtNum(ecoLimit)} eco used today.
                </p>
              </div>
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send className="h-3.5 w-3.5 text-sky-400" />
                    <span className="text-xs font-medium text-white/70">Publish Lines</span>
                  </div>
                  <span className={`text-xs font-semibold tabular-nums ${getUsageColor(publishLinesPercent)}`}>{publishLinesPercent}%</span>
                </div>
                <Progress value={publishLinesPercent} className={`mt-3 h-1 ${getProgressColor(publishLinesPercent)}`} />
                <p className="mt-3 text-xs text-white/30">
                  {fmtNum(limits?.publish_lines_used ?? 0)} of {fmtNum(limits?.publish_lines_limit ?? 30)} lines used this month.
                </p>
              </div>
            </div>
          </div>

          {/* Invitations */}
          {!loadingInvitations && invitationCount > 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-[#0e0e10] p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-white/30">Collaboration</p>
                  <p className="mt-1.5 text-base font-medium text-white/80">
                    Pending invitations
                    <span className="ml-2 inline-flex h-5 items-center justify-center rounded-full bg-amber-500/15 px-2 text-[11px] font-semibold text-amber-400">{invitationCount}</span>
                  </p>
                </div>
                <button type="button" onClick={loadPendingInvitations} className="rounded-md p-1.5 text-white/30 hover:bg-white/[0.05] hover:text-white/55">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-3">
                {pendingProjectInvitations.map((inv) => (
                  <div key={`project-${inv.id}`} className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium text-white/80">Project invite: {inv.project_name}</p>
                        <p className="mt-0.5 text-xs text-white/30">{inv.inviter_name || 'A team member'} invited you · expires {new Date(inv.expires_at).toLocaleDateString()}</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-white/30">
                        <Clock className="h-3.5 w-3.5" />
                        Pending
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" className="h-8 rounded-lg bg-indigo-600 px-3 text-xs hover:bg-indigo-500" disabled={actingInvitationKey !== null} onClick={() => handleAcceptProjectInvitation(inv)}>
                        {actingInvitationKey === `project-accept-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}Accept
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 rounded-lg border border-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/80" disabled={actingInvitationKey !== null} onClick={() => handleDeclineProjectInvitation(inv)}>
                        {actingInvitationKey === `project-decline-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <X className="mr-1.5 h-3 w-3" />}Decline
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 rounded-lg border border-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/80" disabled={actingInvitationKey !== null} onClick={() => navigate(`/project-invite/${inv.token}`)}>
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
                {pendingOrgInvitations.map((inv) => (
                  <div key={`org-${inv.id}`} className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium text-white/80">Organization invite: {inv.org_name}</p>
                        <p className="mt-0.5 text-xs text-white/30">{inv.inviter_name || 'A team member'} invited you as {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-white/30">
                        <Clock className="h-3.5 w-3.5" />
                        Pending
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" className="h-8 rounded-lg bg-indigo-600 px-3 text-xs hover:bg-indigo-500" disabled={actingInvitationKey !== null} onClick={() => handleAcceptOrgInvitation(inv)}>
                        {actingInvitationKey === `org-accept-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}Accept
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 rounded-lg border border-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/80" disabled={actingInvitationKey !== null} onClick={() => handleDeclineOrgInvitation(inv)}>
                        {actingInvitationKey === `org-decline-${inv.id}` ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <X className="mr-1.5 h-3 w-3" />}Decline
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 rounded-lg border border-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/80" disabled={actingInvitationKey !== null} onClick={() => navigate(`/invite/${inv.token}`)}>
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-white/[0.06] bg-[#0e0e10] p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-white/30">Collaboration</p>
                  <p className="mt-1.5 text-base font-medium text-white/80">No pending invitations</p>
                  <p className="mt-1 text-sm text-white/30">New project and organization requests will appear here.</p>
                </div>
                <button type="button" onClick={loadPendingInvitations} className="flex shrink-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-xs text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white/70">
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
          <div className="rounded-xl border border-white/[0.06] bg-[#0e0e10] p-5">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/30">Actions</p>
            <p className="mt-1.5 text-sm font-medium text-white/70">Quick access</p>
            <div className="mt-4 space-y-1">
              {quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.href}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 hover:bg-white/[0.05]"
                    onClick={() => navigate(action.href)}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-white/30" />
                    <span className="flex-1 text-sm text-white/55">{action.title}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-white/20" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* AI Agents promo */}
          <div className="relative overflow-hidden rounded-xl border border-indigo-500/20 bg-[#0e0e10] p-5">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_90%_70%_at_50%_110%,rgba(99,102,241,0.12),transparent)]" />
            <div className="relative">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10">
                <Bot className="h-5 w-5 text-indigo-400" />
              </div>
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-white/70">AI Agents</p>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">New</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-white/40">Build, edit, and operate without leaving the workspace.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
