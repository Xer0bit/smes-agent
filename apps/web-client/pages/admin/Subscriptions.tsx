import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Page, Stats, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';
import { toast } from 'sonner';
import {
    fetchOrgPlan, updateOrgEntitlements, UNITS, UNIT_LABELS, formatDollars, unitPriceCents, includedQuantity,
    type PlanSnapshot, type Unit,
} from '@/services/planService';
import { PlanCatalogCard } from '@/components/admin/PlanCatalogCard';

const DIALOG = 'bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white';
const TIER_TONE: Record<string, 'gray' | 'accent' | 'warn'> = { free: 'gray', pro: 'accent', agency: 'warn' };

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

const getDefaultPublishLimit = (tier: string) => (['free', 'starter'].includes(tier) ? 30 : 100);
const getDefaultMaxProjects = (tier: string) => (['free', 'starter'].includes(tier) ? 5 : 999999);
const isPaidTier = (tier: string) => tier !== 'free';
const inThirtyDays = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

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

    useEffect(() => { loadSubscriptions(); }, []);

    const loadSubscriptions = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('organizations')
                .select('id, name, plan_tier, seats_total, seats_used, publish_lines_used, publish_lines_limit, publish_lines_reset_at, status, created_at, admin_managed')
                .order('name');
            if (error) throw error;
            const mapped: OrgSubscription[] = (data || []).map((org) => ({
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
            }));
            setSubscriptions(mapped);
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
            const resetAtIso = editResetAt ? new Date(editResetAt).toISOString() : inThirtyDays();
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
                    ...(isPaid ? { publish_lines_used: 0 } : {}),
                })
                .eq('id', editOrg.org_id);
            if (error) throw error;
            if (editPlan && UNITS.some((u) => editUnits[u] !== editPlan.entitlements[u])) {
                await updateOrgEntitlements(editOrg.org_id, editUnits);
            }
            toast.success(`Updated plan for ${editOrg.org_name}`);
            setEditOrg(null);
            loadSubscriptions();
        } catch {
            toast.error('Failed to update subscription');
        } finally {
            setSaving(false);
        }
    };

    const handleResetUsage = async (sub: OrgSubscription) => {
        try {
            const { error } = await supabase
                .from('organizations')
                .update({ publish_lines_used: 0, publish_lines_reset_at: inThirtyDays() })
                .eq('id', sub.org_id);
            if (error) throw error;
            toast.success(`Usage reset for ${sub.org_name}`);
            loadSubscriptions();
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
            toast.success(`Default limit applied to ${sub.org_name}`);
            loadSubscriptions();
        } catch {
            toast.error('Failed to apply default limit');
        }
    };

    const setBillingMode = (value: 'free' | 'paid') => {
        setEditBillingMode(value);
        const nextTier = value === 'free' ? 'free' : editTier === 'free' ? 'pro' : editTier;
        setEditTier(nextTier);
        setEditUsageLimit(String(getDefaultPublishLimit(nextTier)));
    };

    const setTier = (value: string) => {
        setEditTier(value);
        setEditBillingMode(isPaidTier(value) ? 'paid' : 'free');
        setEditUsageLimit(String(getDefaultPublishLimit(value)));
    };

    const estimateCents = (plan: PlanSnapshot) =>
        plan.catalog.base_price_cents + UNITS.reduce((n, u) => n + Math.max(0, editUnits[u] - includedQuantity(plan.catalog, u)) * unitPriceCents(plan.catalog, u), 0);

    const tierCount = (tier: string) => subscriptions.filter((s) => s.plan_tier === tier).length;
    const filtered = subscriptions.filter((s) => s.org_name.toLowerCase().includes(searchQuery.toLowerCase()));

    return (
        <Page
            title="Billing"
            actions={<input className={`${input} w-64`} placeholder="Search organization" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />}
        >
            <PlanCatalogCard />
            <Stats items={[
                { label: 'Organizations', value: subscriptions.length },
                { label: 'Free', value: tierCount('free') },
                { label: 'Pro', value: tierCount('pro') },
                { label: 'Agency', value: tierCount('agency') },
            ]} />

            <Panel>
                <Table head={['Organization', 'Tier', 'Billing', 'Seats', 'Status', 'Usage', 'Reset', '']} empty={loading ? 'Loading' : 'No organizations'}>
                    {filtered.map((sub) => (
                        <tr key={sub.org_id}>
                            <td className="text-white">{sub.org_name} {sub.admin_managed && <Tag tone="ok">Admin</Tag>}</td>
                            <td><Tag tone={TIER_TONE[sub.plan_tier] ?? 'gray'}>{sub.plan_tier}</Tag></td>
                            <td className="text-gray-400">{isPaidTier(sub.plan_tier) ? 'Paid' : 'Free'}</td>
                            <td className="text-gray-400">{sub.seats_used} / {sub.seats_total}</td>
                            <td><Tag tone={sub.status === 'active' ? 'ok' : 'bad'}>{sub.status}</Tag></td>
                            <td className="text-gray-400">{sub.publish_lines_used.toLocaleString()} / {sub.publish_lines_limit.toLocaleString()}</td>
                            <td className="text-gray-400">{when(sub.publish_lines_reset_at)}</td>
                            <td className="text-right whitespace-nowrap">
                                <button className={btn.ghost} onClick={() => handleResetUsage(sub)}>Reset</button>
                                <button className={`${btn.ghost} ml-1`} onClick={() => handleApplyDefaultLimit(sub)}>Default</button>
                                <button className={`${btn.ghost} ml-1`} onClick={() => handleEdit(sub)}>Edit</button>
                            </td>
                        </tr>
                    ))}
                </Table>
            </Panel>

            <Dialog open={!!editOrg} onOpenChange={(o) => { if (!o) setEditOrg(null); }}>
                <DialogContent className={`${DIALOG} max-w-md`}>
                    <DialogHeader><DialogTitle className="text-sm">Edit plan: {editOrg?.org_name}</DialogTitle></DialogHeader>
                    <div className="space-y-3 text-xs text-gray-400">
                        <label className="block space-y-1">
                            Billing
                            <Select value={editBillingMode} onValueChange={setBillingMode}>
                                <SelectTrigger className={input}><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-[#1a1d24] border-white/10">
                                    <SelectItem value="free">Free</SelectItem>
                                    <SelectItem value="paid">Paid</SelectItem>
                                </SelectContent>
                            </Select>
                        </label>
                        <label className="block space-y-1">
                            Tier
                            <Select value={editTier} onValueChange={setTier}>
                                <SelectTrigger className={input}><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-[#1a1d24] border-white/10">
                                    <SelectItem value="free">Free ($0/mo)</SelectItem>
                                    <SelectItem value="pro">Pro ($8/mo)</SelectItem>
                                    <SelectItem value="agency">Agency ($25/mo)</SelectItem>
                                </SelectContent>
                            </Select>
                        </label>
                        <label className="block space-y-1">
                            Status
                            <Select value={editStatus} onValueChange={setEditStatus}>
                                <SelectTrigger className={input}><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-[#1a1d24] border-white/10">
                                    <SelectItem value="active">Active</SelectItem>
                                    <SelectItem value="suspended">Suspended</SelectItem>
                                    <SelectItem value="cancelled">Cancelled</SelectItem>
                                </SelectContent>
                            </Select>
                        </label>
                        <div className="space-y-1">
                            Plan units
                            {editPlan ? (
                                <div className="grid grid-cols-2 gap-2">
                                    {UNITS.map((unit) => (
                                        <label key={unit} className="flex items-center justify-between gap-2 border border-white/10 rounded-md px-2 py-1">
                                            <span>{UNIT_LABELS[unit].plural} <span className={editPlan.usage[unit] > editUnits[unit] ? 'text-red-400' : 'text-gray-600'}>({editPlan.usage[unit]} used)</span></span>
                                            <input type="number" min={0} className={`${input} w-16 text-right`} value={editUnits[unit]}
                                                onChange={(e) => setEditUnits({ ...editUnits, [unit]: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
                                        </label>
                                    ))}
                                    <span className="col-span-2 text-gray-500">Estimate {formatDollars(estimateCents(editPlan))}/mo</span>
                                </div>
                            ) : <p className="text-gray-500">Loading</p>}
                        </div>
                        <label className="block space-y-1">
                            Seats ({editOrg?.seats_used} used)
                            <input type="number" className={input} value={editSeats} onChange={(e) => setEditSeats(e.target.value)} />
                        </label>
                        <label className="block space-y-1">
                            Publish lines limit
                            <input type="number" min={1} className={input} value={editUsageLimit} onChange={(e) => setEditUsageLimit(e.target.value)} />
                        </label>
                        <label className="block space-y-1">
                            Reset at
                            <input type="datetime-local" className={input} value={editResetAt} onChange={(e) => setEditResetAt(e.target.value)} />
                        </label>
                    </div>
                    <DialogFooter>
                        <button className={btn.ghost} disabled={saving} onClick={() => setEditOrg(null)}>Cancel</button>
                        <button className={btn.primary} disabled={saving} onClick={handleSave}>{saving ? 'Saving' : 'Save'}</button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Page>
    );
}
