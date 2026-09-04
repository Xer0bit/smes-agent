import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { User, Loader2 } from 'lucide-react';
import SmesLoader from '@/components/SmesLoader';
import { toast } from 'sonner';

type OrgMember = {
    id: string;
    user_id: string;
    role: string;
    profiles: {
        email: string;
        full_name?: string;
    };
};

type ProjectAccess = {
    id: string;
    user_id: string;
};

interface ProjectMemberAccessProps {
    projectId: string;
    organizationId: string;
}

export function ProjectMemberAccess({ projectId, organizationId }: ProjectMemberAccessProps) {
    const [members, setMembers] = useState<OrgMember[]>([]);
    const [accessList, setAccessList] = useState<ProjectAccess[]>([]);
    const [loading, setLoading] = useState(true);
    const [toggling, setToggling] = useState<string | null>(null);

    useEffect(() => {
        loadData();
    }, [projectId, organizationId]);

    const loadData = async () => {
        try {
            setLoading(true);

            // Fetch org members with role 'member' only (admins already have full access)
            // org_members.user_id has no FK to public.profiles (it references auth.users),
            // so PostgREST can't resolve an embedded profiles:user_id(...) join   fetch separately.
            const { data: membersData, error: membersError } = await supabase
                .from('org_members')
                .select('id, user_id, role')
                .eq('org_id', organizationId)
                .eq('role', 'member');

            if (membersError) throw membersError;

            const memberUserIds = (membersData || []).map(m => m.user_id);
            const { data: profilesData } = memberUserIds.length
                ? await supabase.from('profiles').select('id, email, full_name').in('id', memberUserIds)
                : { data: [] as { id: string; email: string; full_name?: string }[] };
            const profileMap = new Map<string, { email: string; full_name?: string }>(
                (profilesData || []).map((p): [string, { email: string; full_name?: string }] =>
                    [p.id, { email: p.email, full_name: p.full_name }])
            );

            // Fetch current project access assignments
            const { data: accessData, error: accessError } = await supabase
                .from('project_member_access')
                .select('id, user_id')
                .eq('project_id', projectId);

            if (accessError) throw accessError;

            setMembers((membersData || []).map((m) => ({
                ...m,
                profiles: profileMap.get(m.user_id) || { email: '', full_name: undefined },
            })));
            setAccessList(accessData || []);
        } catch (err) {
            console.error('Failed to load project member access:', err);
            toast.error('Failed to load member access data');
        } finally {
            setLoading(false);
        }
    };

    const hasAccess = (userId: string) => {
        return accessList.some(a => a.user_id === userId);
    };

    const handleToggleAccess = async (userId: string, currentlyHasAccess: boolean) => {
        try {
            setToggling(userId);

            // getUser() re-validates the token against Supabase's auth server on every
            // call   on the admin app (long-lived tabs, infrequent interaction) this
            // occasionally raced with token refresh and spuriously reported "not
            // authenticated" even though the session was genuinely still valid.
            // getSession() reads the already-verified local session instead (same
            // source AdminApp's own mount-time gate uses), avoiding that race.
            const { data: { session } } = await supabase.auth.getSession();
            const user = session?.user;
            if (!user) {
                toast.error('Your session has expired. Please refresh the page and sign in again.');
                return;
            }

            if (currentlyHasAccess) {
                // Revoke access
                const { error } = await supabase
                    .from('project_member_access')
                    .delete()
                    .eq('project_id', projectId)
                    .eq('user_id', userId);

                if (error) throw error;

                setAccessList(prev => prev.filter(a => a.user_id !== userId));
                toast.success('Project access revoked');
            } else {
                // Grant access
                const { data, error } = await supabase
                    .from('project_member_access')
                    .insert({
                        project_id: projectId,
                        user_id: userId,
                        granted_by: user.id,
                    })
                    .select('id, user_id')
                    .single();

                if (error) throw error;

                setAccessList(prev => [...prev, data]);
                toast.success('Project access granted');
            }
        } catch (err) {
            console.error('Failed to toggle project access:', err);
            toast.error('Failed to update project access');
        } finally {
            setToggling(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <SmesLoader variant="bars" />
            </div>
        );
    }

    if (members.length === 0) {
        return (
            <div className="text-center py-8 text-muted-foreground">
                <User className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No members to assign.</p>
                <p className="text-xs mt-1">Invite members to your organization first.</p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium">Member Project Access</p>
                <Badge variant="outline" className="text-xs">
                    {accessList.length} / {members.length} assigned
                </Badge>
            </div>

            {members.map(member => {
                const memberHasAccess = hasAccess(member.user_id);
                const isToggling = toggling === member.user_id;

                return (
                    <div
                        key={member.id}
                        className="flex items-center justify-between py-2 px-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                    >
                        <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                                <User className="h-4 w-4 text-primary" />
                            </div>
                            <div>
                                <p className="text-sm font-medium">
                                    {member.profiles?.full_name || member.profiles?.email || 'Unknown'}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {member.profiles?.email}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {isToggling && <Loader2 className="h-3 w-3 animate-spin" />}
                            <Switch
                                checked={memberHasAccess}
                                onCheckedChange={() => handleToggleAccess(member.user_id, memberHasAccess)}
                                disabled={isToggling}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
