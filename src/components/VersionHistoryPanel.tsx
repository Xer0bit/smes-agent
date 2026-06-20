import { useState, useEffect, useCallback } from 'react';
import { History, RotateCcw, Loader2, FileText, Clock, AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { lovableCloud } from '@/integrations/supabase/client';
import { getGenServerUrl } from '@/config/external-api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Version {
  id: string;          // agent_runs.id
  prompt: string;
  summary: string | null;
  files_written: number;
  files_deleted: number;
  steps_taken: number;
  snapshot_id: string;
  created_at: string;
  /** True when the snapshot directory still exists on disk */
  available: boolean;
}

interface VersionHistoryPanelProps {
  projectId: string;
  /** Called after a successful restore so the editor can refresh its files */
  onRestored?: () => void;
  /** Called when the panel requests to be closed */
  onClose?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fullDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VersionHistoryPanel({ projectId, onRestored, onClose }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { data: { session } } = await lovableCloud.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const resp = await fetch(getGenServerUrl(`/api/v1/ai/versions/${projectId}`), {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Failed to load history' }));
        throw new Error(err.error ?? 'Failed to load history');
      }
      const data = await resp.json();
      setVersions(data.versions ?? []);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load version history');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const handleRestore = async (version: Version) => {
    if (confirming !== version.id) {
      // First click: ask for confirmation
      setConfirming(version.id);
      return;
    }

    // Second click: confirmed
    setConfirming(null);
    setRestoringId(version.id);
    try {
      const { data: { session } } = await lovableCloud.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const resp = await fetch(getGenServerUrl('/api/v1/ai/rollback'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ runId: version.id, projectId }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Restore failed' }));
        throw new Error(err.error ?? 'Restore failed');
      }

      toast.success('Project restored to this version. Preview is refreshing...');
      onRestored?.();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoringId(null);
    }
  };

  // Cancel confirmation if user clicks elsewhere
  const cancelConfirm = () => setConfirming(null);

  if (loading && versions.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading version history...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" onClick={confirming ? cancelConfirm : undefined}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4 text-muted-foreground" />
          Version History
          {versions.length > 0 && (
            <Badge variant="secondary" className="text-xs">{versions.length}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => loadVersions()} title="Refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Info banner */}
      <div className="px-4 py-2 bg-muted/40 border-b border-border text-xs text-muted-foreground shrink-0">
        Each version is a snapshot taken <strong>before</strong> an AI run — restoring it reverts all files to that point.
        The last {versions.length > 0 ? Math.min(20, versions.length) : 20} versions are kept.
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {versions.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground space-y-2">
              <History className="h-8 w-8 mx-auto opacity-30" />
              <p>No versions yet.</p>
              <p className="text-xs">Versions are created automatically before every AI generation.</p>
            </div>
          ) : (
            versions.map((v, index) => {
              const isRestoring = restoringId === v.id;
              const isConfirming = confirming === v.id;
              const versionNum = versions.length - index;

              return (
                <div
                  key={v.id}
                  className={`rounded-lg border p-3 transition-all ${
                    isConfirming
                      ? 'border-orange-400/70 bg-orange-50/10'
                      : 'border-border hover:border-border/80 hover:bg-muted/30'
                  }`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Top row: version number + time */}
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-primary">v{versionNum}</span>
                      {index === 0 && (
                        <Badge variant="secondary" className="text-[10px] py-0 px-1.5">Latest</Badge>
                      )}
                      {!v.available && (
                        <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground">
                          Snapshot pruned
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0" title={fullDate(v.created_at)}>
                      <Clock className="h-3 w-3" />
                      {timeAgo(v.created_at)}
                    </div>
                  </div>

                  {/* Summary / prompt */}
                  <p className="text-xs text-foreground/80 line-clamp-2 mb-2">
                    {v.summary || v.prompt}
                  </p>

                  {/* Stats row */}
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground mb-2.5">
                    {v.files_written > 0 && (
                      <span className="flex items-center gap-0.5">
                        <FileText className="h-3 w-3" />
                        {v.files_written} file{v.files_written !== 1 ? 's' : ''} written
                      </span>
                    )}
                    {v.files_deleted > 0 && (
                      <span className="text-red-400/80">{v.files_deleted} deleted</span>
                    )}
                  </div>

                  {/* Restore button */}
                  {isConfirming ? (
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                      <span className="text-xs text-orange-400 flex-1">
                        This will overwrite all current files. Confirm?
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs px-3"
                        onClick={(e) => { e.stopPropagation(); handleRestore(v); }}
                      >
                        Yes, restore
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-3"
                        onClick={(e) => { e.stopPropagation(); setConfirming(null); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs w-full gap-1.5"
                      disabled={isRestoring || !v.available || !!restoringId}
                      onClick={(e) => { e.stopPropagation(); handleRestore(v); }}
                      title={!v.available ? 'This snapshot has been pruned and cannot be restored' : `Restore project to v${versionNum}`}
                    >
                      {isRestoring ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Restoring...
                        </>
                      ) : v.available ? (
                        <>
                          <RotateCcw className="h-3 w-3" />
                          Restore to v{versionNum}
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="h-3 w-3 text-muted-foreground" />
                          Snapshot unavailable
                        </>
                      )}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>``
    </div>
  );
}
