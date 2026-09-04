import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import BrandLoader from '@/components/BrandLoader';
import { Search, CreditCard, Building2, Pencil, Sparkles, Crown, Loader2, ArrowUpRight, Users, Check, History, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { fetchOrgPlan, updateOrgEntitlements, UNITS, UNIT_LABELS, formatDollars, type PlanSnapshot, type Unit } from '@/services/planService';
import { PlanCatalogCard } from '@/components/admin/PlanCatalogCard';

interface OrgSubscription {
    org_id: string;
    org_name: string;
    plan_tier: string;
    seats_total: number;
    seats_used: number;
    publish_lines_used: number;
    publish_lines_limit: number;
    publish_lines_reset_at: string | null;
    status: string;
    created_at: string;
    admin_managed: boolean;
}

interface AuditLogEntry {
    id: string;
    org_id: string | null;
    org_name: string | null;
    user_id: string | null;
    user_email: string | null;
    action: string;
    metadata: Record<string, any>;
    created_at: string;
}

const TIER_CONFIG: Record<string, { bg: string; color: string; border: string; icon: any }> = {
    free: {
        bg: 'rgba(107,114,128,0.1)',
        color: '#9ca3af',
        border: 'rgba(107,114,128,0.2)',
        icon: Building2
    },
    pro: {
        bg: 'rgba(139,92,246,0.1)',
        color: '#a78bfa',
        border: 'rgba(139,92,246,0.2)',
        icon: Sparkles
    },
    agency: {
        bg: 'rgba(245,158,11,0.1)',
        color: '#fbbf24',
        border: 'rgba(245,158,11,0.2)',
        icon: Crown
    },
};

export default function AdminSubscriptions() {
    const [subscriptions, setSubscriptions] = useState<OrgSubscription[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [editOrg, setEditOrg] = useState<OrgSubscription | null>(null);
    const [editTier, setEditTier] = useState('');
    const [editBillingMode, setEditBillingMode] = useState<'free' | 'paid'>('free');
    const [editStatus, setEditStatus] = useState('active');
    const [editSeats, setEditSeats] = useState('');
    const [editUsageLimit, setEditUsageLimit] = useState('');
    const [editResetAt, setEditResetAt] = useState('');
    const [saving, setSaving] = useState(false);
    const [editPlan, setEditPlan] = useState<PlanSnapshot | null>(null);
    const [editUnits, setEditUnits] = useState<Record<Unit, number>>({ apps: 1, users: 1, agents: 1, databases: 1 });
    const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
    const [auditLoading, setAuditLoading] = useState(true);

    const getDefaultPublishLimit = (tier: string) => (['free', 'starter'].includes(tier) ? 30 : 100);
    const getDefaultMaxProjects = (tier: string) => (['free', 'starter'].includes(tier) ? 5 : 999999);
    const isPaidTier = (tier: string) => tier !== 'free';

    useEffect(() => {
        loadSubscriptions();
        loadAuditLogs();
    }, []);

    const loadAuditLogs = async () => {
        try {
            setAuditLoading(true);
            const { data, error } = await supabase
                .from('usage_tracking')
                .select('id, org_id, user_id, action, metadata, created_at')
                .in('action', [
                    'admin_subscription_update',
                    'admin_usage_reset',
                    'admin_usage_default_limit',
                ])
                .order('created_at', { ascending: false })
                .limit(20);

            if (error) throw error;

            const orgIds = [...new Set((data || []).map((item: any) => item.org_id).filter(Boolean))] as string[];
            const userIds = [...new Set((data || []).map((item: any) => item.user_id).filter(Boolean))] as string[];

            const [orgRes, profileRes] = await Promise.all([
                orgIds.length
                    ? supabase.from('organizations').select('id, name').in('id', orgIds)
                    : Promise.resolve({ data: [] as any[] }),
                userIds.length
                    ? supabase.from('profiles').select('id, email').in('id', userIds)
                    : Promise.resolve({ data: [] as any[] }),
            ]);

            const orgMap = new Map((orgRes.data || []).map((org: any) => [org.id, org.name]));
            const userMap = new Map((profileRes.data || []).map((profile: any) => [profile.id, profile.email]));

            const mapped = (data || []).map((row: any) => ({
                id: row.id,
                org_id: row.org_id || null,
                org_name: row.org_id ? (orgMap.get(row.org_id) || null) : null,
                user_id: row.user_id || null,
                user_email: row.user_id ? (userMap.get(row.user_id) || null) : null,
                action: row.action,
                metadata: (row.metadata as Record<string, any>) || {},
                created_at: row.created_at,
            }));

            setAuditLogs(mapped);
        } catch (error) {
            console.error('Failed to load audit logs:', error);
            toast.error('Failed to load audit trail');
        } finally {
            setAuditLoading(false);
        }
    };

    const logAuditEvent = async (
        action: string,
        org: OrgSubscription,
        metadata: Record<string, any>
    ) => {
        try {
            const { data: userData } = await supabase.auth.getUser();
            const actorId = userData.user?.id || null;
            await supabase.from('usage_tracking').insert({
                user_id: actorId,
                org_id: org.org_id,
                project_id: null,
                action,
                metadata,
            });
        } catch (error) {
            console.error('Failed to write audit log:', error);
        }
    };

    const loadSubscriptions = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('organizations')
                .select('id, name, plan_tier, seats_total, seats_used, publish_lines_used, publish_lines_limit, publish_lines_reset_at, status, created_at, admin_managed')
                .order('name');

            if (error) throw error;

            setSubscriptions(
                (data || []).map((org: any) => ({
                    org_id: org.id,
                    org_name: org.name,
                    plan_tier: org.plan_tier || 'free',
                    seats_total: org.seats_total || 1,
                    seats_used: org.seats_used || 0,
                    publish_lines_used: org.publish_lines_used || 0,
                    publish_lines_limit: org.publish_lines_limit || getDefaultPublishLimit(org.plan_tier || 'free'),
                    publish_lines_reset_at: org.publish_lines_reset_at || null,
                    status: org.status || 'active',
                    created_at: org.created_at,
                    admin_managed: org.admin_managed ?? false,
                }))
            );
        } catch (error) {
            console.error('Failed to load subscriptions:', error);
            toast.error('Failed to load subscriptions');
        } finally {
            setLoading(false);
        }
    };

    const handleEdit = (sub: OrgSubscription) => {
        setEditOrg(sub);
        setEditTier(sub.plan_tier);
        setEditBillingMode(isPaidTier(sub.plan_tier) ? 'paid' : 'free');
        setEditStatus(sub.status || 'active');
        setEditSeats(String(sub.seats_total));
        setEditUsageLimit(String(sub.publish_lines_limit));
        setEditResetAt(sub.publish_lines_reset_at ? new Date(sub.publish_lines_reset_at).toISOString().slice(0, 16) : '');
        setEditPlan(null);
        fetchOrgPlan(sub.org_id)
            .then((snapshot) => {
                setEditPlan(snapshot);
                setEditUnits({ apps: snapshot.entitlements.apps, users: snapshot.entitlements.users, agents: snapshot.entitlements.agents, databases: snapshot.entitlements.databases });
            })
            .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not load plan units'));
    };

    const handleSave = async () => {
        if (!editOrg) return;
        try {
            setSaving(true);
            const parsedSeats = Math.max(1, parseInt(editSeats, 10) || 1);
            const parsedLimit = Math.max(1, parseInt(editUsageLimit, 10) || getDefaultPublishLimit(editTier));
            const resetAtIso = editResetAt ? new Date(editResetAt).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

            // admin_managed: true protects this plan from being overwritten by Stripe sync
            const isPaid = !['free', 'starter'].includes(editTier);
            const { error } = await supabase
                .from('organizations')
                .update({
                    plan_tier: editTier,
                    status: editStatus,
                    seats_total: parsedSeats,
                    max_projects: getDefaultMaxProjects(editTier),
                    publish_lines_limit: parsedLimit,
                    publish_lines_reset_at: resetAtIso,
                    admin_managed: isPaid,
                    // Reset used counter when granting a paid plan so user can publish immediately
                    ...(isPaid ? { publish_lines_used: 0 } : {}),
                })
                .eq('id', editOrg.org_id);

            if (error) throw error;

            await logAuditEvent('admin_subscription_update', editOrg, {
                before: {
                    plan_tier: editOrg.plan_tier,
                    status: editOrg.status,
                    seats_total: editOrg.seats_total,
                    publish_lines_limit: editOrg.publish_lines_limit,
                    publish_lines_reset_at: editOrg.publish_lines_reset_at,
                },
                after: {
                    plan_tier: editTier,
                    status: editStatus,
                    seats_total: parsedSeats,
                    publish_lines_limit: parsedLimit,
                    publish_lines_reset_at: resetAtIso,
                },
                billing_mode: editBillingMode,
            });

            if (editPlan && UNITS.some((u) => editUnits[u] !== editPlan.entitlements[u])) {
                await updateOrgEntitlements(editOrg.org_id, editUnits);
            }
            toast.success(`Updated plan for ${editOrg.org_name}`);
            setEditOrg(null);
            loadSubscriptions();
            loadAuditLogs();
        } catch (error) {
            toast.error('Failed to update subscription');
        } finally {
            setSaving(false);
        }
    };

    const handleResetUsage = async (sub: OrgSubscription) => {
        try {
            const { error } = await supabase
                .from('organizations')
                .update({
                    publish_lines_used: 0,
                    publish_lines_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                })
                .eq('id', sub.org_id);

            if (error) throw error;

            await logAuditEvent('admin_usage_reset', sub, {
                before: {
                    publish_lines_used: sub.publish_lines_used,
                    publish_lines_reset_at: sub.publish_lines_reset_at,
                },
                after: {
                    publish_lines_used: 0,
                    publish_lines_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                },
            });

            toast.success(`Usage reset for ${sub.org_name}`);
            loadSubscriptions();
            loadAuditLogs();
        } catch {
            toast.error('Failed to reset usage');
        }
    };

    const handleApplyDefaultLimit = async (sub: OrgSubscription) => {
        try {
            const { error } = await supabase
                .from('organizations')
                .update({ publish_lines_limit: getDefaultPublishLimit(sub.plan_tier) })
                .eq('id', sub.org_id);

            if (error) throw error;

            await logAuditEvent('admin_usage_default_limit', sub, {
                before: {
                    publish_lines_limit: sub.publish_lines_limit,
                },
                after: {
                    publish_lines_limit: getDefaultPublishLimit(sub.plan_tier),
                },
            });

            toast.success(`Default limit applied to ${sub.org_name}`);
            loadSubscriptions();
            loadAuditLogs();
        } catch {
            toast.error('Failed to apply default limit');
        }
    };

    const formatResetDate = (dateString: string | null) => {
        if (!dateString) return 'Not set';
        return new Date(dateString).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const formatAuditAction = (action: string) => {
        if (action === 'admin_subscription_update') return 'Plan/Status Updated';
        if (action === 'admin_usage_reset') return 'Usage Reset';
        if (action === 'admin_usage_default_limit') return 'Default Limit Applied';
        return action;
    };

    const tierBreakdown = subscriptions.reduce((acc, s) => {
        acc[s.plan_tier] = (acc[s.plan_tier] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const filtered = subscriptions.filter(s =>
        s.org_name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <PlanCatalogCard />
            {/* ─── Tier Breakdown Grid ───────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {['free', 'pro', 'agency'].map((tier) => {
                    const config = TIER_CONFIG[tier] || TIER_CONFIG.free;
                    const count = tierBreakdown[tier] || 0;
                    return (
                        <Card
                            key={tier}
                            className="relative border-white/10 bg-white/[0.02] overflow-hidden group hover:border-white/20 transition-colors duration-150"
                        >
                            <CardContent className="p-5 relative z-10">
                                <div className="flex items-center justify-between mb-2">
                                    <div className={cn("p-2 rounded-none border", config.border)} style={{ background: config.bg }}>
                                        <config.icon className={cn("h-4 w-4", config.color)} />
                                    </div>
                                    <ArrowUpRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                                </div>
                                <div className="space-y-0.5">
                                    <p className="text-2xl font-bold text-white tracking-tight">{count}</p>
                                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-muted-foreground transition-colors">{tier} Accounts</p>
                                </div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            {/* ─── Search & Controls ─────────────────────────────────────── */}
            <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-muted-foreground" />
                <Input
                    placeholder="Search by organization name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 h-10 text-sm bg-white/[0.03] border-white/10 text-white placeholder:text-muted-foreground focus:border-primary/50 focus:ring-primary/20 transition-all"
                />
            </div>

            {/* ─── Subscriptions Table ────────────────────────────────────── */}
            <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
                <CardHeader className="pb-4 border-b border-white/[0.05] bg-white/[0.01]">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                            <div className="p-2 rounded-none bg-muted border border-border">
                                <CreditCard className="h-4 w-4 text-muted-foreground" />
                            </div>
                            Organization Plan Management
                        </CardTitle>
                        <Badge variant="outline" className="bg-white/5 border-white/10 text-muted-foreground font-normal">
                            {filtered.length} Organizations
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-24 gap-3">
                            <BrandLoader variant="bead" size={100} label="Loading plan data" />
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-white/[0.05] hover:bg-transparent">
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Organization Name</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-center">Plan Tier</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-center">Billing</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-center">Seat Allocation</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Status</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-center">Usage</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Reset At</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-right pr-6">Manage</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((sub) => {
                                        const config = TIER_CONFIG[sub.plan_tier] || TIER_CONFIG.free;
                                        const isActive = sub.status === 'active';
                                        return (
                                            <TableRow key={sub.org_id} className="border-white/[0.05] hover:bg-white/[0.02] transition-colors group">
                                                <TableCell className="py-4">
                                                    <div className="flex items-center gap-3">
                                                        <div className="h-8 w-8 rounded-none bg-white/5 border border-white/10 flex items-center justify-center">
                                                            <Building2 className="h-4 w-4 text-muted-foreground" />
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-sm text-foreground font-medium group-hover:text-white transition-colors">
                                                                {sub.org_name}
                                                            </span>
                                                            {sub.admin_managed && (
                                                                <Badge className="text-[9px] px-1.5 py-0 border rounded-full bg-emerald-500/10 text-emerald-400 border-emerald-500/20" title="Plan protected from Stripe override">
                                                                    <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />Admin
                                                                </Badge>
                                                            )}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-center">
                                                    <Badge
                                                        className="text-[10px] flex items-center gap-1.5 w-fit mx-auto border shadow-sm px-2 py-0.5 capitalize"
                                                        style={{ background: config.bg, color: config.color, borderColor: config.border }}
                                                    >
                                                        <config.icon className="h-3 w-3" />
                                                        {sub.plan_tier}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-center">
                                                    <Badge
                                                        className={cn(
                                                            'text-[10px] px-2 py-0.5 border rounded-full',
                                                            isPaidTier(sub.plan_tier)
                                                                ? 'bg-muted text-muted-foreground border-border'
                                                                : 'bg-muted-foreground/10 text-foreground/80 border-border'
                                                        )}
                                                    >
                                                        {isPaidTier(sub.plan_tier) ? 'Paid' : 'Free'}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-center">
                                                    <div className="flex flex-col items-center gap-1">
                                                        <span className="text-sm text-foreground font-mono">
                                                            {sub.seats_used} <span className="text-muted-foreground/60">/</span> {sub.seats_total}
                                                        </span>
                                                        <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden">
                                                            <div
                                                                className="h-full bg-primary rounded-full"
                                                                style={{ width: `${Math.min((sub.seats_used / sub.seats_total) * 100, 100)}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        className={cn(
                                                            "text-[10px] px-2 py-0.5 border rounded-full",
                                                            isActive
                                                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                                                : "bg-red-500/10 text-red-400 border-red-500/20"
                                                        )}
                                                    >
                                                        <div className={cn("h-1 w-1 rounded-full mr-1.5", isActive ? "bg-emerald-400" : "bg-red-400")} />
                                                        {sub.status}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-center">
                                                    <div className="space-y-1">
                                                        <div className="text-xs text-foreground/80 font-mono">
                                                            {sub.publish_lines_used.toLocaleString()} / {sub.publish_lines_limit.toLocaleString()} lines
                                                        </div>
                                                        <div className="w-24 h-1 bg-white/5 rounded-full overflow-hidden mx-auto">
                                                            <div
                                                                className="h-full bg-primary rounded-full"
                                                                style={{ width: `${Math.min((sub.publish_lines_used / Math.max(1, sub.publish_lines_limit)) * 100, 100)}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-xs text-muted-foreground">{formatResetDate(sub.publish_lines_reset_at)}</TableCell>
                                                <TableCell className="text-right pr-6">
                                                    <div className="flex items-center justify-end gap-1">
                                                        <Button
                                                            variant="ghost" size="sm"
                                                            className="h-8 px-2 text-[11px] text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 rounded-none transition-all"
                                                            onClick={() => handleResetUsage(sub)}
                                                            title="Reset usage"
                                                        >
                                                            Reset
                                                        </Button>
                                                        <Button
                                                            variant="ghost" size="sm"
                                                            className="h-8 px-2 text-[11px] text-muted-foreground hover:text-muted-foreground hover:bg-muted rounded-none transition-all"
                                                            onClick={() => handleApplyDefaultLimit(sub)}
                                                            title="Apply free/paid default limit"
                                                        >
                                                            Default
                                                        </Button>
                                                        <Button
                                                            variant="ghost" size="sm"
                                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-muted-foreground hover:bg-muted rounded-none transition-all"
                                                            onClick={() => handleEdit(sub)}
                                                            title="Edit Subscription"
                                                        >
                                                            <Pencil className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {filtered.length === 0 && (
                                        <TableRow>
                                            <TableCell colSpan={8} className="text-center text-muted-foreground py-20">
                                                <div className="flex flex-col items-center gap-2">
                                                    <Building2 className="h-10 w-10 text-muted-foreground/40 opacity-20" />
                                                    <p className="text-sm">No organizations matching your search</p>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
                <CardHeader className="pb-4 border-b border-white/[0.05] bg-white/[0.01]">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                            <div className="p-2 rounded-none bg-muted border border-border">
                                <History className="h-4 w-4 text-muted-foreground" />
                            </div>
                            Audit Trail
                        </CardTitle>
                        <Badge variant="outline" className="bg-white/5 border-white/10 text-muted-foreground font-normal">
                            {auditLogs.length} Events
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {auditLoading ? (
                        <div className="flex items-center justify-center py-10">
                            <SmesLoader variant="bars" />
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-white/[0.05] hover:bg-transparent">
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">When</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Admin</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Organization</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Action</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Summary</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {auditLogs.map((log) => (
                                        <TableRow key={log.id} className="border-white/[0.05] hover:bg-white/[0.02] transition-colors">
                                            <TableCell className="text-xs text-muted-foreground">{formatResetDate(log.created_at)}</TableCell>
                                            <TableCell className="text-xs text-foreground/80">{log.user_email || 'Unknown admin'}</TableCell>
                                            <TableCell className="text-xs text-foreground/80">{log.org_name || 'Unknown org'}</TableCell>
                                            <TableCell>
                                                <Badge className="text-[10px] px-2 py-0.5 border rounded-full bg-muted text-muted-foreground border-border">
                                                    <ShieldCheck className="h-3 w-3 mr-1" />
                                                    {formatAuditAction(log.action)}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-xs text-muted-foreground max-w-[420px] truncate">
                                                {log.metadata?.after
                                                    ? JSON.stringify(log.metadata.after)
                                                    : JSON.stringify(log.metadata || {})}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                    {!auditLogs.length && (
                                        <TableRow>
                                            <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                                                No audit events yet
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ─── Edit Plan Dialog ────────────────────────────────────────── */}
            <Dialog open={!!editOrg} onOpenChange={(o) => !o && setEditOrg(null)}>
                <DialogContent className="bg-card border-white/10 shadow-2xl backdrop-blur-2xl max-w-md">
                    <DialogHeader className="mb-4">
                        <div className="h-12 w-12 rounded-none bg-muted border border-border flex items-center justify-center mb-2">
                            <CreditCard className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <DialogTitle className="text-white text-xl">Modify Subscription</DialogTitle>
                        <p className="text-sm text-muted-foreground">Updating plan for <span className="text-white font-medium">{editOrg?.org_name}</span></p>
                    </DialogHeader>
                    <div className="space-y-5">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Billing Access</Label>
                            <Select
                                value={editBillingMode}
                                onValueChange={(value: 'free' | 'paid') => {
                                    setEditBillingMode(value);
                                    if (value === 'free') {
                                        setEditTier('free');
                                        setEditUsageLimit(String(getDefaultPublishLimit('free')));
                                    } else {
                                        const nextTier = editTier === 'free' ? 'pro' : editTier;
                                        setEditTier(nextTier);
                                        setEditUsageLimit(String(getDefaultPublishLimit(nextTier)));
                                    }
                                }}
                            >
                                <SelectTrigger className="h-11 bg-white/5 border-white/10 text-white focus:ring-primary/20 transition-all">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-white/10 text-white shadow-2xl">
                                    <SelectItem value="free">Free Access</SelectItem>
                                    <SelectItem value="paid">Paid Access</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Plan Tier</Label>
                            <Select
                                value={editTier}
                                onValueChange={(value) => {
                                    setEditTier(value);
                                    setEditBillingMode(isPaidTier(value) ? 'paid' : 'free');
                                    setEditUsageLimit(String(getDefaultPublishLimit(value)));
                                }}
                            >
                                <SelectTrigger className="h-11 bg-white/5 border-white/10 text-white focus:ring-primary/20 transition-all">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-white/10 text-white shadow-2xl">
                                    <SelectItem value="free">Free ($0/mo)</SelectItem>
                                    <SelectItem value="pro">Pro ($8/mo)</SelectItem>
                                    <SelectItem value="agency">Agency ($25/mo)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Subscription Status</Label>
                            <Select value={editStatus} onValueChange={setEditStatus}>
                                <SelectTrigger className="h-11 bg-white/5 border-white/10 text-white focus:ring-primary/20 transition-all">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-white/10 text-white shadow-2xl">
                                    <SelectItem value="active">Active</SelectItem>
                                    <SelectItem value="suspended">Suspended</SelectItem>
                                    <SelectItem value="cancelled">Cancelled</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Plan units ($19 each above included)</Label>
                            {editPlan ? (
                                <div className="grid grid-cols-2 gap-2">
                                    {UNITS.map((unit) => (
                                        <div key={unit} className="rounded-none border border-white/10 bg-white/5 px-3 py-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-foreground/80">{UNIT_LABELS[unit].plural}</span>
                                                <Input
                                                    type="number"
                                                    min={0}
                                                    value={editUnits[unit]}
                                                    onChange={(e) => setEditUnits({ ...editUnits, [unit]: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                                    className="h-7 w-16 bg-transparent border-white/10 text-white text-right px-2"
                                                />
                                            </div>
                                            <p className={cn('text-[10px] mt-1', editPlan.usage[unit] > editUnits[unit] ? 'text-red-400' : 'text-muted-foreground')}>
                                                {editPlan.usage[unit]} in use
                                            </p>
                                        </div>
                                    ))}
                                    <p className="col-span-2 text-[10px] text-muted-foreground">
                                        Estimate {formatDollars(editPlan.catalog.base_price_cents + UNITS.reduce((n, u) => n + Math.max(0, editUnits[u] - editPlan.catalog[`included_${u}`]) * editPlan.catalog[`${u === 'databases' ? 'database' : u.slice(0, -1)}_price_cents`], 0))}/mo
                                    </p>
                                </div>
                            ) : (
                                <p className="text-[10px] text-muted-foreground">Loading plan units…</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Total Seat Allocation</Label>
                            <div className="relative">
                                <Users className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    type="number"
                                    value={editSeats}
                                    onChange={(e) => setEditSeats(e.target.value)}
                                    className="pl-10 h-11 bg-white/5 border-white/10 text-white focus:border-primary/50 focus:ring-primary/20 transition-all"
                                    placeholder="e.g. 5"
                                />
                            </div>
                            <p className="text-[10px] text-muted-foreground">Currently using {editOrg?.seats_used} seats.</p>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Publish Lines Limit (monthly)</Label>
                            <Input
                                type="number"
                                min="1"
                                value={editUsageLimit}
                                onChange={(e) => setEditUsageLimit(e.target.value)}
                                className="h-11 bg-white/5 border-white/10 text-white focus:border-primary/50 focus:ring-primary/20 transition-all"
                                placeholder="30 or 100"
                            />
                            <p className="text-[10px] text-muted-foreground">Free default: 30 lines/mo. Pro/Agency default: 100 lines/mo.</p>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Publish Lines Reset Date</Label>
                            <Input
                                type="datetime-local"
                                value={editResetAt}
                                onChange={(e) => setEditResetAt(e.target.value)}
                                className="h-11 bg-white/5 border-white/10 text-white focus:border-primary/50 focus:ring-primary/20 transition-all"
                            />
                            <p className="text-[10px] text-muted-foreground">This controls when the next usage window resets.</p>
                        </div>
                    </div>
                    <DialogFooter className="mt-8 gap-2">
                        <Button
                            variant="ghost"
                            onClick={() => setEditOrg(null)}
                            className="flex-1 text-muted-foreground hover:text-white hover:bg-white/5 transition-all"
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleSave}
                            className="flex-1 bg-primary hover:bg-primary text-white shadow-lg shadow-black/20 transition-all"
                            disabled={saving}
                        >
                            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                            {saving ? 'Saving...' : 'Apply Changes'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
