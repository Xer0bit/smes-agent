import { useEffect, useState, useCallback } from 'react';
import { Bell, Check, X, Clock, Building2, FolderKanban, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
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

export function NotificationBell() {
  const navigate = useNavigate();
  const { setCurrentOrganizationId } = useOrganization();
  const [projectInvitations, setProjectInvitations] = useState<PendingProjectInvitation[]>([]);
  const [orgInvitations, setOrgInvitations] = useState<PendingOrgInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const totalCount = projectInvitations.length + orgInvitations.length;

  const loadInvitations = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.rpc('list_my_pending_invitations');
      if (error) {
        console.error('Failed to load pending invitations:', error);
        setProjectInvitations([]);
        setOrgInvitations([]);
        return;
      }

      const rows = (data || []) as any[];
      setProjectInvitations(
        rows
          .filter((r) => r.invitation_type === 'project')
          .map((r) => ({
            id: r.invitation_id,
            token: r.token,
            project_id: r.project_id,
            project_name: r.project_name || 'Untitled Project',
            inviter_name: r.inviter_name,
            expires_at: r.expires_at,
          }))
      );
      setOrgInvitations(
        rows
          .filter((r) => r.invitation_type === 'organization')
          .map((r) => ({
            id: r.invitation_id,
            token: r.token,
            org_id: r.org_id,
            org_name: r.org_name || 'Organization',
            role: r.role || 'member',
            inviter_name: r.inviter_name,
            expires_at: r.expires_at,
          }))
      );
    } catch (err) {
      console.error('Failed to load pending invitations:', err);
      setProjectInvitations([]);
      setOrgInvitations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvitations();

    const channel = supabase
      .channel('notification-bell-invitations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_invitations' }, () => loadInvitations())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'org_invitations' }, () => loadInvitations())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadInvitations]);

  const handleAcceptOrg = async (inv: PendingOrgInvitation) => {
    const key = `org-accept-${inv.id}`;
    try {
      setActingKey(key);
      const { data, error } = await supabase.rpc('accept_org_invitation', { p_token: inv.token as any });
      if (error) throw error;
      if (data && !data.success) { toast.error(data.error || 'Failed to accept invitation'); return; }

      toast.success(`You've joined ${inv.org_name}.`);
      setCurrentOrganizationId(inv.org_id);
      setOpen(false);
      await loadInvitations();
      navigate('/dashboard/organizations');
    } catch (err: any) {
      console.error('Failed to accept org invitation:', err);
      toast.error(err?.message || 'Failed to accept invitation');
    } finally {
      setActingKey(null);
    }
  };

  const handleDeclineOrg = async (inv: PendingOrgInvitation) => {
    const key = `org-decline-${inv.id}`;
    try {
      setActingKey(key);
      const { data, error } = await supabase.rpc('decline_org_invitation', { p_token: inv.token as any });
      if (error) throw error;
      if (data && !data.success) { toast.error(data.error || 'Failed to decline invitation'); return; }
      toast.info('Organization invitation declined.');
      await loadInvitations();
    } catch (err: any) {
      console.error('Failed to decline org invitation:', err);
      toast.error(err?.message || 'Failed to decline invitation');
    } finally {
      setActingKey(null);
    }
  };

  const handleAcceptProject = async (inv: PendingProjectInvitation) => {
    const key = `project-accept-${inv.id}`;
    try {
      setActingKey(key);
      const { data, error } = await supabase.rpc('accept_project_invitation', { p_token: inv.token });
      if (error) throw error;
      if (!data?.success) { toast.error(data?.error || 'Failed to accept invitation'); return; }

      const { data: project } = await supabase
        .from('projects')
        .select('organization_id')
        .eq('id', inv.project_id)
        .maybeSingle();
      if (project?.organization_id) setCurrentOrganizationId(project.organization_id);

      toast.success(`You now have access to "${inv.project_name}".`);
      setOpen(false);
      await loadInvitations();
      navigate(`/project/${inv.project_id}`);
    } catch (err: any) {
      console.error('Failed to accept project invitation:', err);
      toast.error(err?.message || 'Failed to accept invitation');
    } finally {
      setActingKey(null);
    }
  };

  const handleDeclineProject = async (inv: PendingProjectInvitation) => {
    const key = `project-decline-${inv.id}`;
    try {
      setActingKey(key);
      const { error } = await supabase
        .from('project_invitations')
        .update({ status: 'declined' })
        .eq('id', inv.id);
      if (error) throw error;
      toast.info('Project invitation declined.');
      await loadInvitations();
    } catch (err: any) {
      console.error('Failed to decline project invitation:', err);
      toast.error(err?.message || 'Failed to decline invitation');
    } finally {
      setActingKey(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative flex h-9 w-9 items-center justify-center border border-white/10 bg-white/[0.04] text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {totalCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {totalCount > 9 ? '9+' : totalCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[380px] rounded-none border-white/10 bg-card/95 p-0 shadow-[0_20px_56px_rgba(3,12,27,0.45)] backdrop-blur-xl">
        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Notifications</p>
              <p className="text-[11px] text-muted-foreground">
                {totalCount > 0 ? `${totalCount} pending invitation${totalCount === 1 ? '' : 's'}` : 'You\u2019re all caught up'}
              </p>
            </div>
            {totalCount > 0 && (
              <Badge variant="outline" className="rounded-none border-primary/25 bg-primary/10 text-[10px] text-primary">
                {totalCount}
              </Badge>
            )}
          </div>
        </div>

        <ScrollArea className="max-h-[360px]">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : totalCount === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Bell className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">No pending invitations</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {orgInvitations.map((inv) => (
                <div key={`org-${inv.id}`} className="px-4 py-3 transition-colors hover:bg-white/[0.02]">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-white/10 bg-white/[0.04]">
                      <Building2 className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{inv.org_name}</p>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                        {inv.inviter_name || 'A team member'} invited you as <span className="text-foreground/70">{inv.role}</span>
                      </p>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/60">
                        <Clock className="h-2.5 w-2.5" />
                        Expires {new Date(inv.expires_at).toLocaleDateString()}
                      </div>
                      <div className="mt-2 flex gap-1.5">
                        <Button
                          size="sm"
                          className="h-7 rounded-none px-3 text-xs"
                          disabled={actingKey !== null}
                          onClick={() => handleAcceptOrg(inv)}
                        >
                          {actingKey === `org-accept-${inv.id}` ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="neutral"
                          className="h-7 rounded-none px-3 text-xs"
                          disabled={actingKey !== null}
                          onClick={() => handleDeclineOrg(inv)}
                        >
                          {actingKey === `org-decline-${inv.id}` ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <X className="mr-1 h-3 w-3" />}
                          Decline
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {projectInvitations.map((inv) => (
                <div key={`project-${inv.id}`} className="px-4 py-3 transition-colors hover:bg-white/[0.02]">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-white/10 bg-white/[0.04]">
                      <FolderKanban className="h-3.5 w-3.5 text-emerald-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{inv.project_name}</p>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                        {inv.inviter_name || 'A team member'} invited you to this project
                      </p>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/60">
                        <Clock className="h-2.5 w-2.5" />
                        Expires {new Date(inv.expires_at).toLocaleDateString()}
                      </div>
                      <div className="mt-2 flex gap-1.5">
                        <Button
                          size="sm"
                          className="h-7 rounded-none px-3 text-xs"
                          disabled={actingKey !== null}
                          onClick={() => handleAcceptProject(inv)}
                        >
                          {actingKey === `project-accept-${inv.id}` ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="neutral"
                          className="h-7 rounded-none px-3 text-xs"
                          disabled={actingKey !== null}
                          onClick={() => handleDeclineProject(inv)}
                        >
                          {actingKey === `project-decline-${inv.id}` ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <X className="mr-1 h-3 w-3" />}
                          Decline
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {totalCount > 0 && (
          <div className="border-t border-white/10 px-4 py-2">
            <button
              className="w-full text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => { setOpen(false); navigate('/dashboard'); }}
            >
              View all on dashboard
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
