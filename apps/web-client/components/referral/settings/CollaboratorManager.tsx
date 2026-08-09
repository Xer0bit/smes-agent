import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { UserPlus, Trash2, Shield, Clock, Mail, X } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { canInviteMember as checkSeatAvailability, invalidateOrgCache } from "@/services/subscriptionService";

interface CollaboratorManagerProps {
  projectId?: string;
}

interface Collaborator {
  id: string;
  user_id: string;
  granted_at: string;
  role: 'editor' | 'viewer' | 'client';
  profiles: {
    email: string;
    full_name?: string;
    avatar_url?: string;
  };
}

interface PendingInvite {
  id: string;
  email: string;
  created_at: string;
  expires_at: string;
  role: 'editor' | 'viewer' | 'client';
}

export const CollaboratorManager = ({ projectId }: CollaboratorManagerProps) => {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [selectedRole, setSelectedRole] = useState<'editor' | 'viewer' | 'client'>('viewer');
  const [canManage, setCanManage] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string>('');
  const [projectName, setProjectName] = useState<string>('');
  const [removeCollaboratorId, setRemoveCollaboratorId] = useState<string | null>(null);
  const [cancelInviteId, setCancelInviteId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  // Seat availability defaults to `true` while unknown/loading so the UI never
  // shows a false "seat limit reached" nudge before the real check resolves.
  const [seatStatus, setSeatStatus] = useState<{ allowed: boolean; reason?: string }>({ allowed: true });
  const { hasFeature, tierLabel } = useSubscription();

  useEffect(() => {
    if (projectId) {
      checkPermissions();
      loadData();
    }
  }, [projectId]);

  // canInviteMember() is an async, org-scoped seat check (RPC-backed)   it was
  // previously destructured straight off useSubscription() as if it were a
  // precomputed boolean, which doesn't exist there. That silently resolved to
  // `undefined` (falsy) forever, permanently disabling the invite button and
  // permanently blocking handleSendInvite for EVERY non-superadmin user on
  // EVERY tier, including paid ones with open seats. Seats are an
  // organization-level concept   a project with no organization (personal
  // project) has no seat ceiling to check, so this defaults to allowed.
  useEffect(() => {
    if (!organizationId) { setSeatStatus({ allowed: true }); return; }
    let cancelled = false;
    checkSeatAvailability(organizationId).then((result) => {
      if (!cancelled) setSeatStatus(result);
    });
    return () => { cancelled = true; };
  }, [organizationId]);

  const canAddCollaborators = isSuperAdmin || hasFeature('invite_editors');
  const canAssignEditor = isSuperAdmin || hasFeature('invite_editors');
  const canAssignClient = isSuperAdmin || hasFeature('invite_clients');

  const checkPermissions = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);

      const { data: project } = await supabase
        .from('projects')
        .select('created_by, organization_id, name')
        .eq('id', projectId)
        .single();

      if (!project) return;
      setProjectName(project.name || '');
      setOrganizationId(project.organization_id ?? null);

      const isCreator = project.created_by === user.id;
      let isOrgAdmin = false;
      if (project.organization_id) {
        const { data: membership } = await supabase
          .from('org_members')
          .select('role')
          .eq('org_id', project.organization_id)
          .eq('user_id', user.id)
          .single();
        isOrgAdmin = membership?.role === 'admin';
      }

      const { data: userRole } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .in('role', ['super_admin', 'admin'])
        .maybeSingle();

      const superAdmin = !!userRole;
      setIsSuperAdmin(superAdmin);
      setCanManage(isCreator || isOrgAdmin || superAdmin);

      // Get inviter display name for the email
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', user.id)
        .single();
      setCurrentUserName(profile?.full_name || profile?.email || user.email || '');
    } catch (error) {
      console.error('Error checking permissions:', error);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadCollaborators(), loadPendingInvites()]);
    } finally {
      setLoading(false);
    }
  };

  const loadCollaborators = async () => {
    const { data, error } = await supabase
      .from('project_member_access')
      .select('id, user_id, granted_at, role')
      .eq('project_id', projectId)
      .order('granted_at', { ascending: false });

    if (error) { console.error(error); return; }

    const userIds = [...new Set((data || []).map((d: any) => d.user_id).filter(Boolean))];
    const profileMap = new Map<string, { email?: string; full_name?: string; avatar_url?: string }>();

    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, full_name, avatar_url')
        .in('id', userIds);
      (profiles || []).forEach((p: any) => profileMap.set(p.id, p));
    }

    setCollaborators((data || []).map((item: any) => ({
      id: item.id,
      user_id: item.user_id,
      granted_at: item.granted_at,
      role: item.role || 'editor',
      profiles: {
        email: profileMap.get(item.user_id)?.email || '',
        full_name: profileMap.get(item.user_id)?.full_name,
        avatar_url: profileMap.get(item.user_id)?.avatar_url,
      },
    })));
  };

  const loadPendingInvites = async () => {
    const { data, error } = await supabase
      .from('project_invitations')
      .select('id, email, created_at, expires_at, role')
      .eq('project_id', projectId)
      .eq('status', 'pending')
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) { console.error(error); return; }
    setPendingInvites(data || []);
  };

  const handleSendInvite = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) { toast.error('Please enter an email address'); return; }

    try {
      setInviting(true);

      if (!canAddCollaborators) {
        toast.error(`Collaborators are not available on ${tierLabel}. Upgrade your plan.`);
        return;
      }
      if (!isSuperAdmin && !seatStatus.allowed) {
        toast.error(seatStatus.reason || 'Your organization has reached its seat limit. Upgrade to invite more members.');
        return;
      }
      // Re-check the specific role being granted, not just whether inviting is
      // allowed at all   canAddCollaborators only reflects invite_editors, so
      // without this a starter/professional-tier user could still pick
      // "Client" in the dropdown (a hidden-but-selectable option) even though
      // their tier doesn't include invite_clients.
      if (!isSuperAdmin && selectedRole === 'editor' && !canAssignEditor) {
        toast.error(`Editor invitations are not available on ${tierLabel}. Upgrade your plan.`);
        return;
      }
      if (!isSuperAdmin && selectedRole === 'client' && !canAssignClient) {
        toast.error(`Client invitations are not available on ${tierLabel}. Upgrade your plan.`);
        return;
      }

      // Block if they're already an accepted member
      const alreadyMember = collaborators.some(c => c.profiles.email?.toLowerCase() === trimmedEmail);
      if (alreadyMember) { toast.error('This user is already a collaborator.'); return; }

      // Block if there's already a pending invite for this email
      const alreadyPending = pendingInvites.some(i => i.email.toLowerCase() === trimmedEmail);
      if (alreadyPending) { toast.error('An invitation is already pending for this email.'); return; }

      // Create the invitation record
      const { data: inv, error: invErr } = await supabase
        .from('project_invitations')
        .insert({
          project_id: projectId,
          email: trimmedEmail,
          invited_by: currentUserId,
          role: selectedRole,
        })
        .select('token')
        .single();

      if (invErr || !inv) throw invErr || new Error('Failed to create invitation');

      // Send the invitation email via edge function
      const { error: fnErr } = await supabase.functions.invoke('project-invitation', {
        body: {
          email: trimmedEmail,
          token: inv.token,
          project_name: projectName,
          inviter_name: currentUserName,
        },
      });

      if (fnErr) {
        // Email failed   clean up the invite record so they can retry
        await supabase.from('project_invitations').delete().eq('token', inv.token);
        throw new Error('Failed to send invitation email. Please try again.');
      }

      toast.success(`Invitation sent to ${trimmedEmail}`);
      setEmail('');
      await loadPendingInvites();
      if (organizationId) invalidateOrgCache(organizationId);
    } catch (err: any) {
      console.error('Error sending invite:', err);
      toast.error(err.message || 'Failed to send invitation');
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async () => {
    if (!cancelInviteId) return;
    try {
      const { error } = await supabase
        .from('project_invitations')
        .update({ status: 'declined' })
        .eq('id', cancelInviteId);
      if (error) throw error;
      toast.success('Invitation cancelled');
      setCancelInviteId(null);
      await loadPendingInvites();
      if (organizationId) invalidateOrgCache(organizationId);
    } catch {
      toast.error('Failed to cancel invitation');
    }
  };

  const handleRemoveCollaborator = async () => {
    if (!removeCollaboratorId) return;
    try {
      const { error } = await supabase
        .from('project_member_access')
        .delete()
        .eq('id', removeCollaboratorId);
      if (error) throw error;
      toast.success('Collaborator removed');
      setRemoveCollaboratorId(null);
      await loadCollaborators();
      if (organizationId) invalidateOrgCache(organizationId);
    } catch {
      toast.error('Failed to remove collaborator');
    }
  };

  const getInitials = (name?: string, email?: string) => {
    if (name) return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    if (email) return email[0].toUpperCase();
    return '?';
  };

  if (!projectId) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white/85 mb-1">Collaborators</h2>
          <p className="text-sm text-white/45">No project selected</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Collaborators</h2>
        <p className="text-sm text-white/45">
          Manage who can access and edit this project
        </p>
      </div>

      {/* Upgrade nudges */}
      {canManage && !isSuperAdmin && !canAddCollaborators && (
        <Card className="bg-workspace-surface border-indigo-500/30">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              Collaborators   Paid Plan Feature
            </CardTitle>
            <CardDescription className="text-xs">
              Upgrade from {tierLabel} to invite collaborators to your projects.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')} className="w-full" size="sm">
              Manage Billing
            </Button>
          </CardContent>
        </Card>
      )}

      {canManage && !isSuperAdmin && canAddCollaborators && !seatStatus.allowed && (
        <Card className="bg-workspace-surface border-indigo-500/30">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              Seat Limit Reached
            </CardTitle>
            <CardDescription className="text-xs">
              Your organization has no remaining seats. Upgrade to invite additional members.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')} className="w-full" size="sm">
              Manage Billing
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Invite form */}
      {canManage && canAddCollaborators && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              Invite Collaborator
            </CardTitle>
            <CardDescription className="text-xs">
              They will receive an email and must accept the invitation before getting access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2 space-y-2">
                <Label htmlFor="email" className="text-xs">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="collaborator@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendInvite()}
                  className="h-9 text-sm"
                  disabled={inviting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role" className="text-xs">Role</Label>
                <Select value={selectedRole} onValueChange={(v: 'editor' | 'viewer' | 'client') => setSelectedRole(v)}>
                  <SelectTrigger id="role" className="h-9" disabled={inviting}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    {canAssignEditor && <SelectItem value="editor">Editor</SelectItem>}
                    {canAssignClient && <SelectItem value="client">Client</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              onClick={handleSendInvite}
              disabled={inviting || !email.trim() || (!isSuperAdmin && !seatStatus.allowed)}
              className="w-full md:w-auto"
            >
              {inviting ? 'Sending...' : 'Send Invitation'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Pending invitations */}
      {pendingInvites.length > 0 && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" />
              Pending Invitations
              <Badge variant="secondary" className="ml-1 text-xs">{pendingInvites.length}</Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              Waiting for recipients to accept
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Expires</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInvites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Mail className="h-3.5 w-3.5 text-white/45 shrink-0" />
                        <span className="text-sm">{invite.email}</span>
                        <Badge variant="outline" className="text-xs text-amber-600 border-amber-200 bg-amber-50">
                          Pending
                        </Badge>
                        <Badge variant="secondary" className="text-xs capitalize">{invite.role}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-white/45">
                      {format(new Date(invite.created_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-sm text-white/45">
                      {format(new Date(invite.expires_at), 'MMM d, yyyy')}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCancelInviteId(invite.id)}
                          className="h-8 px-2"
                          title="Cancel invitation"
                        >
                          <X className="h-4 w-4 text-white/45" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Accepted collaborators */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Members
          </CardTitle>
          <CardDescription className="text-xs">
            {collaborators.length} {collaborators.length === 1 ? 'person has' : 'people have'} access to this project
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : collaborators.length === 0 ? (
            <div className="text-center py-8 text-sm text-white/45">
              No members yet. {canManage && 'Send an invitation to get started.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {collaborators.map((collaborator) => (
                  <TableRow key={collaborator.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={collaborator.profiles.avatar_url} />
                          <AvatarFallback className="text-xs">
                            {getInitials(collaborator.profiles.full_name, collaborator.profiles.email)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="text-sm font-medium">
                            {collaborator.profiles.full_name || collaborator.profiles.email}
                          </div>
                          {collaborator.profiles.full_name && (
                            <div className="text-xs text-white/45">{collaborator.profiles.email}</div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">{collaborator.role}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-white/45">
                      {collaborator.granted_at ? format(new Date(collaborator.granted_at), 'MMM d, yyyy') : ' '}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoveCollaboratorId(collaborator.id)}
                          disabled={collaborator.user_id === currentUserId}
                          className="h-8 px-2"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Cancel invite confirmation */}
      <AlertDialog open={!!cancelInviteId} onOpenChange={(open) => !open && setCancelInviteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Invitation</AlertDialogTitle>
            <AlertDialogDescription>
              The invitation link will be revoked. The recipient will not be able to join using the email they received.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancelInvite} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Cancel Invitation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove member confirmation */}
      <AlertDialog open={!!removeCollaboratorId} onOpenChange={(open) => !open && setRemoveCollaboratorId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Collaborator</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this collaborator? They will lose access to this project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveCollaborator} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
