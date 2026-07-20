import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { TIER_LIMITS } from '@/services/subscriptionService';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Search, Plus, Building2, Users, Send, Crown, Shield, CreditCard, User, Settings, Trash2, Mail, Copy, Check, Edit, FolderOpen } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { OrganizationBillingContent } from '@/components/referral/settings/OrganizationBillingContent';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { useOrganization } from '@/contexts/OrganizationContext';
import { getApiServerUrl } from '@/config/external-api';

// Types
type OrgRole = 'admin' | 'billing_admin' | 'member';
type PlanTier = 'free' | 'pro' | 'agency' | 'starter' | 'professional' | 'enterprise';
type Region = 'global' | 'cn';

interface Organization {
  id: string;
  name: string;
  slug: string;
  avatar_url?: string;
  region: Region;
  plan_tier: PlanTier;
  seats_total: number;
  seats_used: number;
  status: 'active' | 'suspended';
  created_at: string;
  created_by: string;
}

interface OrgMember {
  id: string;
  user_id: string;
  role: OrgRole;
  joined_at: string;
  profiles: {
    email: string;
    full_name?: string;
    avatar_url?: string;
  };
}

interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  expires_at: string;
  created_at: string;
  invited_by: string;
}

interface OrganizationWithRole extends Organization {
  user_role: OrgRole;
  member_count: number;
  project_count: number;
  total_message_count?: number;
}

// Validation schemas
const createOrgSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100, 'Name must be less than 100 characters'),
  slug: z.string().trim().min(2).max(50).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  region: z.enum(['global', 'cn']),
});

const inviteSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  role: z.enum(['admin', 'billing_admin', 'member']),
});

export default function DashboardOrganizations() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentOrganizationId, setCurrentOrganizationId } = useOrganization();
  const [organizations, setOrganizations] = useState<OrganizationWithRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Create org dialog
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgSlug, setNewOrgSlug] = useState('');
  const [newOrgRegion, setNewOrgRegion] = useState<Region>('global');
  const [creating, setCreating] = useState(false);

  // View org dialog
  const [selectedOrg, setSelectedOrg] = useState<OrganizationWithRole | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [orgInvitations, setOrgInvitations] = useState<OrgInvitation[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Invite member dialog
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteProjectIds, setInviteProjectIds] = useState<string[]>([]);
  const [orgProjects, setOrgProjects] = useState<{ id: string; name: string }[]>([]);
  const [loadingOrgProjects, setLoadingOrgProjects] = useState(false);

  // Delete confirmation
  const [deleteOrgId, setDeleteOrgId] = useState<string | null>(null);
  const [deleteOrgProjectCount, setDeleteOrgProjectCount] = useState(0);
  const [deleteOrgProjectIds, setDeleteOrgProjectIds] = useState<string[]>([]);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  // Edit organization name
  const [editOrgName, setEditOrgName] = useState('');
  const [updatingOrgName, setUpdatingOrgName] = useState(false);
  const [isEditingOrgName, setIsEditingOrgName] = useState(false);

  // Upgrade prompt for free plan
  const [isUpgradePromptOpen, setIsUpgradePromptOpen] = useState(false);

  useEffect(() => {
    checkAuthAndLoad();
  }, []);

  const checkAuthAndLoad = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }
      await loadOrganizations();
    } catch (error) {
      console.error('Auth check failed:', error);
      toast.error('Authentication failed');
    }
  };

  const loadOrganizations = async () => {
    try {
      setLoading(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // 1) Orgs created by user
      const { data: createdOrgs, error: createdErr } = await supabase
        .from('organizations')
        .select('*')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false });
      if (createdErr) throw createdErr;

      // 2) Orgs where user is a member (avoid join to bypass RLS relationship issues)
      const { data: memberRows } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id);

      const orgIds = Array.from(new Set((memberRows || []).map(r => r.org_id))).filter(Boolean);

      let orgsByMembership: any[] = [];
      if (orgIds.length > 0) {
        const { data: memberOrgs, error: memberOrgsErr } = await supabase
          .from('organizations')
          .select('*')
          .in('id', orgIds);
        if (memberOrgsErr) throw memberOrgsErr;
        orgsByMembership = memberOrgs || [];
      }

      // Merge and de-duplicate
      const combined = [...(createdOrgs || []), ...orgsByMembership].reduce((acc: Record<string, any>, org: any) => {
        acc[org.id] = acc[org.id] || org;
        return acc;
      }, {} as Record<string, any>);

      const mergedOrgs = Object.values(combined) as any[];

      // Check if this user is a platform admin   they get admin rights in every org
      const { data: platformRoleRow } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .in('role', ['super_admin', 'admin'])
        .maybeSingle();
      const isPlatformAdmin = !!platformRoleRow;

      // Enrich
      const enrichedOrgs: OrganizationWithRole[] = await Promise.all(
        mergedOrgs.map(async (org: any) => {
          const { data: projects } = await supabase
            .from('projects')
            .select('message_count')
            .eq('organization_id', org.id);

          const totalMessageCount = (projects || []).reduce(
            (sum, p) => sum + (p.message_count || 0),
            0
          );

          // Get user's role in this org (default to admin if creator, member otherwise)
          const { data: roleRow } = await supabase
            .from('org_members')
            .select('role')
            .eq('org_id', org.id)
            .eq('user_id', user.id)
            .maybeSingle();

          // Platform admins always get admin rights; org creators are always admin
          const userRole: OrgRole = (isPlatformAdmin || org.created_by === user.id)
            ? 'admin'
            : ((roleRow?.role as OrgRole) ?? 'member');

          return {
            ...org,
            user_role: userRole,
            member_count: org?.seats_used ?? 0,
            project_count: projects?.length || 0,
            total_message_count: totalMessageCount,
          };
        })
      );

      setOrganizations(enrichedOrgs);
    } catch (error) {
      console.error('Failed to load organizations:', error);
      toast.error('Failed to load organizations');
    } finally {
      setLoading(false);
    }
  };

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  const handleNameChange = (name: string) => {
    setNewOrgName(name);
    if (!newOrgSlug || newOrgSlug === generateSlug(newOrgName)) {
      setNewOrgSlug(generateSlug(name));
    }
  };

  const handleCreateOrg = async () => {
    try {
      // Validate
      const validated = createOrgSchema.parse({
        name: newOrgName,
        slug: newOrgSlug,
        region: newOrgRegion,
      });

      setCreating(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Enforce per-plan org limit: free accounts may only have 1 org.
      // A user is considered "free" if ALL their orgs are on the free tier.
      const ownedOrgsCount = organizations.filter(o => o.created_by === user.id).length;
      const hasPaidOrg = organizations.some(o => o.created_by === user.id && o.plan_tier !== 'free');
      const userMaxOrgs = hasPaidOrg ? TIER_LIMITS.pro.max_orgs : TIER_LIMITS.free.max_orgs;
      if (ownedOrgsCount >= userMaxOrgs) {
        toast.error('Free accounts are limited to 1 organization. Upgrade to create more.');
        setIsUpgradePromptOpen(true);
        return;
      }

      // Check if slug is available
      const { data: existing, error: existingError } = await supabase
        .from('organizations')
        .select('id')
        .eq('slug', validated.slug)
        .maybeSingle();

      if (existing) {
        toast.error('This slug is already taken');
        return;
      }

      // Create organization
      const { data: newOrg, error } = await supabase
        .from('organizations')
        .insert({
          name: validated.name,
          slug: validated.slug,
          region: validated.region,
          plan_tier: 'free',
          status: 'active',
          created_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;

      toast.success('Organization created successfully');
      setCurrentOrganizationId(newOrg.id);
      setIsCreateOpen(false);
      setNewOrgName('');
      setNewOrgSlug('');
      setNewOrgRegion('global');
      await loadOrganizations();
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0].message);
      } else {
        console.error('Failed to create organization:', error);
        toast.error('Failed to create organization');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleViewOrg = async (org: OrganizationWithRole) => {
    setSelectedOrg(org);
    setEditOrgName(org.name);
    setIsEditingOrgName(false);
    setIsViewOpen(true);
    await loadOrgMembers(org.id);
  };

  const loadOrgMembers = async (orgId: string) => {
    try {
      setLoadingMembers(true);

      // Load members
      const { data: members, error: membersError } = await supabase
        .from('org_members')
        .select('*')
        .eq('org_id', orgId)
        .order('joined_at', { ascending: false });

      if (membersError) throw membersError;

      // Load profiles for all members
      if (members && members.length > 0) {
        const userIds = members.map(m => m.user_id);
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, email, full_name, avatar_url')
          .in('id', userIds);

        if (profilesError) throw profilesError;

        // Merge members with profiles
        const membersWithProfiles = members.map(member => ({
          ...member,
          profiles: profiles?.find(p => p.id === member.user_id) || { email: '', full_name: null, avatar_url: null }
        }));

        setOrgMembers(membersWithProfiles);
      } else {
        setOrgMembers([]);
      }

      // Load invitations (handle errors gracefully)
      try {
        const { data: invitations, error: invitationsError } = await supabase
          .from('org_invitations')
          .select('*')
          .eq('org_id', orgId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });

        if (invitationsError) throw invitationsError;
        setOrgInvitations(invitations || []);
      } catch (invErr) {
        console.warn('Failed to load org invitations:', invErr);
        setOrgInvitations([]);
      }
    } catch (error) {
      console.error('Failed to load org members:', error);
      toast.error('Failed to load members');
    } finally {
      setLoadingMembers(false);
    }
  };

  const loadOrgProjectsForInvite = async (orgId: string) => {
    setLoadingOrgProjects(true);
    try {
      const { data } = await supabase
        .from('projects')
        .select('id, name')
        .eq('organization_id', orgId)
        .order('name');
      setOrgProjects(data || []);
    } finally {
      setLoadingOrgProjects(false);
    }
  };

  const handleInviteMember = async () => {
    if (!selectedOrg) return;

    try {
      const validated = inviteSchema.parse({
        email: inviteEmail,
        role: inviteRole,
      });

      setInviting(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Check if user is already a member
      // 1) lookup profile by email
      const { data: profileByEmail } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('email', validated.email)
        .maybeSingle();

      if (profileByEmail) {
        const { data: existingMember } = await supabase
          .from('org_members')
          .select('id')
          .eq('org_id', selectedOrg.id)
          .eq('user_id', profileByEmail.id)
          .maybeSingle();

        if (existingMember) {
          toast.error('User is already a member');
          return;
        }
      }

      // Check if invitation already exists
      const { data: existingInvite } = await supabase
        .from('org_invitations')
        .select('id')
        .eq('org_id', selectedOrg.id)
        .eq('email', validated.email)
        .eq('status', 'pending')
        .maybeSingle();

      if (existingInvite) {
        toast.error('Invitation already sent to this email');
        return;
      }

      // Create invitation
      const { data: invitationData, error } = await supabase
        .from('org_invitations')
        .insert({
          org_id: selectedOrg.id,
          email: validated.email,
          role: validated.role,
          invited_by: user.id,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          project_ids: inviteProjectIds,
        })
        .select('id, token')
        .single();

      if (error) throw error;

      // If user already exists, grant project access immediately
      if (profileByEmail && inviteProjectIds.length > 0) {
        const projectAccessRows = inviteProjectIds.map(pid => ({
          project_id: pid,
          user_id: profileByEmail.id,
          granted_by: user.id,
        }));
        await supabase.from('project_member_access').upsert(projectAccessRows, { onConflict: 'project_id,user_id' });
      }

      // Send invitation email via edge function
      try {
        // Get inviter's profile for the email
        const { data: inviterProfile } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', user.id)
          .single();

        const { error: emailError } = await supabase.functions.invoke('org-invitation', {
          body: {
            email: validated.email,
            token: invitationData.token,
            org_name: selectedOrg.name,
            inviter_name: inviterProfile?.full_name || inviterProfile?.email || 'A team member',
            role: validated.role,
          },
        });

        if (emailError) {
          console.error('Failed to send invitation email:', emailError);
          toast.success('Invitation created (email delivery may be delayed)');
        } else {
          toast.success('Invitation email sent successfully');
        }
      } catch (emailErr) {
        console.error('Email sending failed:', emailErr);
        toast.success('Invitation created (email could not be sent)');
      }
      setIsInviteOpen(false);
      setInviteEmail('');
      setInviteRole('member');
      setInviteProjectIds([]);
      await loadOrgMembers(selectedOrg.id);
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0].message);
      } else {
        console.error('Failed to send invitation:', error);
        toast.error('Failed to send invitation');
      }
    } finally {
      setInviting(false);
    }
  };

  const handleUpdateMemberRole = async (memberId: string, newRole: OrgRole) => {
    if (!selectedOrg) return;

    try {
      // Check if this is the last admin
      const adminCount = orgMembers.filter(m => m.role === 'admin').length;
      const memberToUpdate = orgMembers.find(m => m.id === memberId);

      if (memberToUpdate?.role === 'admin' && adminCount === 1 && newRole !== 'admin') {
        toast.error('Cannot change role: Organization must have at least one admin');
        return;
      }

      const { error } = await supabase
        .from('org_members')
        .update({ role: newRole })
        .eq('id', memberId);

      if (error) throw error;

      toast.success('Member role updated');
      await loadOrgMembers(selectedOrg.id);
    } catch (error) {
      console.error('Failed to update member role:', error);
      toast.error('Failed to update member role');
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!selectedOrg) return;

    try {
      // Check if this is the last admin
      const memberToRemove = orgMembers.find(m => m.id === memberId);
      const adminCount = orgMembers.filter(m => m.role === 'admin').length;

      if (memberToRemove?.role === 'admin' && adminCount === 1) {
        toast.error('Cannot remove member: Organization must have at least one admin');
        return;
      }

      const { error } = await supabase
        .from('org_members')
        .delete()
        .eq('id', memberId);

      if (error) throw error;

      toast.success('Member removed');
      await loadOrgMembers(selectedOrg.id);
      await loadOrganizations();
    } catch (error) {
      console.error('Failed to remove member:', error);
      toast.error('Failed to remove member');
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    if (!selectedOrg) return;

    try {
      const { error } = await supabase
        .from('org_invitations')
        .delete()
        .eq('id', invitationId);

      if (error) throw error;

      toast.success('Invitation cancelled');
      await loadOrgMembers(selectedOrg.id);
    } catch (error) {
      console.error('Failed to cancel invitation:', error);
      toast.error('Failed to cancel invitation');
    }
  };

  const handleCopyInviteLink = async (token: string) => {
    const inviteLink = `${window.location.origin}/invite/${token}`;
    await navigator.clipboard.writeText(inviteLink);
    setCopiedToken(token);
    toast.success('Invite link copied to clipboard');
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const handleUpdateOrgName = async () => {
    if (!selectedOrg) return;

    try {
      // Validate name
      const trimmedName = editOrgName.trim();
      if (!trimmedName || trimmedName.length < 2) {
        toast.error('Organization name must be at least 2 characters');
        return;
      }
      if (trimmedName.length > 100) {
        toast.error('Organization name must be less than 100 characters');
        return;
      }

      setUpdatingOrgName(true);

      const { error } = await supabase
        .from('organizations')
        .update({ name: trimmedName })
        .eq('id', selectedOrg.id);

      if (error) throw error;

      toast.success('Organization name updated');

      // Update local state
      setSelectedOrg({ ...selectedOrg, name: trimmedName });
      setIsEditingOrgName(false);
      await loadOrganizations();
    } catch (error) {
      console.error('Failed to update organization name:', error);
      toast.error('Failed to update organization name');
    } finally {
      setUpdatingOrgName(false);
    }
  };

  const checkAndConfirmDeleteOrg = async (orgId: string) => {
    const { data, count } = await supabase
      .from('projects')
      .select('id', { count: 'exact' })
      .eq('organization_id', orgId);
    setDeleteOrgProjectCount(count ?? 0);
    setDeleteOrgProjectIds((data ?? []).map((p) => p.id));
    setDeleteOrgId(orgId);
  };

  const handleDeleteOrg = async (mode: 'unassign' | 'delete-all' = 'unassign') => {
    if (!deleteOrgId) return;

    try {
      // Clear FK references before deleting the org
      if (deleteOrgProjectIds.length > 0) {
        const { error: unlinkErr } = await supabase
          .from('projects')
          .update({ organization_id: null })
          .eq('organization_id', deleteOrgId);
        if (unlinkErr) throw unlinkErr;
      }

      const { error } = await supabase
        .from('organizations')
        .delete()
        .eq('id', deleteOrgId);

      if (error) throw error;

      // If user chose to delete all projects, fire-and-forget backend cleanup
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
      setDeleteOrgId(null);
      setDeleteOrgProjectCount(0);
      setDeleteOrgProjectIds([]);
      setIsViewOpen(false);
      await loadOrganizations();
    } catch (error) {
      console.error('Failed to delete organization:', error);
      toast.error('Failed to delete organization');
    }
  };

  const getOrgRoleIcon = (role: OrgRole) => {
    if (role === 'admin') return <Crown className="h-4 w-4 text-amber-600" />;
    return null;
  };

  const getRoleIcon = (role: OrgRole) => {
    switch (role) {
      case 'admin': return <Crown className="h-4 w-4" />;
      case 'billing_admin': return <CreditCard className="h-4 w-4" />;
      default: return <User className="h-4 w-4" />;
    }
  };

  const getRoleBadgeColor = (role: OrgRole) => {
    switch (role) {
      case 'admin': return 'bg-amber-500/20 text-amber-500';
      case 'billing_admin': return 'bg-green-500/20 text-green-500';
      default: return 'bg-gray-500/20 text-gray-500';
    }
  };

  const filteredOrgs = organizations.filter(org =>
    org.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    org.slug.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title={t('dashboard.organizations')}
        description={currentOrganizationId ? 'Manage members, billing, and workspace access.' : 'Create or select a workspace.'}
      />

      <div className="mb-6 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search organizations"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-background"
          />
        </div>

        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-none bg-primary hover:bg-trigger">
              <Plus className="h-4 w-4 mr-2" />
              New
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Organization</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="org-name">Organization Name</Label>
                <Input
                  id="org-name"
                  value={newOrgName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="My Company"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-slug">Slug</Label>
                <Input
                  id="org-slug"
                  value={newOrgSlug}
                  onChange={(e) => setNewOrgSlug(e.target.value)}
                  placeholder="my-company"
                />
                <p className="text-xs text-muted-foreground">
                  Used in URLs. Only lowercase letters, numbers, and hyphens.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-region">Region</Label>
                <Select value={newOrgRegion} onValueChange={(v) => setNewOrgRegion(v as Region)}>
                  <SelectTrigger id="org-region">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="cn">China</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateOrg} disabled={creating}>
                {creating ? 'Creating...' : 'Create Organization'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {filteredOrgs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No organizations found</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {searchQuery ? 'Try a different search term' : 'Create your first organization to get started'}
            </p>
            {!searchQuery && (
              <Button className="hover:bg-trigger" onClick={() => setIsCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Organization
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredOrgs.map((org) => (
            <Card
              key={org.id}
              className={`border transition-colors cursor-pointer rounded-none ${currentOrganizationId === org.id ? 'border-primary/40 bg-primary/[0.04]' : 'border-border hover:border-primary/30'}`}
              onClick={() => handleViewOrg(org)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3 mb-3">
                  <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-base truncate">{org.name}</h3>
                      {getOrgRoleIcon(org.user_role)}
                      <Badge className={`${getRoleBadgeColor(org.user_role)} text-xs ml-auto flex-shrink-0 flex items-center gap-1`}>
                        {getRoleIcon(org.user_role)}
                        <span className="capitalize">{org.user_role.replace('_', ' ')}</span>
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      @{org.slug}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    <span>{org.seats_used}/{org.seats_total}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span>💬 {org.total_message_count || 0}</span>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {org.plan_tier}
                  </Badge>
                </div>
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
                  <Badge variant="outline" className="rounded-none border-white/10 bg-white/[0.03] text-xs text-muted-foreground">
                    {currentOrganizationId === org.id ? 'Active workspace' : `${org.project_count} projects`}
                  </Badge>
                  <Button
                    size="sm"
                    variant={currentOrganizationId === org.id ? 'neutral' : 'outline'}
                    className="rounded-none"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCurrentOrganizationId(org.id);
                      toast.success(`${org.name} is now the active workspace`);
                    }}
                  >
                    {currentOrganizationId === org.id ? 'Active' : 'Use Workspace'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* View Organization Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-md bg-primary/10 flex items-center justify-center">
                <Building2 className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                {isEditingOrgName ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editOrgName}
                      onChange={(e) => setEditOrgName(e.target.value)}
                      className="text-xl font-semibold h-10"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleUpdateOrgName();
                        if (e.key === 'Escape') {
                          setIsEditingOrgName(false);
                          setEditOrgName(selectedOrg?.name || '');
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={handleUpdateOrgName}
                      disabled={updatingOrgName}
                    >
                      {updatingOrgName ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setIsEditingOrgName(false);
                        setEditOrgName(selectedOrg?.name || '');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-xl">{selectedOrg?.name}</DialogTitle>
                    {selectedOrg?.user_role === 'admin' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setIsEditingOrgName(true)}
                        className="h-8 w-8 p-0"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                )}
                <p className="text-sm text-muted-foreground">@{selectedOrg?.slug}</p>
              </div>
              {selectedOrg ? (
                <Button
                  variant={currentOrganizationId === selectedOrg.id ? 'neutral' : 'outline'}
                  className="rounded-none"
                  onClick={() => {
                    setCurrentOrganizationId(selectedOrg.id);
                    toast.success(`${selectedOrg.name} is now the active workspace`);
                  }}
                >
                  {currentOrganizationId === selectedOrg.id ? 'Active Workspace' : 'Use Workspace'}
                </Button>
              ) : null}
            </div>
          </DialogHeader>

          <Tabs defaultValue="members" className="mt-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="billing">Plan & Billing</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>

            <TabsContent value="members" className="space-y-4">
              <div className="flex justify-between items-center">
                <p className="text-sm text-muted-foreground">
                  {orgMembers.length} member{orgMembers.length !== 1 ? 's' : ''}
                </p>
                {selectedOrg && selectedOrg.user_role === 'admin' && (
                  <Button size="sm" onClick={() => {
                    if (selectedOrg.plan_tier === 'free') {
                      setIsUpgradePromptOpen(true);
                    } else {
                      setIsInviteOpen(true);
                    }
                  }}>
                    <Send className="h-4 w-4 mr-2" />
                    Invite Member
                  </Button>
                )}
              </div>

              {loadingMembers ? (
                <div className="text-center py-8">Loading members...</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Member</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Joined</TableHead>
                      {selectedOrg && selectedOrg.user_role === 'admin' && (
                        <TableHead>Actions</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orgMembers.map((member) => {
                      const isCreator = member.user_id === selectedOrg?.created_by;
                      const adminCount = orgMembers.filter(m => m.role === 'admin').length;
                      const isLastAdmin = member.role === 'admin' && adminCount === 1;
                      const canModify = selectedOrg?.user_role === 'admin' && !isCreator;

                      return (
                        <TableRow key={member.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                                <User className="h-4 w-4 text-primary" />
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="font-medium text-sm">
                                    {member.profiles?.full_name || member.profiles?.email}
                                  </p>
                                  {isCreator && (
                                    <Badge variant="outline" className="text-xs">
                                      Creator
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {member.profiles?.email}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge className={`${getRoleBadgeColor(member.role)}`}>
                              {getRoleIcon(member.role)}
                              <span className="ml-1">{member.role}</span>
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(member.joined_at).toLocaleDateString()}
                          </TableCell>
                          {selectedOrg && selectedOrg.user_role === 'admin' && (
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {canModify ? (
                                  <>
                                    <Select
                                      value={member.role}
                                      onValueChange={(v) => handleUpdateMemberRole(member.id, v as OrgRole)}
                                      disabled={isLastAdmin}
                                    >
                                      <SelectTrigger className="h-8 w-32">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="member">Member</SelectItem>
                                        <SelectItem value="admin">Admin</SelectItem>
                                        <SelectItem value="billing_admin">Billing Admin</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleRemoveMember(member.id)}
                                      disabled={isLastAdmin}
                                      title={isLastAdmin ? "Cannot remove the last admin" : undefined}
                                    >
                                      <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                  </>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    {isCreator ? "Creator role cannot be changed" : "No permission"}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {/* Pending Invitations Section */}
              <div className="mt-8 pt-8 border-t">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">Pending Invitations</h3>
                  <p className="text-sm text-muted-foreground">
                    {orgInvitations.length} pending invitation{orgInvitations.length !== 1 ? 's' : ''}
                  </p>
                </div>

                {orgInvitations.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No pending invitations
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orgInvitations.map((invitation) => (
                        <TableRow key={invitation.id}>
                          <TableCell className="font-medium">{invitation.email}</TableCell>
                          <TableCell>
                            <Badge className={getRoleBadgeColor(invitation.role)}>
                              {invitation.role}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(invitation.expires_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleCopyInviteLink(invitation.id)}
                              >
                                {copiedToken === invitation.id ? (
                                  <Check className="h-4 w-4 text-green-500" />
                                ) : (
                                  <Copy className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleCancelInvitation(invitation.id)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>

            <TabsContent value="billing" className="space-y-4">
              {selectedOrg && (
                <OrganizationBillingContent
                  organizationId={selectedOrg.id}
                  userRole={selectedOrg.user_role}
                />
              )}
            </TabsContent>

            <TabsContent value="settings" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Organization Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground mb-1">Plan</p>
                      <Badge variant="outline">{selectedOrg?.plan_tier}</Badge>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Region</p>
                      <Badge variant="outline">{selectedOrg?.region}</Badge>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Status</p>
                      <div className="space-y-1">
                        <Badge variant={selectedOrg?.status === 'active' ? 'default' : 'destructive'}>
                          {selectedOrg?.status}
                        </Badge>
                        {selectedOrg?.status === 'suspended' && (
                          <p className="text-xs text-destructive mt-2">
                            Your organization is suspended due to outstanding payment.
                            All projects cannot be edited until payment is resolved.
                            Please contact support or update your payment method.
                          </p>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Total Prompts</p>
                      <p className="font-medium">
                        💬 {selectedOrg?.total_message_count || 0}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {selectedOrg?.user_role === 'admin' && (
                <Card className="border-destructive">
                  <CardHeader>
                    <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground mb-4">
                      Once you delete an organization, there is no going back. Please be certain.
                    </p>
                    <Button
                      variant="destructive"
                      onClick={() => checkAndConfirmDeleteOrg(selectedOrg.id)}
                    >
                      Delete Organization
                    </Button>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Invite Member Dialog */}
      <Dialog open={isInviteOpen} onOpenChange={(open) => {
        setIsInviteOpen(open);
        if (open && selectedOrg) loadOrgProjectsForInvite(selectedOrg.id);
        if (!open) { setInviteEmail(''); setInviteRole('member'); setInviteProjectIds([]); }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite Member to {selectedOrg?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email Address</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="invite-role">Organization Role</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">
                    <div className="flex flex-col">
                      <span>Member</span>
                      <span className="text-xs text-muted-foreground">Can view and work on assigned projects</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="admin">
                    <div className="flex flex-col">
                      <span>Admin</span>
                      <span className="text-xs text-muted-foreground">Full org management access</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="billing_admin">
                    <div className="flex flex-col">
                      <span>Billing Admin</span>
                      <span className="text-xs text-muted-foreground">Can manage billing and subscription</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4" />
                  Project Access
                </Label>
                {orgProjects.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() =>
                      setInviteProjectIds(
                        inviteProjectIds.length === orgProjects.length
                          ? []
                          : orgProjects.map(p => p.id)
                      )
                    }
                  >
                    {inviteProjectIds.length === orgProjects.length ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>
              {loadingOrgProjects ? (
                <div className="text-sm text-muted-foreground py-2">Loading projects...</div>
              ) : orgProjects.length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">No projects in this organization yet.</div>
              ) : (
                <ScrollArea className="h-40 rounded-md border p-3">
                  <div className="space-y-2">
                    {orgProjects.map(project => (
                      <div key={project.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`proj-${project.id}`}
                          checked={inviteProjectIds.includes(project.id)}
                          onCheckedChange={(checked) => {
                            setInviteProjectIds(prev =>
                              checked
                                ? [...prev, project.id]
                                : prev.filter(id => id !== project.id)
                            );
                          }}
                        />
                        <label
                          htmlFor={`proj-${project.id}`}
                          className="text-sm leading-none cursor-pointer select-none"
                        >
                          {project.name}
                        </label>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
              <p className="text-xs text-muted-foreground">
                {inviteProjectIds.length === 0
                  ? 'No projects selected   member can be assigned projects later.'
                  : `${inviteProjectIds.length} project${inviteProjectIds.length !== 1 ? 's' : ''} selected`}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsInviteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleInviteMember} disabled={inviting}>
              {inviting ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upgrade Prompt Dialog */}
      <Dialog open={isUpgradePromptOpen} onOpenChange={setIsUpgradePromptOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upgrade Required</DialogTitle>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <div className="flex justify-center">
              <Crown className="h-16 w-16 text-amber-500" />
            </div>
            <div className="space-y-2">
              <p className="text-lg font-medium">Team Collaboration Requires a Paid Plan</p>
              <p className="text-sm text-muted-foreground">
                Please upgrade your organization plan to invite team members and unlock collaboration features.
              </p>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                setIsUpgradePromptOpen(false);
                // Switch to billing tab
                const billingTab = document.querySelector('[value="billing"]') as HTMLElement;
                billingTab?.click();
              }}
            >
              View Upgrade Options
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteOrgId} onOpenChange={() => { setDeleteOrgId(null); setDeleteOrgProjectCount(0); setDeleteOrgProjectIds([]); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Organization</AlertDialogTitle>
            {deleteOrgProjectCount > 0 ? (
              <AlertDialogDescription>
                This organization has <strong>{deleteOrgProjectCount} project{deleteOrgProjectCount !== 1 ? 's' : ''}</strong> linked to it.
                Choose what to do with them:
              </AlertDialogDescription>
            ) : (
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete the organization
                and remove all associated members.
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className={deleteOrgProjectCount > 0 ? 'flex-col sm:flex-col gap-2' : undefined}>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {deleteOrgProjectCount > 0 ? (
              <>
                <AlertDialogAction
                  onClick={() => handleDeleteOrg('unassign')}
                  className="bg-amber-600 text-white hover:bg-amber-700"
                >
                  Unassign Projects &amp; Delete Org
                </AlertDialogAction>
                <AlertDialogAction
                  onClick={() => handleDeleteOrg('delete-all')}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete Projects &amp; Organization
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction
                onClick={() => handleDeleteOrg('unassign')}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete Organization
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
