import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { revisionService, type Revision } from '@/services/revisionService';
import { Button } from '@/components/ui/button';
import { Clock, GitBranch, ChevronUp, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';

interface GeneratedFile {
  path: string;
  content: string;
  type?: string;
}

interface RevisionPanelProps {
  projectId: string;
  onRevisionSelect: (filesOrCode: GeneratedFile[] | string, previewUrl: string | undefined, revisionId: string) => void;
  currentUserId: string;
  mode?: 'embedded' | 'full';
}

export function RevisionPanel({ projectId, onRevisionSelect, currentUserId, mode = 'embedded' }: RevisionPanelProps) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingRevisionId, setLoadingRevisionId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(mode === 'full');

  useEffect(() => {
    loadRevisions();
  }, [projectId]);

  useEffect(() => {
    const channel = supabase
      .channel(`revisions-${projectId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'revisions',
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          const newRev = payload.new as Revision;
          // Prepend new revision and keep unique by id
          setRevisions((prev) => {
            const exists = prev.some((r) => r.id === (newRev as any).id);
            return exists ? prev : [newRev, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  // Refresh when a new revision is created elsewhere
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      console.log('[RevisionPanel] Received revision:created event; reloading');
      loadRevisions();
    };
    window.addEventListener('revision:created', handler as EventListener);
    return () => window.removeEventListener('revision:created', handler as EventListener);
  }, [projectId]);

  // When expanded, fetch latest immediately
  useEffect(() => {
    if (isExpanded) loadRevisions();
  }, [isExpanded, projectId]);

  const loadRevisions = async () => {
    try {
      setLoading(true);
      console.log('[RevisionPanel] Loading revisions for project:', projectId);
      const data = await revisionService.getRevisions(projectId, 50, 0);
      console.log('[RevisionPanel] Loaded revisions:', data?.length || 0, 'revisions');
      setRevisions(data);
    } catch (error) {
      console.error('[RevisionPanel] Error loading revisions:', error);
      toast.error('Failed to load revisions from external database');
    } finally {
      setLoading(false);
    }
  };


  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className={mode === 'full' ? "h-full border border-border bg-card" : "border-t border-border bg-card"}>
      {/* Collapsed View - Single Row */}
      <div className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Revisions ({revisions.length})</span>
          {loading && <span className="text-xs text-muted-foreground">Refreshing…</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={loadRevisions}
          >
            Refresh
          </Button>
          {mode === 'embedded' && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </Button>
          )}
        </div>
      </div>

      {/* Expanded View - Covers Chat Area */}
      {isExpanded && (
        <div className="border-t border-border">
          <ScrollArea className={mode === 'full' ? "h-[calc(100vh-260px)]" : "h-[400px]"}>
            <div className="p-4 space-y-2">
              {loading && revisions.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  Loading revisions...
                </div>
              ) : revisions.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  No revisions yet. Generate some code to create your first revision!
                </div>
              ) : (
                revisions.map((rev) => (
                  <div
                    key={rev.id}
                    className="group text-sm p-3 border border-border rounded-lg cursor-pointer hover:bg-muted/50 hover:border-primary/50 transition-all"
                    onClick={async () => {
                      if (loadingRevisionId) return; // prevent double-click
                      console.log('[RevisionPanel] Loading revision:', rev.revision_number);
                      const previewUrl = (rev as any).preview_url;
                      setLoadingRevisionId(rev.id);
                      try {
                        const files = await revisionService.getRevisionFiles(projectId, rev.id);
                        if (files.length > 0) {
                          onRevisionSelect(files, previewUrl, rev.id);
                        } else {
                          // Absolute fallback: legacy generated_code string
                          console.warn('[RevisionPanel] No files found, falling back to generated_code');
                          const legacyCode = await revisionService.getLegacyGeneratedCode(rev.id);
                          onRevisionSelect(legacyCode, previewUrl, rev.id);
                        }
                        setIsExpanded(false);
                        toast.success(`Loaded revision #${rev.revision_number}`);
                      } catch (err) {
                        console.error('[RevisionPanel] Error loading revision files:', err);
                        toast.error('Failed to load revision files');
                      } finally {
                        setLoadingRevisionId(null);
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span className="font-medium text-primary">
                        {loadingRevisionId === rev.id ? 'Loading…' : `#${rev.revision_number}`}
                      </span>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(rev.created_at)}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 group-hover:text-foreground transition-colors">
                      {rev.summary || rev.prompt}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      {rev.is_published && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-500/10 text-green-500">
                          Published
                        </span>
                      )}
                      {rev.preview_url && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-blue-500/10 text-blue-500">
                          Preview Ready
                        </span>
                      )}
                      {!rev.preview_url && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-yellow-500/10 text-yellow-500">
                          No Preview
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
