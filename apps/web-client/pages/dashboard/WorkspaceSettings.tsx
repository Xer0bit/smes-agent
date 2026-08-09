import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { TIER_LIMITS } from '@/services/subscriptionService';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Search, Building2, Users, Send, Crown, CreditCard, User, Trash2, Copy, Check, Edit,
  FolderOpen, Settings2, Shield, PlusCircle, UserCog, BarChart3, Zap, Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { OrganizationBillingContent } from '@/components/referral/settings/OrganizationBillingContent';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { useOrganization } from '@/contexts/OrganizationContext';
import { getApiServerUrl } from '@/config/external-api';

type OrgRole = 'admin' | 'billing_admin' | 'member';
type PlanTier = 'free' | 'pro' | 'agency' | 'starter' | 'professional' | 'enterprise';

interface OrgPreferences {
  default_language: string;
  auto_accept_invitations: boolean;
  generation_sound_enabled: boolean;
}

const DEFAULT_ORG_PREFERENCES: OrgPreferences = {
  default_language: 'en',
  auto_accept_invitations: false,
  generation_sound_enabled: false,
};

interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  region: 'global' | 'cn';
  plan_tier: PlanTier;
  seats_total: number;
  seats_used: number;
  status: 'active' | 'suspended';
  created_by: string;
  user_role: OrgRole;
  total_message_count: number;
  preferences: OrgPreferences;
  avatar_url: string | null;
}

interface Collaborator {
  member_id: string;
  user_id: string;
  role: OrgRole;
  joined_at: string;
  email: string;
  full_name?: string;
  is_creator: boolean;
}

interface MemberPermissions {
  can_create_project: boolean;
  can_delete_project: boolean;
  can_manage_billing: boolean;
  can_invite_members: boolean;
  can_manage_members: boolean;
  can_view_analytics: boolean;
}

interface OrgProject {
  id: string;
  name: string;
}

interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  expires_at: string;
}

const inviteSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  role: z.enum(['admin', 'billing_admin', 'member']),
});

const DEFAULT_PERMS: MemberPermissions = {
  can_create_project: true,
  can_delete_project: false,
  can_manage_billing: false,
  can_invite_members: false,
  can_manage_members: false,
  can_view_analytics: true,
};

const MODULE_DEFS = [
  { key: 'can_create_project', label: 'Create Project', description: 'Can create new projects in the org', icon: PlusCircle },
  { key: 'can_delete_project', label: 'Delete Project', description: 'Can permanently delete projects', icon: Trash2 },
  { key: 'can_manage_billing', label: 'Manage Billing / Payments', description: 'Can view and update billing & subscription', icon: CreditCard },
  { key: 'can_invite_members', label: 'Invite Members', description: 'Can send invites to new collaborators', icon: Users },
  { key: 'can_manage_members', label: 'Manage Members', description: 'Can change roles and remove members', icon: UserCog },
  { key: 'can_view_analytics', label: 'View Analytics', description: 'Can see usage stats and analytics', icon: BarChart3 },
] as const;

function roleBadgeClass(role: OrgRole) {
  if (role === 'admin') return 'bg-amber-500/15 text-amber-500 border-amber-500/25';
  if (role === 'billing_admin') return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/25';
  return 'bg-primary/15 text-primary border-primary/25';
}

function initials(name?: string, email?: string) {
  if (name) return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (email || '?')[0].toUpperCase();
}

function orgInitialClasses(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  const palettes = ['bg-primary/15 text-primary', 'bg-secondary/15 text-secondary', 'bg-accent/15 text-accent'];
  return palettes[h % palettes.length];
}

export default function WorkspaceSettings() {
  const { t } = useTranslation();
  const { currentOrganizationId, setCurrentOrganizationId } = useOrganization();

  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // General tab
  const [editOrgName, setEditOrgName] = useState('');
  const [isEditingOrgName, setIsEditingOrgName] = useState(false);
  const [updatingOrgName, setUpdatingOrgName] = useState(false);
  const [leaveWorkspaceOpen, setLeaveWorkspaceOpen] = useState(false);
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [deleteOrgProjectCount, setDeleteOrgProjectCount] = useState(0);
  const [deleteOrgProjectIds, setDeleteOrgProjectIds] = useState<string[]>([]);
  const [deleteOrgOpen, setDeleteOrgOpen] = useState(false);

  // Members tab   collaborator list
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [orgProjects, setOrgProjects] = useState<OrgProject[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [memberSearch, setMemberSearch] = useState('');

  // Members tab   invite flow
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [inviteProjectIds, setInviteProjectIds] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [orgInvitations, setOrgInvitations] = useState<OrgInvitation[]>([]);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [isUpgradePromptOpen, setIsUpgradePromptOpen] = useState(false);

  // Members tab   per-member access Sheet
  const [sheetOpen, setSheetOpen] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Collaborator | null>(null);
  const [editRole, setEditRole] = useState<OrgRole>('member');
  const [editProjectIds, setEditProjectIds] = useState<string[]>([]);
  const [editPerms, setEditPerms] = useState<MemberPermissions>(DEFAULT_PERMS);
  const [editEcoLimit, setEditEcoLimit] = useState<string>('');
  const [memberEcoUsed, setMemberEcoUsed] = useState<number>(0);
  const [loadingSheet, setLoadingSheet] = useState(false);

  // Preferences tab
  const [savingPrefs, setSavingPrefs] = useState(false);

  const isAdmin = org?.user_role === 'admin';
  const preferences = org?.preferences ?? DEFAULT_ORG_PREFERENCES;
  const ownMember = collaborators.find(c => c.user_id === currentUserId);
  const adminCount = collaborators.filter(c => c.role === 'admin').length;
  const canLeaveWorkspace = !!ownMember && !ownMember.is_creator && !(ownMember.role === 'admin' && adminCount <= 1);

  const openLeaveWorkspace = () => {
    if (!ownMember) return;
    if (ownMember.is_creator) { toast.error('The workspace creator can\'t leave   delete the workspace instead.'); return; }
    if (ownMember.role === 'admin' && adminCount <= 1) { toast.error('Workspace must have at least one admin   promote another member first.'); return; }
    setLeaveWorkspaceOpen(true);
  };

  const handleLeaveWorkspace = async () => {
    if (!org || !ownMember) return;
    setLeavingWorkspace(true);
    try {
      const { error } = await supabase.from('org_members').delete().eq('id', ownMember.member_id);
      if (error) throw error;
      toast.success(`Left ${org.name}`);
      setLeaveWorkspaceOpen(false);
      setCurrentOrganizationId(null);
    } catch (error) {
      console.error('Failed to leave workspace:', error);
      toast.error('Failed to leave workspace');
    } finally {
      setLeavingWorkspace(false);
    }
  };

  const savePreferences = async (patch: Partial<OrgPreferences>) => {
    if (!org) return;
    const next = { ...org.preferences, ...patch };
    setOrg({ ...org, preferences: next });
    setSavingPrefs(true);
    try {
      const { error } = await supabase.from('organizations').update({ preferences: next }).eq('id', org.id);
      if (error) throw error;
    } catch (error) {
      console.error('Failed to save preferences:', error);
      toast.error('Failed to save preferences');
      setOrg({ ...org, preferences: org.preferences });
    } finally {
      setSavingPrefs(false);
    }
  };

  // ── Load current workspace's full detail (name/slug/plan/role/etc) ────────
  const loadOrg = useCallback(async () => {
    if (!currentOrganizationId) { setOrg(null); setLoading(false); return; }
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);

      const { data: orgRow } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', currentOrganizationId)
        .single();
      if (!orgRow) { setOrg(null); return; }

      const { data: platformRoleRow } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .in('role', ['super_admin', 'admin'])
        .maybeSingle();
      const isPlatformAdmin = !!platformRoleRow;

      const { data: roleRow } = await supabase
        .from('org_members')
        .select('role')
        .eq('org_id', currentOrganizationId)
        .eq('user_id', user.id)
        .maybeSingle();

      const userRole: OrgRole = (isPlatformAdmin || orgRow.created_by === user.id)
        ? 'admin'
        : ((roleRow?.role as OrgRole) ?? 'member');

      const { data: projects } = await supabase
        .from('projects')
        .select('message_count')
        .eq('organization_id', currentOrganizationId);
      const totalMessageCount = (projects || []).reduce((sum, p) => sum + (p.message_count || 0), 0);

      setOrg({
        ...orgRow,
        user_role: userRole,
        total_message_count: totalMessageCount,
        preferences: { ...DEFAULT_ORG_PREFERENCES, ...(orgRow.preferences || {}) },
      });
      setEditOrgName(orgRow.name);
    } catch (error) {
      console.error('Failed to load workspace:', error);
      toast.error('Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [currentOrganizationId]);

  // ── Load collaborators + pending invitations + org projects ───────────────
  const loadMembers = useCallback(async () => {
    if (!currentOrganizationId) return;
    setLoadingMembers(true);
    try {
      const { data: members } = await supabase
        .from('org_members')
        .select('id, user_id, role, joined_at')
        .eq('org_id', currentOrganizationId)
        .order('joined_at');

      const userIds = (members || []).map(m => m.user_id);
      const { data: profiles } = userIds.length
        ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
        : { data: [] as any[] };

      const list: Collaborator[] = (members || []).map(m => {
        const p = profiles?.find(pr => pr.id === m.user_id);
        return {
          member_id: m.id,
          user_id: m.user_id,
          role: m.role as OrgRole,
          joined_at: m.joined_at,
          email: p?.email || '',
          full_name: p?.full_name || undefined,
          is_creator: m.user_id === org?.created_by,
        };
      });
      setCollaborators(list);

      const { data: projects } = await supabase
        .from('projects')
        .select('id, name')
        .eq('organization_id', currentOrganizationId)
        .order('name');
      setOrgProjects(projects || []);

      const { data: invitations } = await supabase
        .from('org_invitations')
        .select('id, email, role, expires_at')
        .eq('org_id', currentOrganizationId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      setOrgInvitations(invitations || []);
    } catch (error) {
      console.error('Failed to load members:', error);
    } finally {
      setLoadingMembers(false);
    }
  }, [currentOrganizationId, org?.created_by]);

  useEffect(() => { loadOrg(); }, [loadOrg]);
  useEffect(() => { if (org) loadMembers(); }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── General tab actions ────────────────────────────────────────────────────
  const handleUpdateOrgName = async () => {
    if (!org) return;
    const trimmedName = editOrgName.trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      toast.error('Organization name must be 2-100 characters');
      return;
    }
    setUpdatingOrgName(true);
    try {
      const { error } = await supabase.from('organizations').update({ name: trimmedName }).eq('id', org.id);
      if (error) throw error;
      toast.success('Organization name updated');
      setOrg({ ...org, name: trimmedName });
      setIsEditingOrgName(false);
    } catch (error) {
      console.error('Failed to update organization name:', error);
      toast.error('Failed to update organization name');
    } finally {
      setUpdatingOrgName(false);
    }
  };

  const handleAvatarUpload = async (file: File | undefined) => {
    if (!file || !org) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Avatar must be a PNG, JPEG, or WebP image');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Avatar must be under 2MB');
      return;
    }
    setUploadingAvatar(true);
    try {
      const ext = file.type.split('/')[1];
      const path = `${org.id}/avatar.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('org-avatars')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('org-avatars').getPublicUrl(path);
      const avatarUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase.from('organizations').update({ avatar_url: avatarUrl }).eq('id', org.id);
      if (updateError) throw updateError;

      setOrg({ ...org, avatar_url: avatarUrl });
      toast.success('Avatar updated');
    } catch (error) {
      console.error('Failed to upload avatar:', error);
      toast.error('Failed to upload avatar');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const checkAndConfirmDeleteOrg = async () => {
    if (!org) return;
    const { data, count } = await supabase
      .from('projects')
      .select('id', { count: 'exact' })
      .eq('organization_id', org.id);
    setDeleteOrgProjectCount(count ?? 0);
    setDeleteOrgProjectIds((data ?? []).map((p) => p.id));
    setDeleteOrgOpen(true);
  };

  const handleDeleteOrg = async (mode: 'unassign' | 'delete-all' = 'unassign') => {
    if (!org) return;
    try {
      if (deleteOrgProjectIds.length > 0) {
        const { error: unlinkErr } = await supabase
          .from('projects')
          .update({ organization_id: null })
          .eq('organization_id', org.id);
        if (unlinkErr) throw unlinkErr;
      }
      const { error } = await supabase.from('organizations').delete().eq('id', org.id);
      if (error) throw error;

      if (mode === 'delete-all' && deleteOrgProjectIds.length > 0) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          deleteOrgProjectIds.forEach((projectId) => {
            fetch(getApiServerUrl(`/api/v1/projects/${projectId}`), {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${session.access_token}` },
            }).catch(() => {});
          });
        }
      }

      toast.success('Organization deleted');
      setDeleteOrgOpen(false);
      setCurrentOrganizationId(null);
    } catch (error) {
      console.error('Failed to delete organization:', error);
      toast.error('Failed to delete organization');
    }
  };

  // ── Members tab   invite new ───────────────────────────────────────────────
  const openInvite = () => {
    if (!org) return;
    if (org.plan_tier === 'free') { setIsUpgradePromptOpen(true); return; }
    setIsInviteOpen(true);
  };

  const handleInviteMember = async () => {
    if (!org) return;
    try {
      const validated = inviteSchema.parse({ email: inviteEmail, role: inviteRole });
      setInviting(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // profiles has no SELECT-by-email policy (would reopen email
      // enumeration against the whole user base) -- existence lookup goes
      // through a SECURITY DEFINER RPC instead, see
      // supabase/migrations/20260807120000_enable_profiles_rls.sql
      const { data: profileByEmailRows } = await supabase
        .rpc('lookup_user_by_email', { p_email: validated.email });
      const profileByEmail = profileByEmailRows?.[0] ?? null;

      if (profileByEmail) {
        const { data: existingMember } = await supabase
          .from('org_members').select('id').eq('org_id', org.id).eq('user_id', profileByEmail.id).maybeSingle();
        if (existingMember) { toast.error('User is already a member'); return; }
      }

      const { data: existingInvite } = await supabase
        .from('org_invitations').select('id').eq('org_id', org.id).eq('email', validated.email).eq('status', 'pending').maybeSingle();
      if (existingInvite) { toast.error('Invitation already sent to this email'); return; }

      const { data: invitationData, error } = await supabase
        .from('org_invitations')
        .insert({
          org_id: org.id,
          email: validated.email,
          role: validated.role,
          invited_by: user.id,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          project_ids: inviteProjectIds,
        })
        .select('id, token')
        .single();
      if (error) throw error;

      if (profileByEmail && inviteProjectIds.length > 0) {
        const rows = inviteProjectIds.map(pid => ({ project_id: pid, user_id: profileByEmail.id, granted_by: user.id }));
        await supabase.from('project_member_access').upsert(rows, { onConflict: 'project_id,user_id' });
      }

      // Auto-accept: only possible when the invitee already has an account
      // (can't join a user who hasn't signed up yet   they still get a
      // pending invite and accept it themselves once they do).
      let autoAccepted = false;
      if (profileByEmail && org.preferences.auto_accept_invitations) {
        const { error: memberError } = await supabase
          .from('org_members')
          .insert({ org_id: org.id, user_id: profileByEmail.id, role: validated.role, joined_at: new Date().toISOString() });
        if (!memberError) {
          await supabase.from('org_invitations').update({ status: 'accepted' }).eq('id', invitationData.id);
          autoAccepted = true;
        }
      }

      try {
        const { data: inviterProfile } = await supabase.from('profiles').select('full_name, email').eq('id', user.id).single();
        const { error: emailError } = await supabase.functions.invoke('org-invitation', {
          body: {
            email: validated.email,
            token: invitationData.token,
            org_name: org.name,
            inviter_name: inviterProfile?.full_name || inviterProfile?.email || 'A team member',
            role: validated.role,
          },
        });
        if (autoAccepted) {
          toast.success(`${validated.email} was added to the workspace`);
        } else {
          toast.success(emailError ? 'Invitation created (email delivery may be delayed)' : 'Invitation email sent');
        }
      } catch {
        toast.success(autoAccepted ? `${validated.email} was added to the workspace` : 'Invitation created (email could not be sent)');
      }

      setIsInviteOpen(false);
      setInviteEmail(''); setInviteRole('member'); setInviteProjectIds([]);
      await loadMembers();
    } catch (error) {
      if (error instanceof z.ZodError) toast.error(error.errors[0].message);
      else { console.error('Failed to send invitation:', error); toast.error('Failed to send invitation'); }
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    try {
      const { error } = await supabase.from('org_invitations').delete().eq('id', invitationId);
      if (error) throw error;
      toast.success('Invitation cancelled');
      await loadMembers();
    } catch (error) {
      console.error('Failed to cancel invitation:', error);
      toast.error('Failed to cancel invitation');
    }
  };

  const handleCopyInviteLink = async (id: string) => {
    const inviteLink = `${window.location.origin}/invite/${id}`;
    await navigator.clipboard.writeText(inviteLink);
    setCopiedToken(id);
    toast.success('Invite link copied to clipboard');
    setTimeout(() => setCopiedToken(null), 2000);
  };

  // ── Members tab   per-member access Sheet ──────────────────────────────────
  const openSheet = async (c: Collaborator) => {
    setSelectedMember(c);
    setEditRole(c.role);
    setSheetOpen(true);
    setLoadingSheet(true);
    try {
      const { data: access } = await supabase.from('project_member_access').select('project_id').eq('user_id', c.user_id);
      const grantedIds = (access || []).map(a => a.project_id);
      const orgProjectIds = orgProjects.map(p => p.id);
      setEditProjectIds(grantedIds.filter(id => orgProjectIds.includes(id)));

      const { data: perms } = await supabase
        .from('org_member_permissions').select('*')
        .eq('org_id', currentOrganizationId).eq('user_id', c.user_id).maybeSingle();
      setEditPerms(perms ? {
        can_create_project: perms.can_create_project,
        can_delete_project: perms.can_delete_project,
        can_manage_billing: perms.can_manage_billing,
        can_invite_members: perms.can_invite_members,
        can_manage_members: perms.can_manage_members,
        can_view_analytics: perms.can_view_analytics,
      } : DEFAULT_PERMS);
      setEditEcoLimit(perms?.eco_limit != null ? String(perms.eco_limit) : '');

      const { data: usageRows } = await supabase
        .from('usage_records').select('quantity')
        .eq('user_id', c.user_id).eq('org_id', currentOrganizationId).eq('usage_type', 'ai_agent_calls');
      setMemberEcoUsed((usageRows || []).reduce((sum, r) => sum + (r.quantity || 0), 0));
    } finally {
      setLoadingSheet(false);
    }
  };

  const handleSaveAccess = async () => {
    if (!selectedMember || !currentOrganizationId) return;
    const adminCount = collaborators.filter(m => m.role === 'admin').length;
    if (selectedMember.role === 'admin' && adminCount === 1 && editRole !== 'admin') {
      toast.error('Organization must have at least one admin');
      return;
    }
    setSavingAccess(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();

      await supabase.from('org_members').update({ role: editRole }).eq('id', selectedMember.member_id);

      const orgProjectIds = orgProjects.map(p => p.id);
      if (orgProjectIds.length > 0) {
        await supabase.from('project_member_access').delete().eq('user_id', selectedMember.user_id).in('project_id', orgProjectIds);
      }
      if (editProjectIds.length > 0) {
        await supabase.from('project_member_access').upsert(
          editProjectIds.map(pid => ({ project_id: pid, user_id: selectedMember.user_id, granted_by: user?.id })),
          { onConflict: 'project_id,user_id' }
        );
      }

      const ecoLimitVal = editEcoLimit.trim() !== '' ? parseInt(editEcoLimit, 10) : null;
      await supabase.from('org_member_permissions').upsert({
        org_id: currentOrganizationId,
        user_id: selectedMember.user_id,
        ...editPerms,
        eco_limit: isNaN(ecoLimitVal as number) ? null : ecoLimitVal,
        updated_by: user?.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,user_id' });

      toast.success(`Access updated for ${selectedMember.full_name || selectedMember.email}`);
      setSheetOpen(false);
      await loadMembers();
    } catch (err) {
      console.error(err);
      toast.error('Failed to save changes');
    } finally {
      setSavingAccess(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!selectedMember) return;
    const adminCount = collaborators.filter(m => m.role === 'admin').length;
    if (selectedMember.role === 'admin' && adminCount === 1) {
      toast.error('Cannot remove: organization must have at least one admin');
      return;
    }
    try {
      const { error } = await supabase.from('org_members').delete().eq('id', selectedMember.member_id);
      if (error) throw error;
      toast.success('Member removed');
      setSheetOpen(false);
      await loadMembers();
    } catch (error) {
      console.error('Failed to remove member:', error);
      toast.error('Failed to remove member');
    }
  };

  const filteredCollaborators = collaborators.filter(c =>
    (c.full_name || '').toLowerCase().includes(memberSearch.toLowerCase()) ||
    c.email.toLowerCase().includes(memberSearch.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="p-6 sm:p-8">
        <DashboardPageHeader title="Workspace Settings" description="No workspace selected." />
        <Card className="rounded-xl border-dashed border-border/60 bg-card/40">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Select or create a workspace from the sidebar to continue.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="Workspace Settings"
        description={`Manage ${org.name}   members, billing, and workspace access.`}
      />

      <Tabs defaultValue="members" orientation="vertical" className="mt-2 flex flex-col gap-8 lg:flex-row lg:items-start">
        <TabsList className="flex h-auto shrink-0 flex-col items-stretch gap-4 bg-transparent p-0 lg:w-56">
          <div className="space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
            <TabsTrigger value="general" className="w-full justify-start rounded-lg px-3 py-2 text-sm data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none">General</TabsTrigger>
            <TabsTrigger value="members" className="w-full justify-start rounded-lg px-3 py-2 text-sm data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none">Members</TabsTrigger>
            <TabsTrigger value="billing" className="w-full justify-start rounded-lg px-3 py-2 text-sm data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none">Billing</TabsTrigger>
          </div>
          <div className="space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Preferences</p>
            <TabsTrigger value="preferences" className="w-full justify-start rounded-lg px-3 py-2 text-sm data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none">Preferences</TabsTrigger>
          </div>
          {isAdmin && (
            <div className="space-y-1">
              <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Danger Zone</p>
              <TabsTrigger value="danger" className="w-full justify-start rounded-lg px-3 py-2 text-sm text-destructive data-[state=active]:bg-destructive/10 data-[state=active]:text-destructive data-[state=active]:shadow-none">Delete workspace</TabsTrigger>
            </div>
          )}
        </TabsList>

        <div className="min-w-0 flex-1">
        {/* ── General ─────────────────────────────────────────────────────── */}
        <TabsContent value="general" className="mt-0 space-y-8">
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Workspace profile</h2>
            <p className="text-sm text-muted-foreground">Control how this workspace appears and identifies itself.</p>
          </div>

          <div className="rounded-xl border border-border/60 shadow-[var(--elev-1)]">
            {/* Avatar */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div>
                <p className="text-sm font-medium">Avatar</p>
                <p className="text-sm text-muted-foreground">Shown across the sidebar and workspace switcher.</p>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => { handleAvatarUpload(e.target.files?.[0]); e.target.value = ''; }}
              />
              <button
                type="button"
                onClick={() => isAdmin && avatarInputRef.current?.click()}
                disabled={!isAdmin || uploadingAvatar}
                className="group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full disabled:cursor-default"
                title={isAdmin ? 'Change avatar' : undefined}
              >
                {org.avatar_url ? (
                  <img src={org.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" />
                ) : (
                  <span className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold ${orgInitialClasses(org.name)}`}>
                    {org.name.charAt(0).toUpperCase()}
                  </span>
                )}
                {isAdmin && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
                    {uploadingAvatar ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Edit className="h-3.5 w-3.5" />}
                  </span>
                )}
              </button>
            </div>
            <Separator />

            {/* Name */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Name</p>
                <p className="text-sm text-muted-foreground">Your workspace name, as visible to members.</p>
              </div>
              {isEditingOrgName ? (
                <div className="flex items-center gap-1.5">
                  <Input value={editOrgName} onChange={(e) => setEditOrgName(e.target.value)} autoFocus className="h-8 w-44 text-sm" />
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-primary" onClick={handleUpdateOrgName} disabled={updatingOrgName}>
                    {updatingOrgName ? '…' : 'Save'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-muted-foreground" onClick={() => { setIsEditingOrgName(false); setEditOrgName(org.name); }}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => isAdmin && setIsEditingOrgName(true)}
                  disabled={!isAdmin}
                  className="flex items-center gap-1.5 text-sm text-foreground disabled:cursor-default"
                >
                  {org.name}
                  {isAdmin && <Edit className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
              )}
            </div>
            <Separator />

            {/* Workspace ID */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div>
                <p className="text-sm font-medium">Workspace ID</p>
                <p className="text-sm text-muted-foreground">Unique workspace identifier.</p>
              </div>
              <button
                type="button"
                onClick={async () => { await navigator.clipboard.writeText(org.id); toast.success('Copied'); }}
                className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
                title="Copy"
              >
                {org.id}
                <Copy className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
            <Separator />

            {/* Handle / slug */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div>
                <p className="text-sm font-medium">Workspace handle</p>
                <p className="text-sm text-muted-foreground">Used in invite links and URLs.</p>
              </div>
              <span className="text-sm text-muted-foreground">@{org.slug}</span>
            </div>
            <Separator />

            {/* Plan / region / status / seats */}
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div>
                <p className="text-sm font-medium">Plan &amp; region</p>
                <p className="text-sm text-muted-foreground">
                  {org.status === 'suspended' ? 'Suspended due to outstanding payment.' : `${org.seats_used}/${org.seats_total} seats used.`}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="rounded-full capitalize">{org.plan_tier}</Badge>
                <Badge variant="outline" className="rounded-full uppercase">{org.region}</Badge>
                <Badge variant={org.status === 'active' ? 'default' : 'destructive'} className="rounded-full capitalize">{org.status}</Badge>
              </div>
            </div>
          </div>

          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Workspace access</h2>
          </div>
          <div className="rounded-xl border border-border/60 shadow-[var(--elev-1)]">
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div>
                <p className="text-sm font-medium">Leave workspace</p>
                <p className="text-sm text-muted-foreground">Remove yourself from this workspace. You'll no longer have access to its projects.</p>
              </div>
              <button
                type="button"
                onClick={openLeaveWorkspace}
                disabled={!canLeaveWorkspace}
                title={!canLeaveWorkspace ? (ownMember?.is_creator ? 'Workspace creators can\'t leave' : 'Workspace must keep at least one admin') : undefined}
                className="shrink-0 text-sm font-medium text-destructive hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              >
                Leave workspace
              </button>
            </div>
          </div>
        </TabsContent>

        {/* ── Danger Zone ─────────────────────────────────────────────────── */}
        {isAdmin && (
          <TabsContent value="danger" className="mt-0 space-y-5">
            <Card className="rounded-xl border-destructive/30">
              <CardHeader>
                <CardTitle className="font-display text-lg font-semibold text-destructive">Delete workspace</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Once you delete a workspace, there is no going back. All projects, members, and billing history tied to it will be affected.
                </p>
                <Button variant="destructive" className="rounded-full" onClick={checkAndConfirmDeleteOrg}>
                  Delete Workspace
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* ── Members ─────────────────────────────────────────────────────── */}
        <TabsContent value="members" className="mt-5 space-y-6">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search collaborators…"
                value={memberSearch}
                onChange={e => setMemberSearch(e.target.value)}
                className="h-10 rounded-full border-border/60 bg-card/60 pl-10"
              />
            </div>
            {isAdmin && (
              <Button size="sm" className="rounded-full" onClick={openInvite}>
                <Send className="h-4 w-4 mr-1.5" />
                Invite member
              </Button>
            )}
          </div>

          {loadingMembers ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filteredCollaborators.length === 0 ? (
            <Card className="rounded-xl border-dashed border-border/60 bg-card/40">
              <CardContent className="flex flex-col items-center justify-center py-14 text-center">
                <Users className="h-9 w-9 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">
                  {memberSearch ? 'No collaborators match your search.' : 'No members yet.'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2.5">
              {filteredCollaborators.map((c, i) => (
                <motion.div
                  key={c.user_id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: Math.min(i, 10) * 0.03, ease: [0.16, 1, 0.3, 1] }}
                  className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 px-4 py-3 transition-colors duration-200 hover:bg-card"
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                      {initials(c.full_name, c.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{c.full_name || c.email}</p>
                      {c.is_creator && <Badge variant="outline" className="rounded-full text-[10px] shrink-0">Creator</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                  </div>
                  <Badge className={`${roleBadgeClass(c.role)} rounded-full text-xs shrink-0 capitalize`}>
                    {c.role.replace('_', ' ')}
                  </Badge>
                  <p className="text-xs text-muted-foreground hidden sm:block w-28 shrink-0">
                    Joined {new Date(c.joined_at).toLocaleDateString()}
                  </p>
                  {isAdmin && (
                    <Button size="sm" variant="outline" className="rounded-full shrink-0" onClick={() => openSheet(c)} disabled={c.is_creator}
                      title={c.is_creator ? 'Creator access cannot be changed' : undefined}>
                      <Settings2 className="h-4 w-4 mr-1.5" />
                      Manage
                    </Button>
                  )}
                </motion.div>
              ))}
            </div>
          )}

          {/* Pending invitations */}
          <div className="pt-2">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-foreground">Pending invitations</h3>
              <p className="text-xs text-muted-foreground">{orgInvitations.length} pending</p>
            </div>
            {orgInvitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orgInvitations.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.email}</TableCell>
                      <TableCell><Badge className={`${roleBadgeClass(inv.role)} rounded-full capitalize`}>{inv.role.replace('_', ' ')}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(inv.expires_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" className="rounded-full" onClick={() => handleCopyInviteLink(inv.id)}>
                          {copiedToken === inv.id ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="sm" className="rounded-full" onClick={() => handleCancelInvitation(inv.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>

        {/* ── Billing ─────────────────────────────────────────────────────── */}
        <TabsContent value="billing" className="mt-5">
          <OrganizationBillingContent organizationId={org.id} userRole={org.user_role} />
        </TabsContent>

        {/* ── Preferences ───────────────────────────────────────────────────── */}
        <TabsContent value="preferences" className="mt-0 space-y-5">
          <Card className="rounded-xl border-border/60 shadow-[var(--elev-1)]">
            <CardHeader>
              <CardTitle className="font-display text-lg font-semibold">Preferences</CardTitle>
              <p className="text-sm text-muted-foreground">Personalize how this workspace works for its members.</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-5">
                <div>
                  <p className="text-sm font-medium">Default language</p>
                  <p className="text-sm text-muted-foreground">Used for new members and generated project copy.</p>
                </div>
                <Select value={preferences.default_language} onValueChange={(v) => savePreferences({ default_language: v })} disabled={!isAdmin || savingPrefs}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="zh-TW">繁體中文</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-5">
                <div>
                  <p className="text-sm font-medium">Auto-accept invitations</p>
                  <p className="text-sm text-muted-foreground">
                    Skip the manual accept step for invitees who already have an EcomGear account   they're added the moment you invite them.
                  </p>
                </div>
                <Switch checked={preferences.auto_accept_invitations} onCheckedChange={(v) => savePreferences({ auto_accept_invitations: v })} disabled={!isAdmin || savingPrefs} />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Generation complete sound</p>
                  <p className="text-sm text-muted-foreground">Play a short sound when the agent finishes a generation.</p>
                </div>
                <Switch checked={preferences.generation_sound_enabled} onCheckedChange={(v) => savePreferences({ generation_sound_enabled: v })} disabled={!isAdmin || savingPrefs} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        </div>
      </Tabs>

      {/* ── Invite Member Dialog ──────────────────────────────────────────── */}
      <Dialog open={isInviteOpen} onOpenChange={(open) => {
        setIsInviteOpen(open);
        if (!open) { setInviteEmail(''); setInviteRole('member'); setInviteProjectIds([]); }
      }}>
        <DialogContent className="max-w-lg rounded-xl">
          <DialogHeader>
            <DialogTitle className="font-display">Invite member to {org.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@company.com" className="rounded-lg" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Organization role</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
                <SelectTrigger id="invite-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="billing_admin">Billing Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2"><FolderOpen className="h-4 w-4" />Project access</Label>
                {orgProjects.length > 0 && (
                  <button type="button" className="text-xs text-primary hover:underline"
                    onClick={() => setInviteProjectIds(inviteProjectIds.length === orgProjects.length ? [] : orgProjects.map(p => p.id))}>
                    {inviteProjectIds.length === orgProjects.length ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>
              {orgProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No projects in this workspace yet.</p>
              ) : (
                <ScrollArea className="h-36 rounded-lg border border-border/60 p-3">
                  <div className="space-y-2">
                    {orgProjects.map(project => (
                      <div key={project.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`inv-proj-${project.id}`}
                          checked={inviteProjectIds.includes(project.id)}
                          onCheckedChange={(checked) => setInviteProjectIds(prev => checked ? [...prev, project.id] : prev.filter(id => id !== project.id))}
                        />
                        <label htmlFor={`inv-proj-${project.id}`} className="text-sm cursor-pointer select-none">{project.name}</label>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setIsInviteOpen(false)}>Cancel</Button>
            <Button className="rounded-full" onClick={handleInviteMember} disabled={inviting}>{inviting ? 'Sending…' : 'Send invitation'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Upgrade Prompt ────────────────────────────────────────────────── */}
      <Dialog open={isUpgradePromptOpen} onOpenChange={setIsUpgradePromptOpen}>
        <DialogContent className="max-w-md rounded-xl text-center">
          <DialogHeader><DialogTitle className="font-display">Upgrade required</DialogTitle></DialogHeader>
          <div className="py-4 space-y-4">
            <Crown className="mx-auto h-12 w-12 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              Team collaboration requires a paid plan. Upgrade to invite members and unlock collaboration features.
            </p>
            <Button className="w-full rounded-full" onClick={() => {
              setIsUpgradePromptOpen(false);
              const el = document.querySelector('[value="billing"]') as HTMLElement | null;
              el?.click();
            }}>
              View upgrade options
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Access Management Sheet ───────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0 overflow-hidden">
          <SheetHeader className="px-6 py-5 border-b border-border/60">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                  {initials(selectedMember?.full_name, selectedMember?.email)}
                </AvatarFallback>
              </Avatar>
              <div>
                <SheetTitle className="font-display text-base font-semibold leading-tight">
                  {selectedMember?.full_name || selectedMember?.email}
                </SheetTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{selectedMember?.email}</p>
              </div>
            </div>
          </SheetHeader>

          {loadingSheet ? (
            <div className="flex flex-1 items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="px-6 py-5 space-y-7">
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Shield className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Organization Role</h3>
                  </div>
                  <Select value={editRole} onValueChange={v => setEditRole(v as OrgRole)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="billing_admin">Billing Admin</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  {editRole === 'admin' && (
                    <p className="mt-2 text-xs text-amber-500/80">Admins have full access   permissions below are overridden.</p>
                  )}
                </section>

                <Separator />

                <section>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold">Project Access</h3>
                    </div>
                    {orgProjects.length > 0 && (
                      <button type="button" className="text-xs text-primary hover:underline"
                        onClick={() => setEditProjectIds(editProjectIds.length === orgProjects.length ? [] : orgProjects.map(p => p.id))}>
                        {editProjectIds.length === orgProjects.length ? 'Deselect all' : 'Select all'}
                      </button>
                    )}
                  </div>
                  {editRole === 'admin' ? (
                    <p className="text-xs text-muted-foreground">Admin has access to all projects.</p>
                  ) : orgProjects.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No projects in this organization.</p>
                  ) : (
                    <div className="space-y-2">
                      {orgProjects.map(p => (
                        <div key={p.id} className="flex items-center gap-2.5">
                          <Checkbox
                            id={`p-${p.id}`}
                            checked={editProjectIds.includes(p.id)}
                            onCheckedChange={checked => setEditProjectIds(prev => checked ? [...prev, p.id] : prev.filter(id => id !== p.id))}
                          />
                          <label htmlFor={`p-${p.id}`} className="text-sm cursor-pointer select-none">{p.name}</label>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <Separator />

                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">ECO Usage Limit</h3>
                  </div>
                  <div className="mb-4 rounded-lg border border-border/60 bg-card/40 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Used this period</span>
                      <span className="font-medium tabular-nums">
                        {memberEcoUsed} eco{editEcoLimit !== '' && !isNaN(parseInt(editEcoLimit)) ? ` / ${editEcoLimit} eco` : ' / no limit'}
                      </span>
                    </div>
                    {editEcoLimit !== '' && !isNaN(parseInt(editEcoLimit)) && parseInt(editEcoLimit) > 0 && (
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${memberEcoUsed / parseInt(editEcoLimit) >= 1 ? 'bg-destructive' : memberEcoUsed / parseInt(editEcoLimit) >= 0.8 ? 'bg-amber-500' : 'bg-primary'}`}
                          style={{ width: `${Math.min((memberEcoUsed / parseInt(editEcoLimit)) * 100, 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="eco-limit" className="text-sm">Monthly cap (eco units)</Label>
                    <Input id="eco-limit" type="number" min={0} placeholder="Leave blank for no limit" value={editEcoLimit} onChange={e => setEditEcoLimit(e.target.value)} className="rounded-lg" />
                  </div>
                </section>

                <Separator />

                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <User className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Module Permissions</h3>
                  </div>
                  {editRole === 'admin' ? (
                    <p className="text-xs text-muted-foreground">Admin has all module permissions.</p>
                  ) : (
                    <div className="space-y-4">
                      {MODULE_DEFS.map(mod => {
                        const Icon = mod.icon;
                        return (
                          <div key={mod.key} className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-2.5 flex-1">
                              <div className="mt-0.5 rounded-lg bg-muted p-1.5">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                              </div>
                              <div>
                                <Label className="text-sm font-medium leading-none">{mod.label}</Label>
                                <p className="text-xs text-muted-foreground mt-0.5">{mod.description}</p>
                              </div>
                            </div>
                            <Switch checked={editPerms[mod.key]} onCheckedChange={val => setEditPerms(prev => ({ ...prev, [mod.key]: val }))} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {!selectedMember?.is_creator && (
                  <>
                    <Separator />
                    <Button variant="destructive" className="w-full rounded-full" onClick={handleRemoveMember}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Remove from workspace
                    </Button>
                  </>
                )}
              </div>
            </ScrollArea>
          )}

          <SheetFooter className="border-t border-border/60 px-6 py-4 flex gap-2">
            <Button variant="outline" className="flex-1 rounded-full" onClick={() => setSheetOpen(false)}>Cancel</Button>
            <Button className="flex-1 rounded-full" onClick={handleSaveAccess} disabled={savingAccess || loadingSheet}>
              {savingAccess ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</> : 'Save changes'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ── Delete Workspace Confirmation ─────────────────────────────────── */}
      <AlertDialog open={deleteOrgOpen} onOpenChange={setDeleteOrgOpen}>
        <AlertDialogContent className="rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">Delete workspace</AlertDialogTitle>
            {deleteOrgProjectCount > 0 ? (
              <AlertDialogDescription>
                This workspace has <strong>{deleteOrgProjectCount} project{deleteOrgProjectCount !== 1 ? 's' : ''}</strong> linked to it. Choose what to do with them:
              </AlertDialogDescription>
            ) : (
              <AlertDialogDescription>
                This action cannot be undone. This permanently deletes the workspace and removes all associated members.
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className={deleteOrgProjectCount > 0 ? 'flex-col sm:flex-col gap-2' : undefined}>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            {deleteOrgProjectCount > 0 ? (
              <>
                <AlertDialogAction onClick={() => handleDeleteOrg('unassign')} className="rounded-full bg-amber-600 text-white hover:bg-amber-700">
                  Unassign projects & delete
                </AlertDialogAction>
                <AlertDialogAction onClick={() => handleDeleteOrg('delete-all')} className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Delete projects & workspace
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction onClick={() => handleDeleteOrg('unassign')} className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Delete workspace
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Leave Workspace Confirmation ───────────────────────────────────── */}
      <AlertDialog open={leaveWorkspaceOpen} onOpenChange={setLeaveWorkspaceOpen}>
        <AlertDialogContent className="rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">Leave {org.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll lose access to this workspace's projects immediately. You can be invited back later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleLeaveWorkspace} disabled={leavingWorkspace} className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {leavingWorkspace ? 'Leaving…' : 'Leave workspace'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
