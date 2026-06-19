import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { User, Loader2 } from 'lucide-react';
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
            const { data: membersData, error: membersError } = await supabase
                .from('org_members')
                .select(`
          id,
          user_id,
          role,
          profiles:user_id (email, full_name)
        `)
                .eq('org_id', organizationId)
                .eq('role', 'member');

            if (membersError) throw membersError;

            // Fetch current project access assignments
            const { data: accessData, error: accessError } = await supabase
                .from('project_member_access')
                .select('id, user_id')
                .eq('project_id', projectId);

            if (accessError) throw accessError;

            setMembers((membersData || []).map((m: any) => ({
                ...m,
                profiles: Array.isArray(m.profiles) ? m.profiles[0] : m.profiles,
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

            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error('Not authenticated');

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
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading members...</span>
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
