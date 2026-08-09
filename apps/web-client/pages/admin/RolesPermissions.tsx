import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Shield, Users, Info, Loader2, Building2, Crown, ArrowRight, CheckCircle2, Sliders } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { adminTierConfigService, type TierConfig, type TierFeatures, type TierLimits } from '@/services/adminTierConfigService';

interface OrganizationRole {
    id: string;
    org_name: string;
    user_email: string;
    role: string;
    created_at: string;
}

const FEATURE_LIST: { key: keyof TierFeatures; label: string; description: string }[] = [
    { key: 'ai_agent',        label: 'AI Agent',            description: 'Full AI agent for content & code generation' },
    { key: 'hosting',         label: 'Hosting',             description: 'One-click publish to eComGear hosting' },
    { key: 'custom_domains',  label: 'Custom Domains',      description: 'Map custom domains to projects' },
    { key: 'remove_branding', label: 'Remove Branding',     description: 'Hide the "Made with eComGear" footer' },
    { key: 'export_code',     label: 'Export Code',         description: 'Download the full project source' },
    { key: 'analytics',       label: 'Analytics',           description: 'Traffic & usage analytics dashboard' },
    { key: 'api_access',      label: 'API Access',          description: 'REST API for external integrations' },
    { key: 'invite_editors',  label: 'Invite Editors',      description: 'Invite team members as editors' },
    { key: 'invite_clients',  label: 'Invite Clients',      description: 'Add client accounts to projects' },
    { key: 'integration_app', label: 'Integration Apps',    description: 'Marketplace integrations' },
    { key: 'auto_pilot',      label: 'AutoPilot',           description: 'Scheduled content generation' },
    { key: 'ali_cloud',       label: 'AliCloud Migration',  description: 'Migrate to Alibaba Cloud' },
    { key: 'ecomgear_cloud',  label: 'eComGear Cloud',      description: 'Managed cloud with custom domain' },
    { key: 'client_markup',   label: 'Client Markup',       description: 'Charge clients with markup fees' },
    { key: 'priority_support',label: 'Priority Support',    description: '24/7 priority customer support' },
    { key: 'sso',             label: 'SSO',                 description: 'Single Sign-On via SAML/OIDC' },
    { key: 'sla',             label: 'SLA',                 description: '99.9% uptime SLA guarantee' },
];

const LIMIT_LIST: { key: keyof TierLimits; label: string; description: string; unlimited?: boolean }[] = [
    { key: 'ai_gens_limit',       label: 'Eco / Month',           description: 'Max AI eco units per month (free=10, pro/agency=100)' },
    { key: 'publish_lines_limit', label: 'Publish Lines / Month', description: 'Max lines publishable per month' },
    { key: 'seats_total',         label: 'Seats',                 description: 'Max team members per organization' },
    { key: 'max_projects',        label: 'Max Projects',          description: 'Max projects per organization (999999 = unlimited)' },
];

const PLAN_TIERS: { key: 'free' | 'pro' | 'agency'; label: string; color: string }[] = [
    { key: 'free',   label: 'Free',   color: 'text-gray-300 border-gray-500/30 bg-gray-500/10' },
    { key: 'pro',    label: 'Pro',    color: 'text-purple-300 border-purple-500/30 bg-purple-500/10' },
    { key: 'agency', label: 'Agency', color: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
];

export default function AdminRolesPermissions() {
    const [config, setConfig] = useState<TierConfig | null>(null);
    const [saving, setSaving] = useState(false);
    const [configLoading, setConfigLoading] = useState(true);
    const [roles, setRoles] = useState<OrganizationRole[]>([]);
    const [rolesLoading, setRolesLoading] = useState(true);
    const [lastSaved, setLastSaved] = useState<string | null>(null);

    useEffect(() => {
        loadConfig();
        loadRoles();
    }, []);

    const loadConfig = async () => {
        try {
            setConfigLoading(true);
            const data = await adminTierConfigService.getConfig();
            setConfig(data);
        } catch (error) {
            console.error('Error loading tier config:', error);
            toast.error('Failed to load tier configuration');
        } finally {
            setConfigLoading(false);
        }
    };

    const persistConfig = useCallback(async (next: TierConfig) => {
        setSaving(true);
        setConfig(next);
        try {
            const saved = await adminTierConfigService.saveConfig(next);
            setConfig(saved);
            setLastSaved(new Date().toLocaleTimeString());
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to save');
            await loadConfig();
        } finally {
            setSaving(false);
        }
    }, []);

    const toggleFeature = (tier: 'free' | 'pro' | 'agency', feature: keyof TierFeatures, value: boolean) => {
        if (!config) return;
        const next: TierConfig = {
            ...config,
            features: {
                ...config.features,
                [tier]: { ...config.features[tier], [feature]: value },
            },
        };
        persistConfig(next);
    };

    const updateLimit = (tier: 'free' | 'pro' | 'agency', key: keyof TierLimits, value: number) => {
        if (!config) return;
        const next: TierConfig = {
            ...config,
            limits: {
                ...config.limits,
                [tier]: { ...config.limits[tier], [key]: value },
            },
        };
        persistConfig(next);
    };

    const loadRoles = async () => {
        try {
            setRolesLoading(true);
            const { data, error } = await supabase
                .from('org_members')
                .select('id, role, created_at, org_id, user_id')
                .order('created_at', { ascending: false });

            if (error) throw error;

            const rows = data || [];
            const orgIds = Array.from(new Set(rows.map((r: any) => r.org_id).filter(Boolean)));
            const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));

            const [orgRes, profileRes] = await Promise.all([
                orgIds.length
                    ? supabase.from('organizations').select('id, name').in('id', orgIds)
                    : Promise.resolve({ data: [] as any[] }),
                userIds.length
                    ? supabase.from('profiles').select('id, email').in('id', userIds)
                    : Promise.resolve({ data: [] as any[] }),
            ]);

            const orgMap = new Map((orgRes.data || []).map((org: any) => [org.id, org.name]));
            const profileMap = new Map((profileRes.data || []).map((profile: any) => [profile.id, profile.email]));

            setRoles(rows.map((r: any) => ({
                id: r.id,
                role: r.role,
                created_at: r.created_at,
                org_name: orgMap.get(r.org_id) || 'Unknown',
                user_email: profileMap.get(r.user_id) || 'Unknown',
            })));
        } catch (error) {
            console.error('Error loading roles:', error);
            toast.error('Failed to load role assignments');
        } finally {
            setRolesLoading(false);
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-500 pb-12">

            {/* ─── Save Status Bar ──────────────────────────────────────── */}
            <div className="rounded-xl border p-3 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(139,92,246,0.1)' }}>
                <div className="flex items-center gap-2 text-xs text-gray-300">
                    {saving
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" />
                        : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                    {saving ? 'Saving…' : `Saved${lastSaved ? ` at ${lastSaved}` : ''}`}
                </div>
                <Button variant="outline" size="sm" onClick={loadConfig} disabled={configLoading || saving} className="h-8 gap-2 border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 text-xs">
                    {configLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Refresh
                </Button>
            </div>

            {/* ─── Feature Permissions ──────────────────────────────────── */}
            <div className="grid gap-6">
                <div className="flex flex-col gap-1">
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Shield className="h-5 w-5 text-purple-400" />
                        Feature Permissions
                    </h2>
                    <p className="text-sm text-gray-500">Toggle features on/off per subscription tier. Changes take effect immediately.</p>
                </div>

                <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
                    <CardContent className="p-0">
                        {configLoading ? (
                            <div className="flex items-center justify-center py-16">
                                <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-white/[0.05] hover:bg-transparent">
                                        <TableHead className="w-[280px] text-gray-400 text-xs font-semibold py-5 pl-6">Feature</TableHead>
                                        {PLAN_TIERS.map(tier => (
                                            <TableHead key={tier.key} className="text-center py-5 text-xs font-semibold">
                                                <Badge className={cn('text-[11px] px-3 py-0.5 border font-semibold', tier.color)}>
                                                    {tier.label}
                                                </Badge>
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {FEATURE_LIST.map((feat) => (
                                        <TableRow key={feat.key} className="border-white/[0.05] hover:bg-white/[0.01] transition-colors">
                                            <TableCell className="py-4 pl-6">
                                                <div className="space-y-0.5">
                                                    <div className="text-sm font-medium text-gray-200">{feat.label}</div>
                                                    <div className="text-xs text-gray-500">{feat.description}</div>
                                                </div>
                                            </TableCell>
                                            {PLAN_TIERS.map(tier => (
                                                <TableCell key={tier.key} className="text-center">
                                                    <div className="flex justify-center">
                                                        <Switch
                                                            checked={config?.features[tier.key]?.[feat.key] ?? false}
                                                            onCheckedChange={(v) => toggleFeature(tier.key, feat.key, v)}
                                                            disabled={saving}
                                                            className="data-[state=checked]:bg-emerald-500"
                                                        />
                                                    </div>
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* ─── Usage Limits ─────────────────────────────────────────── */}
            <div className="grid gap-6">
                <div className="flex flex-col gap-1">
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Sliders className="h-5 w-5 text-blue-400" />
                        Usage Limits
                    </h2>
                    <p className="text-sm text-gray-500">Set numeric quotas per tier. For unlimited, enter 999999.</p>
                </div>

                <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
                    <CardContent className="p-0">
                        {configLoading ? (
                            <div className="flex items-center justify-center py-16">
                                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-white/[0.05] hover:bg-transparent">
                                        <TableHead className="w-[280px] text-gray-400 text-xs font-semibold py-5 pl-6">Limit</TableHead>
                                        {PLAN_TIERS.map(tier => (
                                            <TableHead key={tier.key} className="text-center py-5 text-xs font-semibold">
                                                <Badge className={cn('text-[11px] px-3 py-0.5 border font-semibold', tier.color)}>
                                                    {tier.label}
                                                </Badge>
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {LIMIT_LIST.map((limit) => (
                                        <TableRow key={limit.key} className="border-white/[0.05] hover:bg-white/[0.01] transition-colors">
                                            <TableCell className="py-4 pl-6">
                                                <div className="space-y-0.5">
                                                    <div className="text-sm font-medium text-gray-200">{limit.label}</div>
                                                    <div className="text-xs text-gray-500">{limit.description}</div>
                                                </div>
                                            </TableCell>
                                            {PLAN_TIERS.map(tier => (
                                                <TableCell key={tier.key} className="text-center px-4">
                                                    <Input
                                                        key={`${tier.key}-${limit.key}-${config?.updatedAt || ''}`}
                                                        type="number"
                                                        min={0}
                                                        defaultValue={config?.limits[tier.key]?.[limit.key] ?? 0}
                                                        onBlur={(e) => updateLimit(tier.key, limit.key, Number(e.target.value))}
                                                        disabled={saving}
                                                        className="bg-white/5 border-white/10 text-white h-8 text-xs text-center w-28 mx-auto"
                                                    />
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* ─── Active Member Roles ───────────────────────────────────── */}
            <div className="grid gap-6 pt-4">
                <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                            <Users className="h-5 w-5 text-blue-400" />
                            Active Member Roles
                        </h2>
                        <p className="text-sm text-gray-500">User roles across all registered organizations.</p>
                    </div>
                </div>

                <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
                    <CardHeader className="pb-4 border-b border-white/[0.05] bg-white/[0.01]">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                                <Info className="h-4 w-4 text-blue-400/60" />
                                Hierarchy Log
                            </CardTitle>
                            <Badge variant="outline" className="bg-white/5 border-white/10 text-gray-400 font-normal">
                                {roles.length} Assignments
                            </Badge>
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        {rolesLoading ? (
                            <div className="flex flex-col items-center justify-center py-24 gap-3">
                                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                                <p className="text-xs text-gray-500">Loading assignments...</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="border-white/[0.05] hover:bg-transparent">
                                            <TableHead className="text-gray-400 text-xs font-semibold py-4 pl-6">Member</TableHead>
                                            <TableHead className="text-gray-400 text-xs font-semibold py-4">Organization</TableHead>
                                            <TableHead className="text-gray-400 text-xs font-semibold py-4">Assigned Role</TableHead>
                                            <TableHead className="text-gray-400 text-xs font-semibold py-4">Since</TableHead>
                                            <TableHead className="text-gray-400 text-xs font-semibold py-4 text-right pr-6">Activity</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {roles.map((r) => {
                                            const isAdmin = r.role === 'admin' || r.role === 'owner';
                                            return (
                                                <TableRow key={r.id} className="border-white/[0.05] hover:bg-white/[0.02] transition-colors group">
                                                    <TableCell className="py-4 pl-6">
                                                        <div className="flex items-center gap-3">
                                                            <div className="h-8 w-8 rounded-full bg-primary/15 border border-white/10 flex items-center justify-center text-[10px] font-bold text-white">
                                                                {r.user_email.substring(0, 2).toUpperCase()}
                                                            </div>
                                                            <span className="text-sm text-gray-200 font-medium group-hover:text-white transition-colors">
                                                                {r.user_email}
                                                            </span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-sm text-gray-400">
                                                        <div className="flex items-center gap-2">
                                                            <Building2 className="h-3.5 w-3.5 opacity-40" />
                                                            {r.org_name}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge className={cn(
                                                            "text-[10px] flex items-center gap-1.5 w-fit border px-2 py-0.5 capitalize font-medium",
                                                            isAdmin
                                                                ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                                                : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                                        )}>
                                                            {isAdmin ? <Crown className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
                                                            {r.role}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-xs text-gray-500 font-medium">{new Date(r.created_at).toLocaleDateString()}</TableCell>
                                                    <TableCell className="text-right pr-6">
                                                        <Button variant="ghost" size="sm" className="h-8 text-gray-500 hover:text-white group-hover:bg-white/5 opacity-0 group-hover:opacity-100 transition-all">
                                                            <ArrowRight className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}