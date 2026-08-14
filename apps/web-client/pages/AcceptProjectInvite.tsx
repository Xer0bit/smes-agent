import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, XCircle, Clock, Loader2, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';

interface InvitationInfo {
    id: string;
    project_id: string;
    project_name: string;
    email: string;
    inviter_name?: string;
    status: string;
    expires_at: string;
}

export default function AcceptProjectInvite() {
    const { token } = useParams<{ token: string }>();
    const navigate = useNavigate();
    const { refreshOrganization } = useOrganization();

    const [loading, setLoading] = useState(true);
    const [accepting, setAccepting] = useState(false);
    const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [currentUserEmail, setCurrentUserEmail] = useState('');
    const [currentUser, setCurrentUser] = useState<Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user']>(null);

    useEffect(() => {
        loadInvitation();
    }, [token]);

    const loadInvitation = async () => {
        try {
            setLoading(true);
            setError(null);

            // Require authentication
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                navigate(`/auth?redirect=${encodeURIComponent(`/project-invite/${token}`)}`);
                return;
            }
            setCurrentUserEmail(user.email || '');
            setCurrentUser(user);

            if (!token) {
                setError('Invalid invitation link.');
                return;
            }

            // Fetch invitation
            const { data: inv, error: invErr } = await supabase
                .from('project_invitations')
                .select('id, project_id, email, status, expires_at, invited_by')
                .eq('token', token)
                .single();

            if (invErr || !inv) {
                setError('Invitation not found. It may have been cancelled or the link is invalid.');
                return;
            }

            if (inv.status === 'accepted') {
                setError('This invitation has already been accepted.');
                return;
            }
            if (inv.status === 'declined') {
                setError('This invitation has been declined.');
                return;
            }
            if (inv.status === 'expired' || new Date(inv.expires_at) < new Date()) {
                setError('This invitation has expired. Please ask the project owner to send a new one.');
                return;
            }

            // Check email match immediately so the user knows before clicking Accept
            if (user.email?.toLowerCase() !== inv.email.toLowerCase()) {
                setError(
                    `This invitation was sent to ${inv.email}. Please sign in with that email address.`
                );
                return;
            }

            // Fetch project name
            const { data: project } = await supabase
                .from('projects')
                .select('name')
                .eq('id', inv.project_id)
                .single();

            // Fetch inviter name (best-effort). Scoped to this specific,
            // already-verified invitation row via a SECURITY DEFINER RPC --
            // profiles has no general read-by-id policy for non-collaborators,
            // see supabase/migrations/20260807120000_enable_profiles_rls.sql
            let inviterName: string | undefined;
            if (inv.invited_by) {
                const { data: inviterRows } = await supabase
                    .rpc('get_inviter_display_name', { p_invite_id: inv.id });
                const inviterProfile = inviterRows?.[0];
                inviterName = inviterProfile?.full_name || inviterProfile?.email;
            }

            setInvitation({
                id: inv.id,
                project_id: inv.project_id,
                project_name: project?.name || 'Unknown Project',
                email: inv.email,
                inviter_name: inviterName,
                status: inv.status,
                expires_at: inv.expires_at,
            });
        } catch (err) {
            console.error('Error loading project invitation:', err);
            setError('Failed to load invitation. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleAccept = async () => {
        if (!invitation) return;
        setAccepting(true);
        try {
            const { data, error: rpcErr } = await supabase
                .rpc('accept_project_invitation', { p_token: token });

            if (rpcErr) throw rpcErr;

            if (!data?.success) {
                toast.error(data?.error || 'Failed to accept invitation');
                return;
            }

            const acceptedProjectId = data?.project_id || invitation.project_id;
            const { data: project } = await supabase
                .from('projects')
                .select('organization_id')
                .eq('id', acceptedProjectId)
                .maybeSingle();

            if (project?.organization_id) {
                // Re-fetch the accessible-workspaces list, not just set the id --
                // same bug as workspace creation (CreateWorkspaceDialog.tsx):
                // a bare setCurrentOrganizationId resolves to no active
                // workspace since this org isn't in the cached list yet.
                await refreshOrganization(currentUser, project.organization_id);
            }

            setDone(true);
            toast.success(`You now have access to "${invitation.project_name}"!`);
        } catch (err: any) {
            console.error('Error accepting project invitation:', err);
            toast.error(err.message || 'Failed to accept invitation. Please try again.');
        } finally {
            setAccepting(false);
        }
    };

    const handleDecline = async () => {
        if (!invitation) return;
        try {
            await supabase
                .from('project_invitations')
                .update({ status: 'declined' })
                .eq('id', invitation.id);
            toast.info('Invitation declined.');
            navigate('/dashboard');
        } catch {
            toast.error('Failed to decline invitation.');
        }
    };

    // ── Loading state ─────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    // ── Error state ───────────────────────────────────────────────────────────
    if (error) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="max-w-md w-full">
                    <CardHeader className="text-center pb-2">
                        <XCircle className="h-10 w-10 text-destructive mx-auto mb-2" />
                        <CardTitle className="text-lg">Invitation Unavailable</CardTitle>
                    </CardHeader>
                    <CardContent className="text-center space-y-4">
                        <p className="text-sm text-muted-foreground">{error}</p>
                        <Button onClick={() => navigate('/dashboard')} variant="outline" className="w-full">
                            Go to Dashboard
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // ── Success / accepted state ──────────────────────────────────────────────
    if (done && invitation) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="max-w-md w-full">
                    <CardHeader className="text-center pb-2">
                        <CheckCircle className="h-10 w-10 text-emerald-500 mx-auto mb-2" />
                        <CardTitle className="text-lg">You're in!</CardTitle>
                    </CardHeader>
                    <CardContent className="text-center space-y-4">
                        <p className="text-sm text-muted-foreground">
                            You now have access to <strong>{invitation.project_name}</strong>.
                        </p>
                        <Button
                            onClick={() => navigate(`/project/${invitation.project_id}`)}
                            className="w-full"
                        >
                            <FolderOpen className="h-4 w-4 mr-2" />
                            Open Project
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // ── Main invite card ──────────────────────────────────────────────────────
    if (!invitation) return null;

    const expiresAt = new Date(invitation.expires_at);
    const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000));

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <Card className="max-w-md w-full">
                <CardHeader className="text-center pb-2">
                    <FolderOpen className="h-10 w-10 text-indigo-500 mx-auto mb-2" />
                    <CardTitle className="text-lg">Project Invitation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="text-center space-y-1.5">
                        <p className="text-sm text-muted-foreground">
                            {invitation.inviter_name
                                ? <><strong>{invitation.inviter_name}</strong> invited you to collaborate on</>
                                : 'You have been invited to collaborate on'
                            }
                        </p>
                        <p className="text-xl font-semibold">{invitation.project_name}</p>
                        <Badge variant="outline" className="text-xs gap-1">
                            <Clock className="h-2.5 w-2.5" />
                            Expires in {daysLeft} day{daysLeft !== 1 ? 's' : ''}
                        </Badge>
                    </div>

                    <div className="text-center">
                        <p className="text-xs text-muted-foreground">
                            Signed in as <span className="font-medium">{currentUserEmail}</span>
                        </p>
                    </div>

                    <div className="flex gap-2">
                        <Button
                            onClick={handleAccept}
                            disabled={accepting}
                            className="flex-1"
                        >
                            {accepting
                                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Accepting…</>
                                : 'Accept Invitation'
                            }
                        </Button>
                        <Button
                            onClick={handleDecline}
                            variant="outline"
                            disabled={accepting}
                            className="flex-1"
                        >
                            Decline
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
