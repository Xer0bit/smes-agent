import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Search, Mail, RotateCcw, Trash2, Clock, CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

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

    useEffect(() => {
        loadInvitations();
    }, [statusFilter]);

    const loadInvitations = async () => {
        try {
            setLoading(true);
            let query = supabase
                .from('org_invitations')
                .select('*')
                .order('created_at', { ascending: false });

            if (statusFilter !== 'all') {
                query = query.eq('status', statusFilter);
            }

            const { data, error } = await query;
            if (error) throw error;

            // Enrich with org names and inviter emails
            const enriched = await Promise.all(
                (data || []).map(async (inv: any) => {
                    let org_name = '';
                    let inviter_email = '';

                    const { data: org } = await supabase
                        .from('organizations')
                        .select('name')
                        .eq('id', inv.org_id)
                        .single();
                    org_name = org?.name || 'Unknown';

                    if (inv.invited_by) {
                        const { data: profile } = await supabase
                            .from('profiles')
                            .select('email')
                            .eq('id', inv.invited_by)
                            .single();
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
            const { error } = await supabase
                .from('org_invitations')
                .update({ status: 'expired' })
                .eq('id', revokeId);

            if (error) throw error;
            toast.success('Invitation revoked');
            setRevokeId(null);
            loadInvitations();
        } catch (error) {
            toast.error('Failed to revoke invitation');
        }
    };

    const handleResend = async (inv: Invitation) => {
        try {
            // Reset expiry and status
            const { error } = await supabase
                .from('org_invitations')
                .update({
                    status: 'pending',
                    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                })
                .eq('id', inv.id);

            if (error) throw error;

            // Trigger email
            await supabase.functions.invoke('org-invitation', {
                body: {
                    email: inv.email,
                    token: inv.token,
                    org_name: inv.org_name,
                    inviter_name: inv.inviter_email || 'Admin',
                    role: inv.role,
                },
            });

            toast.success(`Invitation resent to ${inv.email}`);
            loadInvitations();
        } catch (error) {
            toast.error('Failed to resend invitation');
        }
    };

    const statusIcon = (status: string) => {
        switch (status) {
            case 'pending': return <Clock className="h-3.5 w-3.5 text-amber-400" />;
            case 'accepted': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
            case 'declined': return <XCircle className="h-3.5 w-3.5 text-red-400" />;
            case 'expired': return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
        }
    };

    const statusColor = (status: string) => {
        switch (status) {
            case 'pending': return { bg: 'rgba(245,158,11,0.1)', color: '#fbbf24', border: 'rgba(245,158,11,0.2)' };
            case 'accepted': return { bg: 'rgba(16,185,129,0.1)', color: '#34d399', border: 'rgba(16,185,129,0.2)' };
            case 'declined': return { bg: 'rgba(239,68,68,0.1)', color: '#f87171', border: 'rgba(239,68,68,0.2)' };
            default: return { bg: 'rgba(107,114,128,0.1)', color: '#9ca3af', border: 'rgba(107,114,128,0.2)' };
        }
    };

    const filtered = invitations.filter(inv =>
        inv.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        inv.org_name?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const formatDate = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* ─── Filters ─────────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="relative flex-1 w-full max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-muted-foreground" />
                    <Input
                        placeholder="Search by email or organization..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 h-10 text-sm bg-white/[0.03] border-white/10 text-white placeholder:text-muted-foreground focus:border-primary/50 focus:ring-primary/20 transition-all"
                    />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-full sm:w-48 h-10 bg-white/[0.03] border-white/10 text-white text-sm focus:ring-primary/20">
                        <SelectValue placeholder="All Status" />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-white/10 text-white">
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="accepted">Accepted</SelectItem>
                        <SelectItem value="declined">Declined</SelectItem>
                        <SelectItem value="expired">Expired</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* ─── Table Card ─────────────────────────────────────────────── */}
            <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
                <CardHeader className="pb-4 border-b border-white/[0.05] bg-white/[0.01]">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                            <div className="p-2 rounded-none bg-muted border border-border">
                                <Mail className="h-4 w-4 text-muted-foreground" />
                            </div>
                            Invitations List
                        </CardTitle>
                        <Badge variant="outline" className="bg-white/5 border-white/10 text-muted-foreground font-normal">
                            {filtered.length} Total
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-24 gap-3">
                            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            <p className="text-xs text-muted-foreground">Loading invitations...</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-white/[0.05] hover:bg-transparent">
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Email Address</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Organization</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-center">Role</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Status</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Invited By</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4">Expires</TableHead>
                                        <TableHead className="text-muted-foreground text-xs font-semibold py-4 text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((inv) => {
                                        const sc = statusColor(inv.status);
                                        return (
                                            <TableRow key={inv.id} className="border-white/[0.05] hover:bg-white/[0.02] transition-colors group">
                                                <TableCell className="py-4">
                                                    <div className="flex items-center gap-2">
                                                        <div className="h-2 w-2 rounded-full bg-primary animate-pulse hidden" />
                                                        <span className="text-sm text-foreground font-medium group-hover:text-white transition-colors">
                                                            {inv.email}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-sm text-muted-foreground">{inv.org_name}</TableCell>
                                                <TableCell className="text-center">
                                                    <Badge className="text-[10px] bg-muted text-muted-foreground border-border capitalize font-medium">
                                                        {inv.role}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        className="text-[10px] flex items-center gap-1.5 w-fit border shadow-sm px-2 py-0.5"
                                                        style={{ background: sc.bg, color: sc.color, borderColor: sc.border }}
                                                    >
                                                        {statusIcon(inv.status)}
                                                        {inv.status}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-sm text-muted-foreground font-mono text-xs">{inv.inviter_email || ' '}</TableCell>
                                                <TableCell className="text-xs text-muted-foreground font-medium">{formatDate(inv.expires_at)}</TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                                        {(inv.status === 'pending' || inv.status === 'expired' || inv.status === 'declined') && (
                                                            <Button
                                                                variant="ghost" size="sm"
                                                                className="h-8 w-8 p-0 text-muted-foreground hover:text-muted-foreground hover:bg-muted rounded-none transition-all"
                                                                onClick={() => handleResend(inv)}
                                                                title="Resend Invitation"
                                                            >
                                                                <RotateCcw className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                        {inv.status === 'pending' && (
                                                            <Button
                                                                variant="ghost" size="sm"
                                                                className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-none transition-all"
                                                                onClick={() => setRevokeId(inv.id)}
                                                                title="Revoke Invitation"
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {filtered.length === 0 && (
                                        <TableRow>
                                            <TableCell colSpan={7} className="text-center text-muted-foreground py-20">
                                                <div className="flex flex-col items-center gap-2">
                                                    <Mail className="h-10 w-10 text-muted-foreground/40 opacity-20" />
                                                    <p className="text-sm">No invitations found matching your search</p>
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

            {/* ─── Revoke Dialog ──────────────────────────────────────────── */}
            <AlertDialog open={!!revokeId} onOpenChange={(o) => !o && setRevokeId(null)}>
                <AlertDialogContent className="bg-card border-white/10 shadow-2xl backdrop-blur-2xl">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="text-white text-lg">Revoke Invitation?</AlertDialogTitle>
                        <AlertDialogDescription className="text-muted-foreground leading-relaxed">
                            This will expire the invitation immediately. The recipient will no longer be able to join using the original link. This action is recorded in the activity log.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="pt-4">
                        <AlertDialogCancel className="bg-white/5 border-white/10 text-foreground/80 hover:bg-white/10 hover:text-white transition-all">
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleRevoke}
                            className="bg-red-600/90 hover:bg-red-600 text-white shadow-lg shadow-red-900/20 transition-all"
                        >
                            Revoke Invitation
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
