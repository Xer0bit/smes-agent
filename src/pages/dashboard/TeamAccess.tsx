import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import {
  Search, Settings2, User, FolderOpen, Shield, Loader2,
  CreditCard, PlusCircle, Trash2, UserCog, BarChart3, Users, Zap,
} from 'lucide-react';
import { toast } from 'sonner';

type OrgRole = 'admin' | 'billing_admin' | 'member';

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
  if (role === 'admin') return 'bg-purple-500/10 text-purple-300 border-purple-500/20';
  if (role === 'billing_admin') return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  return 'bg-blue-500/10 text-blue-300 border-blue-500/20';
}

function initials(name?: string, email?: string) {
  if (name) return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (email || '?')[0].toUpperCase();
}

export default function TeamAccess() {
  const { currentOrganizationId } = useOrganization();

  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [orgProjects, setOrgProjects] = useState<OrgProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Sheet state
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Collaborator | null>(null);
  const [editRole, setEditRole] = useState<OrgRole>('member');
  const [editProjectIds, setEditProjectIds] = useState<string[]>([]);
  const [editPerms, setEditPerms] = useState<MemberPermissions>(DEFAULT_PERMS);
  const [editEcoLimit, setEditEcoLimit] = useState<string>('');
  const [memberEcoUsed, setMemberEcoUsed] = useState<number>(0);
  const [loadingSheet, setLoadingSheet] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrganizationId) return;
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: org } = await supabase
        .from('organizations')
        .select('created_by')
        .eq('id', currentOrganizationId)
        .single();

      const { data: members } = await supabase
        .from('org_members')
        .select('id, user_id, role, joined_at')
        .eq('org_id', currentOrganizationId)
        .order('joined_at');

      if (!members) return;

      const userIds = members.map(m => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .in('id', userIds);

      const list: Collaborator[] = members.map(m => {
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
    } finally {
      setLoading(false);
    }
  }, [currentOrganizationId]);

  useEffect(() => { load(); }, [load]);

  const openSheet = async (c: Collaborator) => {
    setSelected(c);
    setEditRole(c.role);
    setOpen(true);
    setLoadingSheet(true);
    try {
      // Load current project access
      const { data: access } = await supabase
        .from('project_member_access')
        .select('project_id')
        .eq('user_id', c.user_id);
      const grantedIds = (access || []).map(a => a.project_id);
      const orgProjectIds = orgProjects.map(p => p.id);
      setEditProjectIds(grantedIds.filter(id => orgProjectIds.includes(id)));

      // Load module permissions
      const { data: perms } = await supabase
        .from('org_member_permissions')
        .select('*')
        .eq('org_id', currentOrganizationId)
        .eq('user_id', c.user_id)
        .maybeSingle();
      setEditPerms(perms ? {
        can_create_project: perms.can_create_project,
        can_delete_project: perms.can_delete_project,
        can_manage_billing: perms.can_manage_billing,
        can_invite_members: perms.can_invite_members,
        can_manage_members: perms.can_manage_members,
        can_view_analytics: perms.can_view_analytics,
      } : DEFAULT_PERMS);
      setEditEcoLimit(perms?.eco_limit != null ? String(perms.eco_limit) : '');

      // Load this member's ECO usage (ai_agent_calls) in this org
      const { data: usageRows } = await supabase
        .from('usage_records')
        .select('quantity')
        .eq('user_id', c.user_id)
        .eq('org_id', currentOrganizationId)
        .eq('usage_type', 'ai_agent_calls');
      const total = (usageRows || []).reduce((sum, r) => sum + (r.quantity || 0), 0);
      setMemberEcoUsed(total);
    } finally {
      setLoadingSheet(false);
    }
  };

  const handleSave = async () => {
    if (!selected || !currentOrganizationId) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();

      // 1. Update org role
      await supabase
        .from('org_members')
        .update({ role: editRole })
        .eq('id', selected.member_id);

      // 2. Sync project access — remove all org-project rows then re-add selected
      const orgProjectIds = orgProjects.map(p => p.id);
      if (orgProjectIds.length > 0) {
        await supabase
          .from('project_member_access')
          .delete()
          .eq('user_id', selected.user_id)
          .in('project_id', orgProjectIds);
      }
      if (editProjectIds.length > 0) {
        await supabase
          .from('project_member_access')
          .upsert(
            editProjectIds.map(pid => ({
              project_id: pid,
              user_id: selected.user_id,
              granted_by: user?.id,
            })),
            { onConflict: 'project_id,user_id' }
          );
      }

      // 3. Upsert module permissions + eco limit
      const ecoLimitVal = editEcoLimit.trim() !== '' ? parseInt(editEcoLimit, 10) : null;
      await supabase
        .from('org_member_permissions')
        .upsert({
          org_id: currentOrganizationId,
          user_id: selected.user_id,
          ...editPerms,
          eco_limit: isNaN(ecoLimitVal as number) ? null : ecoLimitVal,
          updated_by: user?.id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'org_id,user_id' });

      toast.success(`Access updated for ${selected.full_name || selected.email}`);
      setOpen(false);
      await load();
    } catch (err) {
      console.error(err);
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const filtered = collaborators.filter(c =>
    (c.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
    c.email.toLowerCase().includes(search.toLowerCase())
  );

  const isAdmin = selected?.role === 'admin';

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="Team Access"
        description="Manage collaborator roles, project access, and feature permissions."
      />

      <div className="mb-6 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search collaborators…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {!currentOrganizationId ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Select a workspace to manage team access.</p>
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              {search ? 'No collaborators match your search.' : 'No members in this organization yet.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(c => (
            <div
              key={c.user_id}
              className="flex items-center gap-4 rounded-none border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/30"
            >
              <Avatar className="h-9 w-9 flex-shrink-0">
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                  {initials(c.full_name, c.email)}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{c.full_name || c.email}</p>
                  {c.is_creator && (
                    <Badge variant="outline" className="text-[10px] shrink-0">Creator</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">{c.email}</p>
              </div>

              <Badge className={`${roleBadgeClass(c.role)} text-xs shrink-0 capitalize`}>
                {c.role.replace('_', ' ')}
              </Badge>

              <p className="text-xs text-muted-foreground hidden sm:block w-28 shrink-0">
                Joined {new Date(c.joined_at).toLocaleDateString()}
              </p>

              <Button
                size="sm"
                variant="outline"
                className="rounded-none shrink-0"
                onClick={() => openSheet(c)}
                disabled={c.is_creator}
                title={c.is_creator ? 'Creator access cannot be changed' : undefined}
              >
                <Settings2 className="h-4 w-4 mr-1.5" />
                Manage
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* ─── Access Management Sheet ─────────────────────────────────── */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0 overflow-hidden">
          <SheetHeader className="px-6 py-5 border-b">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                  {initials(selected?.full_name, selected?.email)}
                </AvatarFallback>
              </Avatar>
              <div>
                <SheetTitle className="text-base leading-tight">
                  {selected?.full_name || selected?.email}
                </SheetTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{selected?.email}</p>
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

                {/* ── Role ── */}
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Shield className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Organization Role</h3>
                  </div>
                  <Select value={editRole} onValueChange={v => setEditRole(v as OrgRole)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">
                        <div>
                          <p className="font-medium">Member</p>
                          <p className="text-xs text-muted-foreground">Works on assigned projects</p>
                        </div>
                      </SelectItem>
                      <SelectItem value="billing_admin">
                        <div>
                          <p className="font-medium">Billing Admin</p>
                          <p className="text-xs text-muted-foreground">Can manage billing & subscription</p>
                        </div>
                      </SelectItem>
                      <SelectItem value="admin">
                        <div>
                          <p className="font-medium">Admin</p>
                          <p className="text-xs text-muted-foreground">Full org management access</p>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {editRole === 'admin' && (
                    <p className="mt-2 text-xs text-amber-500/80">
                      Admins have full access to all projects and modules — permission settings below are overridden.
                    </p>
                  )}
                </section>

                <Separator />

                {/* ── Project Access ── */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold">Project Access</h3>
                    </div>
                    {orgProjects.length > 0 && (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() =>
                          setEditProjectIds(
                            editProjectIds.length === orgProjects.length
                              ? []
                              : orgProjects.map(p => p.id)
                          )
                        }
                      >
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
                            onCheckedChange={checked =>
                              setEditProjectIds(prev =>
                                checked ? [...prev, p.id] : prev.filter(id => id !== p.id)
                              )
                            }
                          />
                          <label htmlFor={`p-${p.id}`} className="text-sm cursor-pointer select-none">
                            {p.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  )}
                  {editRole !== 'admin' && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {editProjectIds.length === 0
                        ? 'No projects — member can be assigned later.'
                        : `${editProjectIds.length} of ${orgProjects.length} project${orgProjects.length !== 1 ? 's' : ''} selected`}
                    </p>
                  )}
                </section>

                <Separator />

                {/* ── ECO Usage Limit ── */}
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">ECO Usage Limit</h3>
                  </div>

                  {/* Current usage bar */}
                  <div className="mb-4 rounded-md border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Used this period</span>
                      <span className="font-medium tabular-nums">
                        {memberEcoUsed} eco
                        {editEcoLimit !== '' && !isNaN(parseInt(editEcoLimit))
                          ? ` / ${editEcoLimit} eco`
                          : ' / no limit'}
                      </span>
                    </div>
                    {editEcoLimit !== '' && !isNaN(parseInt(editEcoLimit)) && parseInt(editEcoLimit) > 0 && (
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            memberEcoUsed / parseInt(editEcoLimit) >= 1
                              ? 'bg-destructive'
                              : memberEcoUsed / parseInt(editEcoLimit) >= 0.8
                              ? 'bg-amber-500'
                              : 'bg-primary'
                          }`}
                          style={{ width: `${Math.min((memberEcoUsed / parseInt(editEcoLimit)) * 100, 100)}%` }}
                        />
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="eco-limit" className="text-sm">
                      Monthly cap (eco units)
                    </Label>
                    <Input
                      id="eco-limit"
                      type="number"
                      min={0}
                      placeholder="Leave blank for no limit"
                      value={editEcoLimit}
                      onChange={e => setEditEcoLimit(e.target.value)}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">
                      Set a monthly ECO cap for this member. Leave blank to use the organization default.
                    </p>
                  </div>
                </section>

                <Separator />

                {/* ── Module Permissions ── */}
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <User className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Module Permissions</h3>
                  </div>
                  {isAdmin ? (
                    <p className="text-xs text-muted-foreground">Admin has all module permissions.</p>
                  ) : (
                    <div className="space-y-4">
                      {MODULE_DEFS.map(mod => {
                        const Icon = mod.icon;
                        return (
                          <div key={mod.key} className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-2.5 flex-1">
                              <div className="mt-0.5 p-1.5 rounded-md bg-muted">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                              </div>
                              <div>
                                <Label className="text-sm font-medium leading-none">{mod.label}</Label>
                                <p className="text-xs text-muted-foreground mt-0.5">{mod.description}</p>
                              </div>
                            </div>
                            <Switch
                              checked={editPerms[mod.key]}
                              onCheckedChange={val =>
                                setEditPerms(prev => ({ ...prev, [mod.key]: val }))
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

              </div>
            </ScrollArea>
          )}

          <SheetFooter className="border-t px-6 py-4 flex gap-2">
            <Button variant="outline" className="flex-1 rounded-none" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="flex-1 rounded-none" onClick={handleSave} disabled={saving || loadingSheet}>
              {saving ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
              ) : 'Save Changes'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
