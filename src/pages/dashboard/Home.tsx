import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  ArrowRight,
  Building2,
  FolderKanban,
  Mail,
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
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useUsage } from '@/contexts/UsageContext';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSubscription } from '@/hooks/useSubscription';
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_invitations' },
        () => {
          loadPendingInvitations();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'org_invitations' },
        () => {
          loadPendingInvitations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(invitationsChannel);
    };
  }, []);

  const loadPendingInvitations = async () => {
    try {
      setLoadingInvitations(true);
      const { data, error } = await supabase.rpc('list_my_pending_invitations');
      if (error) {
        console.error('Failed to load pending invitations:', error);
        setPendingProjectInvitations([]);
        setPendingOrgInvitations([]);
        return;
      }

      const rows = (data || []) as any[];
      setPendingProjectInvitations(
        rows
          .filter((row) => row.invitation_type === 'project')
          .map((row) => ({
            id: row.invitation_id,
            token: row.token,
            project_id: row.project_id,
            project_name: row.project_name || 'Untitled Project',
            inviter_name: row.inviter_name,
            expires_at: row.expires_at,
          }))
      );

      setPendingOrgInvitations(
        rows
          .filter((row) => row.invitation_type === 'organization')
          .map((row) => ({
            id: row.invitation_id,
            token: row.token,
            org_id: row.org_id,
            org_name: row.org_name || 'Organization',
            role: row.role || 'member',
            inviter_name: row.inviter_name,
            expires_at: row.expires_at,
          }))
      );
    } catch (error) {
      console.error('Failed to load pending invitations:', error);
      setPendingProjectInvitations([]);
      setPendingOrgInvitations([]);
    } finally {
      setLoadingInvitations(false);
    }
  };

  const handleAcceptProjectInvitation = async (inv: PendingProjectInvitation) => {
    const key = `project-accept-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { data, error } = await supabase.rpc('accept_project_invitation', { p_token: inv.token });
      if (error) throw error;
      if (!data?.success) {
        toast.error(data?.error || 'Failed to accept project invitation');
        return;
      }

      const { data: project } = await supabase
        .from('projects')
        .select('organization_id')
        .eq('id', inv.project_id)
        .maybeSingle();

      if (project?.organization_id) {
        setCurrentOrganizationId(project.organization_id);
      }

      toast.success(`You now have access to "${inv.project_name}".`);
      await loadPendingInvitations();
      navigate(`/project/${inv.project_id}`);
    } catch (error: any) {
      console.error('Failed to accept project invitation:', error);
      toast.error(error?.message || 'Failed to accept project invitation');
    } finally {
      setActingInvitationKey(null);
    }
  };

  const handleDeclineProjectInvitation = async (inv: PendingProjectInvitation) => {
    const key = `project-decline-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { error } = await supabase
        .from('project_invitations')
        .update({ status: 'declined' })
        .eq('id', inv.id);
      if (error) throw error;
      toast.info('Project invitation declined.');
      await loadPendingInvitations();
    } catch (error: any) {
      console.error('Failed to decline project invitation:', error);
      toast.error(error?.message || 'Failed to decline project invitation');
    } finally {
      setActingInvitationKey(null);
    }
  };

  const handleAcceptOrgInvitation = async (inv: PendingOrgInvitation) => {
    const key = `org-accept-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const user = userData.user;
      if (!user) {
        toast.error('Please sign in again and retry.');
        return;
      }

      const { data: existingMember, error: existingError } = await supabase
        .from('org_members')
        .select('id')
        .eq('org_id', inv.org_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (existingError) throw existingError;

      if (!existingMember) {
        const { error: memberError } = await supabase
          .from('org_members')
          .insert({
            org_id: inv.org_id,
            user_id: user.id,
            role: inv.role,
            joined_at: new Date().toISOString(),
          });
        if (memberError) throw memberError;
      }

      const { error: updateError } = await supabase
        .from('org_invitations')
        .update({ status: 'accepted' })
        .eq('id', inv.id);
      if (updateError) throw updateError;

      toast.success(`You've joined ${inv.org_name}.`);
  setCurrentOrganizationId(inv.org_id);
      await loadPendingInvitations();
      navigate('/dashboard/organizations');
    } catch (error: any) {
      console.error('Failed to accept organization invitation:', error);
      toast.error(error?.message || 'Failed to accept organization invitation');
    } finally {
      setActingInvitationKey(null);
    }
  };

  const handleDeclineOrgInvitation = async (inv: PendingOrgInvitation) => {
    const key = `org-decline-${inv.id}`;
    try {
      setActingInvitationKey(key);
      const { error } = await supabase
        .from('org_invitations')
        .update({ status: 'declined' })
        .eq('id', inv.id);
      if (error) throw error;
      toast.info('Organization invitation declined.');
      await loadPendingInvitations();
    } catch (error: any) {
      console.error('Failed to decline organization invitation:', error);
      toast.error(error?.message || 'Failed to decline organization invitation');
    } finally {
      setActingInvitationKey(null);
    }
  };

  const cards = [
    {
      title: t('dashboard.organizations'),
      description: t('dashboard.organizationsDesc'),
      action: t('dashboard.viewOrganizations'),
      href: '/dashboard/organizations',
      icon: Building2,
      accent: 'from-primary/25 via-primary/10 to-transparent',
    },
    {
      title: t('dashboard.projects'),
      description: t('dashboard.projectsDesc'),
      action: t('dashboard.viewProjects'),
      href: '/dashboard/projects',
      icon: FolderKanban,
      accent: 'from-secondary/30 via-secondary/10 to-transparent',
    },
    {
      title: t('dashboard.profile'),
      description: t('dashboard.profileDesc'),
      action: t('dashboard.editProfile'),
      href: '/dashboard/profile',
      icon: UserIcon,
      accent: 'from-accent/25 via-accent/10 to-transparent',
    },
  ];

  /* ── usage hooks ── */
  const { usageRecord, getUsagePercentage, getUsageLimit } = useUsage();
  const { limits, tier, tierLabel, subscribed, publishLinesPercent } = useSubscription();
  const ecoPercent = getUsagePercentage();
  const ecoLimit = getUsageLimit();
  const fmtNum = (n: number) => new Intl.NumberFormat('en-US').format(n);
  const invitationCount = pendingProjectInvitations.length + pendingOrgInvitations.length;

  /* ── project count ── */
  const [projectCount, setProjectCount] = useState(0);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.user.id)
        .neq('status', 'deleted')
        .then(({ count }) => setProjectCount(count ?? 0));
    });
  }, []);

  const overviewStats = [
    {
      label: 'Plan',
      value: tierLabel || 'Free',
      detail: subscribed ? 'Active' : 'Free tier',
      icon: Sparkles,
      accent: 'text-primary',
      onClick: () => navigate('/dashboard/settings'),
    },
    {
      label: 'Eco Usage',
      value: fmtNum(usageRecord?.ai_gens_used ?? 0),
      detail: `${ecoLimit < 0 ? 'Unlimited' : fmtNum(ecoLimit)} daily`,
      icon: Zap,
      accent: 'text-yellow-400',
    },
    {
      label: 'Projects',
      value: String(projectCount),
      detail: 'In workspace',
      icon: FolderKanban,
      accent: 'text-emerald-400',
      onClick: () => navigate('/dashboard/projects'),
    },
    {
      label: 'Publish Lines',
      value: fmtNum(limits?.publish_lines_used ?? 0),
      detail: `${fmtNum(limits?.publish_lines_limit ?? 30)} monthly`,
      icon: Send,
      accent: 'text-blue-400',
    },
  ];

  const quickActions = [
    {
      title: t('dashboard.projects'),
      href: '/dashboard/projects',
      icon: FolderKanban,
    },
    {
      title: t('dashboard.organizations'),
      href: '/dashboard/organizations',
      icon: Building2,
    },
    {
      title: t('dashboard.profile'),
      href: '/dashboard/profile',
      icon: UserIcon,
    },
    {
      title: t('dashboard.settings'),
      href: '/dashboard/settings',
      icon: Settings,
    },
  ];

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section>
        <Card className="overflow-hidden rounded-none border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] shadow-[0_20px_56px_rgba(3,12,27,0.22)]">
          <CardContent className="relative p-0">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(0,209,178,0.13),transparent_28%),radial-gradient(circle_at_75%_0%,rgba(96,165,250,0.12),transparent_24%)]" />
            <div className="relative flex flex-col gap-6 p-6 lg:flex-row lg:items-center lg:justify-between lg:p-8">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">

                  <Badge variant="outline" className="rounded-none border-white/10 bg-white/[0.03] text-[11px] text-muted-foreground">
                    {subscribed ? 'Pro' : 'Free'}
                  </Badge>
                </div>
                <div>
                  <h1 className="font-['Fraunces'] text-3xl font-semibold leading-tight text-foreground sm:text-4xl">
                    {t('dashboard.welcome')}
                  </h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {invitationCount > 0
                      ? `${invitationCount} pending invitation${invitationCount === 1 ? '' : 's'}`
                      : 'No pending invitations'}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button className="rounded-none" onClick={() => navigate('/dashboard/projects')}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Project
                </Button>
                <Button variant="neutral" className="rounded-none" onClick={() => navigate('/dashboard/agents')}>
                  <Bot className="mr-2 h-4 w-4" />
                  Agents
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {overviewStats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card
              key={stat.label}
              className={`rounded-none border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] transition-colors ${stat.onClick ? 'cursor-pointer hover:border-white/15' : ''}`}
              onClick={stat.onClick}
            >
              <CardContent className="flex items-start justify-between gap-3 p-5">
                <div className="space-y-3">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{stat.label}</p>
                  <div>
                    <p className="text-2xl font-semibold tabular-nums text-foreground">{stat.value}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{stat.detail}</p>
                  </div>
                </div>
                <div className="flex h-11 w-11 items-center justify-center border border-white/10 bg-white/[0.04]">
                  <Icon className={`h-4 w-4 ${stat.accent}`} />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <Card className="rounded-none border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.018))]">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Usage</p>
                  <CardTitle className="mt-2 text-xl">Capacity and output</CardTitle>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <div className="border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 text-yellow-500" />
                    <span className="text-xs font-medium">Eco Usage</span>
                  </div>
                  <span className={`text-xs font-semibold tabular-nums ${getUsageColor(ecoPercent)}`}>{ecoPercent.toFixed(0)}%</span>
                </div>
                {ecoLimit > 0 ? <Progress value={ecoPercent} className={`mt-4 h-1.5 ${getProgressColor(ecoPercent)}`} /> : null}
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {fmtNum(usageRecord?.ai_gens_used ?? 0)} of {ecoLimit < 0 ? 'unlimited' : fmtNum(ecoLimit)} eco used today.
                </p>
              </div>

              <div className="border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send className="h-3.5 w-3.5 text-blue-500" />
                    <span className="text-xs font-medium">Publish Lines</span>
                  </div>
                  <span className={`text-xs font-semibold tabular-nums ${getUsageColor(publishLinesPercent)}`}>{publishLinesPercent}%</span>
                </div>
                <Progress value={publishLinesPercent} className={`mt-4 h-1.5 ${getProgressColor(publishLinesPercent)}`} />
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {fmtNum(limits?.publish_lines_used ?? 0)} of {fmtNum(limits?.publish_lines_limit ?? 30)} lines used this month.
                </p>
              </div>
            </CardContent>
          </Card>

          {!loadingInvitations && invitationCount > 0 ? (
            <Card className="rounded-none border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.018))] shadow-[0_12px_32px_rgba(3,12,27,0.22)]">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Collaboration</p>
                    <CardTitle className="mt-2 flex items-center gap-2 text-xl">
                      Pending invitations
                      <Badge variant="outline" className="rounded-none border-white/12 bg-white/5 text-xs">
                        {invitationCount}
                      </Badge>
                    </CardTitle>
                  </div>
                  <Button
                    variant="neutral"
                    size="sm"
                    className="ml-auto rounded-none"
                    onClick={loadPendingInvitations}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {pendingProjectInvitations.map((inv) => (
                  <div
                    key={`project-${inv.id}`}
                    className="flex flex-col gap-4 border border-white/10 bg-white/[0.03] p-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">Project invite: {inv.project_name}</p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {inv.inviter_name || 'A team member'} invited you. Expires {new Date(inv.expires_at).toLocaleDateString()}.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Review pending
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="rounded-none"
                        disabled={actingInvitationKey !== null}
                        onClick={() => handleAcceptProjectInvitation(inv)}
                      >
                        {actingInvitationKey === `project-accept-${inv.id}` ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-2 h-3.5 w-3.5" />}
                        Accept
                      </Button>
                      <Button
                        variant="neutral"
                        className="rounded-none"
                        disabled={actingInvitationKey !== null}
                        onClick={() => handleDeclineProjectInvitation(inv)}
                      >
                        {actingInvitationKey === `project-decline-${inv.id}` ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <X className="mr-2 h-3.5 w-3.5" />}
                        Decline
                      </Button>
                      <Button
                        variant="ghost"
                        className="rounded-none border border-white/10 bg-white/5"
                        disabled={actingInvitationKey !== null}
                        onClick={() => navigate(`/project-invite/${inv.token}`)}
                      >
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
                {pendingOrgInvitations.map((inv) => (
                  <div
                    key={`org-${inv.id}`}
                    className="flex flex-col gap-4 border border-white/10 bg-white/[0.03] p-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">Organization invite: {inv.org_name}</p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {inv.inviter_name || 'A team member'} invited you as {inv.role}. Expires {new Date(inv.expires_at).toLocaleDateString()}.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Membership pending
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="rounded-none"
                        disabled={actingInvitationKey !== null}
                        onClick={() => handleAcceptOrgInvitation(inv)}
                      >
                        {actingInvitationKey === `org-accept-${inv.id}` ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-2 h-3.5 w-3.5" />}
                        Accept
                      </Button>
                      <Button
                        variant="neutral"
                        className="rounded-none"
                        disabled={actingInvitationKey !== null}
                        onClick={() => handleDeclineOrgInvitation(inv)}
                      >
                        {actingInvitationKey === `org-decline-${inv.id}` ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <X className="mr-2 h-3.5 w-3.5" />}
                        Decline
                      </Button>
                      <Button
                        variant="ghost"
                        className="rounded-none border border-white/10 bg-white/5"
                        disabled={actingInvitationKey !== null}
                        onClick={() => navigate(`/invite/${inv.token}`)}
                      >
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <Card className="rounded-none border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))]">
              <CardContent className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Collaboration</p>
                  <p className="mt-2 text-lg font-medium text-foreground">No pending invitations</p>
                  <p className="mt-1 text-sm text-muted-foreground">New project and organization requests will appear here.</p>
                </div>
                <Button variant="neutral" className="rounded-none" onClick={loadPendingInvitations}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh invitations
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="rounded-none border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.018))]">
            <CardHeader className="pb-3">
              <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Actions</p>
              <CardTitle className="mt-2 text-xl">Quick access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.href}
                    type="button"
                    className="flex w-full items-center gap-4 border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-white/15 hover:bg-white/[0.05]"
                    onClick={() => navigate(action.href)}
                  >
                    <div className="flex h-11 w-11 items-center justify-center border border-white/10 bg-white/[0.04]">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{action.title}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card className="overflow-hidden rounded-none border-white/10 bg-[linear-gradient(135deg,rgba(0,209,178,0.05),rgba(138,43,226,0.04))]">
            <CardContent className="relative p-6">
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.025) 1px, transparent 1px)',
                  backgroundSize: '20px 20px',
                }}
              />
              <div className="relative space-y-5">
                <div className="flex h-14 w-14 items-center justify-center border border-primary/20 bg-primary/10">
                  <Bot className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-foreground">AI Agents</h3>
                    <Badge variant="outline" className="rounded-none border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
                      New
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">Build, edit, and operate without leaving the workspace.</p>
                </div>
                <Button
                  variant="neutral"
                  className="w-full justify-between rounded-none"
                  onClick={() => navigate('/dashboard/agents')}
                >
                  Explore agents
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
