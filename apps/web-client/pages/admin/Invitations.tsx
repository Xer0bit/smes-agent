import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Page, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';
import { toast } from 'sonner';

const DIALOG = 'bg-[hsl(var(--admin-surface-dialog))] border-white/10 text-white';
const STATUS_TONE: Record<Invitation['status'], 'warn' | 'ok' | 'bad' | 'gray'> = { pending: 'warn', accepted: 'ok', declined: 'bad', expired: 'gray' };

interface Invitation {
    id: string;
    org_id: string;
    email: string;
    role: string;
    status: 'pending' | 'accepted' | 'declined' | 'expired';
    token: string;
    invited_by: string | null;
    expires_at: string;
    created_at: string;
    org_name?: string;
    inviter_email?: string;
}

export default function AdminInvitations() {
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('all');
    const [revokeId, setRevokeId] = useState<string | null>(null);

    useEffect(() => { loadInvitations(); }, [statusFilter]);

    const loadInvitations = async () => {
        try {
            setLoading(true);
            let query = supabase.from('org_invitations').select('*').order('created_at', { ascending: false });
            if (statusFilter !== 'all') query = query.eq('status', statusFilter);
            const { data, error } = await query;
            if (error) throw error;

            const enriched: Invitation[] = await Promise.all(
                (data || []).map(async (inv) => {
                    let inviter_email = '';
                    const { data: org } = await supabase.from('organizations').select('name').eq('id', inv.org_id).single();
                    const org_name = org?.name || 'Unknown';
                    if (inv.invited_by) {
                        const { data: profile } = await supabase.from('profiles').select('email').eq('id', inv.invited_by).single();
                        inviter_email = profile?.email || '';
                    }
                    return { ...inv, org_name, inviter_email };
                })
            );
            setInvitations(enriched);
        } catch (error) {
            console.error('Failed to load invitations:', error);
            toast.error('Failed to load invitations');
        } finally {
            setLoading(false);
        }
    };

    const handleRevoke = async () => {
        if (!revokeId) return;
        try {
            const { error } = await supabase.from('org_invitations').update({ status: 'expired' }).eq('id', revokeId);
            if (error) throw error;
            toast.success('Invitation revoked');
            setRevokeId(null);
            loadInvitations();
        } catch {
            toast.error('Failed to revoke invitation');
        }
    };

    const handleResend = async (inv: Invitation) => {
        try {
            const { error } = await supabase
                .from('org_invitations')
                .update({ status: 'pending', expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
                .eq('id', inv.id);
            if (error) throw error;
            await supabase.functions.invoke('org-invitation', {
                body: { email: inv.email, token: inv.token, org_name: inv.org_name, inviter_name: inv.inviter_email || 'Admin', role: inv.role },
            });
            toast.success(`Invitation resent to ${inv.email}`);
            loadInvitations();
        } catch {
            toast.error('Failed to resend invitation');
        }
    };

    const q = searchQuery.toLowerCase();
    const filtered = invitations.filter((inv) => inv.email.toLowerCase().includes(q) || inv.org_name?.toLowerCase().includes(q));

    return (
        <Page
            title="Invitations"
            actions={
                <>
                    <span className="text-xs text-gray-500">{filtered.length}</span>
                    <input className={`${input} w-64`} placeholder="Search email or org" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className={`${input} w-32`}><SelectValue /></SelectTrigger>
                        <SelectContent className="bg-[#1a1d24] border-white/10">
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="accepted">Accepted</SelectItem>
                            <SelectItem value="declined">Declined</SelectItem>
                            <SelectItem value="expired">Expired</SelectItem>
                        </SelectContent>
                    </Select>
                </>
            }
        >
            <Panel>
                <Table head={['Email', 'Organization', 'Role', 'Status', 'Invited by', 'Expires', '']} empty={loading ? 'Loading' : 'No invitations'}>
                    {filtered.map((inv) => (
                        <tr key={inv.id}>
                            <td className="text-white">{inv.email}</td>
                            <td className="text-gray-400">{inv.org_name}</td>
                            <td><Tag tone="accent">{inv.role}</Tag></td>
                            <td><Tag tone={STATUS_TONE[inv.status] ?? 'gray'}>{inv.status}</Tag></td>
                            <td className="text-gray-400">{inv.inviter_email || '—'}</td>
                            <td className="text-gray-400">{when(inv.expires_at)}</td>
                            <td className="text-right whitespace-nowrap">
                                {inv.status !== 'accepted' && <button className={btn.ghost} onClick={() => handleResend(inv)}>Resend</button>}
                                {inv.status === 'pending' && <button className={`${btn.danger} ml-1`} onClick={() => setRevokeId(inv.id)}>Revoke</button>}
                            </td>
                        </tr>
                    ))}
                </Table>
            </Panel>

            <Dialog open={!!revokeId} onOpenChange={(o) => { if (!o) setRevokeId(null); }}>
                <DialogContent className={DIALOG}>
                    <DialogHeader><DialogTitle className="text-sm">Revoke invitation?</DialogTitle></DialogHeader>
                    <p className="text-[13px] text-gray-400">The invitation expires immediately and the link stops working.</p>
                    <DialogFooter>
                        <button className={btn.ghost} onClick={() => setRevokeId(null)}>Cancel</button>
                        <button className={btn.danger} onClick={handleRevoke}>Revoke</button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Page>
    );
}
