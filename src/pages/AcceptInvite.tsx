import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Building2, CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

type InvitationData = {
    id: string;
    org_id: string;
    email: string;
    role: string;
    status: string;
    token: string;
    expires_at: string;
    created_at: string;
    invited_by?: string;
    project_ids?: string[];
    org_name?: string;
};

export default function AcceptInvite() {
    const { token } = useParams<{ token: string }>();
    const navigate = useNavigate();

    const [loading, setLoading] = useState(true);
    const [accepting, setAccepting] = useState(false);
    const [invitation, setInvitation] = useState<InvitationData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [currentUser, setCurrentUser] = useState<{ id: string; email: string } | null>(null);

    useEffect(() => {
        loadInvitation();
    }, [token]);

    const loadInvitation = async () => {
        try {
            setLoading(true);
            setError(null);

            // Check if user is authenticated
            const { data: { user } } = await supabase.auth.getUser();

            if (!user) {
                // Redirect to auth with return URL
                const returnUrl = `/invite/${token}`;
                navigate(`/auth?redirect=${encodeURIComponent(returnUrl)}`);
                return;
            }

            setCurrentUser({ id: user.id, email: user.email || '' });

            // Fetch invitation by token
            const { data: inv, error: invError } = await supabase
                .from('org_invitations')
                .select('*')
                .eq('token', token)
                .single();

            if (invError || !inv) {
                setError('Invitation not found. It may have been cancelled or the link is invalid.');
                return;
            }

            // Check expiration
            if (new Date(inv.expires_at) < new Date()) {
                setError('This invitation has expired. Please ask the admin to send a new one.');
                // Update status to expired
                await supabase
                    .from('org_invitations')
                    .update({ status: 'expired' })
                    .eq('id', inv.id);
                return;
            }

            // Check if already accepted
            if (inv.status === 'accepted') {
                setError('This invitation has already been accepted.');
                return;
            }

            if (inv.status === 'declined') {
                setError('This invitation has been declined.');
                return;
            }

            if (inv.status === 'expired') {
                setError('This invitation has expired.');
                return;
            }

            // Check email match
            if (inv.email.toLowerCase() !== user.email?.toLowerCase()) {
                setError(`This invitation was sent to ${inv.email}. Please log in with that email address.`);
                return;
            }

            // Fetch org name
            const { data: org } = await supabase
                .from('organizations')
                .select('name')
                .eq('id', inv.org_id)
                .single();

            setInvitation({
                ...inv,
                org_name: org?.name || 'Unknown Organization',
            });
        } catch (err) {
            console.error('Error loading invitation:', err);
            setError('Failed to load invitation. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleAccept = async () => {
        if (!invitation || !currentUser) return;

        try {
            setAccepting(true);

            // Use SECURITY DEFINER RPC   handles org membership, project access grants,
            // and invitation status update, all bypassing client-side RLS restrictions.
            const { data, error: rpcErr } = await supabase
                .rpc('accept_org_invitation', { p_token: invitation.token });

            if (rpcErr) throw rpcErr;

            if (data && !data.success) {
                toast.error(data.error || 'Failed to accept invitation');
                return;
            }

            if (data?.already_member) {
                toast.info('You are already a member of this organization.');
            } else {
                toast.success(`You've joined ${invitation.org_name}!`);
            }
            navigate('/dashboard/organizations');
        } catch (err) {
            console.error('Error accepting invitation:', err);
            toast.error('Failed to accept invitation. Please try again.');
        } finally {
            setAccepting(false);
        }
    };

    const handleDecline = async () => {
        if (!invitation) return;

        try {
            await supabase
                .from('org_invitations')
                .update({ status: 'declined' })
                .eq('id', invitation.id);

            toast.info('Invitation declined.');
            navigate('/dashboard');
        } catch (err) {
            console.error('Error declining invitation:', err);
            toast.error('Failed to decline invitation.');
        }
    };

    const getRoleName = (role: string) => {
        switch (role) {
            case 'admin': return 'Admin';
            case 'billing_admin': return 'Billing Admin';
            default: return 'Member';
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                    <p className="text-gray-400">Loading invitation...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
                <Card className="max-w-md w-full bg-[#1a1a1a] border-white/10">
                    <CardContent className="flex flex-col items-center py-12 text-center">
                        <XCircle className="h-16 w-16 text-red-500 mb-4" />
                        <h2 className="text-xl font-semibold text-white mb-2">Invitation Error</h2>
                        <p className="text-gray-400 mb-6">{error}</p>
                        <Button onClick={() => navigate('/dashboard')} variant="outline">
                            Go to Dashboard
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (!invitation) return null;

    return (
        <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
            <Card className="max-w-md w-full bg-[#1a1a1a] border-white/10">
                <CardHeader className="text-center pb-2">
                    <div className="flex justify-center mb-4">
                        <div className="h-16 w-16 rounded-full bg-indigo-600/20 flex items-center justify-center">
                            <Building2 className="h-8 w-8 text-indigo-400" />
                        </div>
                    </div>
                    <CardTitle className="text-2xl text-white">You're Invited!</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="text-center">
                        <p className="text-gray-400">
                            You've been invited to join
                        </p>
                        <p className="text-xl font-semibold text-white mt-1">
                            {invitation.org_name}
                        </p>
                    </div>

                    <div className="flex justify-center">
                        <Badge className="bg-indigo-600/20 text-indigo-400 px-4 py-1.5 text-sm">
                            Role: {getRoleName(invitation.role)}
                        </Badge>
                    </div>

                    <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                        <Clock className="h-4 w-4" />
                        <span>Expires {new Date(invitation.expires_at).toLocaleDateString()}</span>
                    </div>

                    <div className="flex gap-3">
                        <Button
                            variant="outline"
                            className="flex-1 border-white/10 text-gray-400 hover:text-white"
                            onClick={handleDecline}
                        >
                            Decline
                        </Button>
                        <Button
                            className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white"
                            onClick={handleAccept}
                            disabled={accepting}
                        >
                            {accepting ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Joining...
                                </>
                            ) : (
                                <>
                                    <CheckCircle className="h-4 w-4 mr-2" />
                                    Accept & Join
                                </>
                            )}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
