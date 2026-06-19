import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Copy, ExternalLink, Globe, Link2, Settings } from 'lucide-react';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId: string;
    projectName?: string;
    previewUrl?: string | null;
    publishedUrl?: string | null;
    onManageCollaborators?: () => void;
}

export function ProjectShareDialog({
    open,
    onOpenChange,
    projectId,
    projectName,
    previewUrl,
    publishedUrl,
    onManageCollaborators,
}: Props) {
    const hasProject = Boolean(projectId);

    const copyLink = async (url: string, label: string) => {
        try {
            await navigator.clipboard.writeText(url);
            toast.success(`${label} copied`);
        } catch {
            toast.error('Failed to copy link');
        }
    };

    const shareTargets = [
        {
            id: 'preview',
            label: 'Preview link',
            description: 'Share the latest preview build.',
            url: previewUrl,
            Icon: Link2,
        },
        {
            id: 'published',
            label: 'Live site',
            description: 'Share your published URL once live.',
            url: publishedUrl,
            Icon: Globe,
        },
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <Link2 className="h-4 w-4" />
                        Share "{projectName || 'Project'}"
                    </DialogTitle>
                    <DialogDescription>
                        Share preview or live links. Collaborator access is managed from Settings.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    {shareTargets.map(({ id, label, description, url, Icon }) => (
                        <div key={id} className="rounded-lg border border-border p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <Icon className="h-4 w-4 text-muted-foreground" />
                                    <span>{label}</span>
                                </div>
                                <span className={`text-xs ${url ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                                    {url ? 'Ready' : 'Not available'}
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">{description}</p>
                            <Input
                                value={url || 'Not available yet'}
                                readOnly
                                className="h-9 text-xs"
                            />
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1"
                                    disabled={!url}
                                    onClick={() => url && copyLink(url, label)}
                                >
                                    <Copy className="h-3.5 w-3.5 mr-1.5" />
                                    Copy
                                </Button>
                                <Button
                                    size="sm"
                                    className="flex-1"
                                    disabled={!url}
                                    onClick={() => url && window.open(url, '_blank')}
                                >
                                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                                    Open
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>

                <Separator />

                <Button
                    variant="outline"
                    className="w-full"
                    disabled={!hasProject || !onManageCollaborators}
                    onClick={() => {
                        onOpenChange(false);
                        onManageCollaborators?.();
                    }}
                >
                    <Settings className="h-4 w-4 mr-2" />
                    Manage collaborators in Settings
                </Button>
            </DialogContent>
        </Dialog>
    );
}
