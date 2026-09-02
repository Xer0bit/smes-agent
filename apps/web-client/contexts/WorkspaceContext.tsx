/**
 * Workspace Context
 * React context providing workspace access to all components
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { WorkspaceManager, getWorkspaceManager } from '../eCG/Workspace/WorkspaceManager';
import type { WorkspaceFile, FileChange, FileModification, WorkspaceContextType } from '../eCG/Workspace/types';
import { supabase } from '@/integrations/supabase/client';
import type { GeneratedFile } from '@/types/shared';

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

// The head can move under a save repeatedly, not just once -- an active agent
// run creates a burst of revisions in quick succession, and a single
// rebase-then-retry loses that race every time (confirmed live 2026-08-19,
// project dfe41091: a browser tab's autosave and a concurrent agent run
// traded stale_parent rejections back and forth until the save just gave up).
// Bounded retry with a short backoff gives a save a real chance to land once
// the burst quiets down, instead of failing outright the moment two writers
// overlap. Pulled out of saveToDatabase so it's unit-testable without a full
// React/Supabase harness.
export async function retryOnStaleParent<T>(
  attemptSave: () => Promise<T>,
  isStaleParentError: (err: unknown) => boolean,
  rebase: () => Promise<void>,
  options: { maxRetries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const backoffMs = options.backoffMs ?? 200;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  for (;;) {
    try {
      return await attemptSave();
    } catch (err) {
      if (!isStaleParentError(err) || attempt >= maxRetries) throw err;
      attempt += 1;
      console.warn(`[WorkspaceContext] Save rejected as stale   rebasing onto new head (attempt ${attempt}/${maxRetries})`);
      await rebase();
      await sleep(backoffMs * attempt);
    }
  }
}

interface WorkspaceProviderProps {
    projectId: string;
    initialFiles?: Array<{ path: string; content: string }>;
    children: React.ReactNode;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
    projectId,
    initialFiles,
    children,
}) => {
    const [manager] = useState(() => getWorkspaceManager(projectId));
    const [files, setFiles] = useState<Map<string, WorkspaceFile>>(new Map());
    const [history, setHistory] = useState<FileChange[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

    // Subscribe to workspace changes   stable, runs once per manager instance
    useEffect(() => {
        const unsubscribe = manager.subscribe((state) => {
            setFiles(new Map(state.files));
            setHistory([...state.history]);
        });
        return unsubscribe;
    }, [manager]);

    // Seed initial files once on mount (separate from subscription so the
    // subscription is not recreated if a caller passes a new array reference)
    useEffect(() => {
        if (initialFiles && initialFiles.length > 0) {
            manager.setFiles(initialFiles);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manager]); // intentionally omit initialFiles   only seed on mount

    // File operations
    const readFile = useCallback((path: string): string | null => {
        return manager.readFile(path);
    }, [manager]);

    const writeFile = useCallback((path: string, content: string, source: 'user' | 'ai' = 'user'): void => {
        manager.writeFile(path, content, source);
    }, [manager]);

    const modifyFile = useCallback((path: string, modifications: FileModification[], source: 'user' | 'ai' = 'user'): void => {
        manager.modifyFile(path, modifications, source);
    }, [manager]);

    const deleteFile = useCallback((path: string, source: 'user' | 'ai' = 'user'): void => {
        manager.deleteFile(path, source);
    }, [manager]);

    const listFiles = useCallback((): WorkspaceFile[] => {
        return manager.listFiles();
    }, [manager]);

    const setFilesAction = useCallback((newFiles: Array<{ path: string; content: string }>): void => {
        manager.setFiles(newFiles);
    }, [manager]);

    // History operations
    const undo = useCallback((): boolean => {
        return manager.undo();
    }, [manager]);

    const redo = useCallback((): boolean => {
        return manager.redo();
    }, [manager]);

    const getHistory = useCallback((): FileChange[] => {
        return manager.getHistory();
    }, [manager]);

    // M1 (agent-v2-architecture.md): the revision id this tab's workspace is
    // based on. Set on load and after every successful save; compared by the
    // create_revision_checked RPC so a stale tab can no longer republish old
    // content over newer work (the 2026-08-16 05:27 clobber incident).
    const baseRevisionIdRef = React.useRef<string | null>(null);
    const setBaseRevisionId = useCallback((id: string | null) => {
        baseRevisionIdRef.current = id;
    }, []);

    const fetchHeadRevisionId = useCallback(async (): Promise<string | null> => {
        const { data } = await supabase
            .from('revisions')
            .select('id')
            .eq('project_id', projectId)
            .order('created_at', { ascending: false })
            .limit(1);
        return data?.[0]?.id ?? null;
    }, [projectId]);

    // Persistence operations
    const saveToDatabase = useCallback(async (pendingLazyPaths?: Set<string>): Promise<void> => {
        // Dirty-file-only save (M1). This used to serialize the tab's ENTIRE
        // workspace map -- so any trigger (a keystroke, a stream-rejoin
        // completing) republished a full, possibly stale snapshot as the
        // newest revision. Now: only user-edited files upload; every other
        // current path is carried by manifest reference from the head, so its
        // content comes from the head revision, not this tab's memory.
        const { selectDirtySave } = await import('@/services/dirtySave');
        const { dirtyFiles, carryPaths } = selectDirtySave(manager.listFiles(), pendingLazyPaths);

        if (dirtyFiles.length === 0) {
            // Nothing user-authored to persist. Agent output arrives clean
            // (already persisted server-side), so post-run auto-saves land
            // here and correctly become no-ops instead of duplicate
            // "Auto-saved workspace changes" revisions.
            console.log('[WorkspaceContext] Save skipped   no dirty files');
            return;
        }

        // Clobber guard: never auto-save a revision drastically smaller than the
        // current head. A crash or interrupted load can leave the workspace with
        // only a file or two and empty carry paths; without this, that partial
        // state saves as the new head and effectively wipes the project (observed
        // on CardPro 2026-08-31: a post-crash auto-save collapsed 193 files to 2,
        // and each later save carried from that bad head, cascading). Legitimate
        // edits and deletions never approach a >50% shrink, so this only blocks
        // the corruption case; on any doubt it proceeds (fail-open).
        const projectedCount = dirtyFiles.length + carryPaths.size;
        try {
            const { data: headRev } = await supabase
                .from('revisions')
                .select('generated_files')
                .eq('project_id', projectId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            const gf: any = headRev?.generated_files;
            const headCount = Array.isArray(gf?.files) ? gf.files.length : 0;
            if (headCount >= 20 && projectedCount < headCount * 0.5) {
                console.warn(`[WorkspaceContext] Auto-save BLOCKED (clobber guard): would shrink head ${headCount} -> ${projectedCount} files. Partial workspace, likely after an interrupted load/crash -- not overwriting head. Reload the project to recover the full file set.`);
                return;
            }
        } catch (guardErr) {
            console.warn('[WorkspaceContext] clobber-guard head-count check failed (non-fatal, proceeding):', guardErr);
        }

        setIsLoading(true);
        try {
            const filesList = dirtyFiles;
            const stripNull = (s: string) => s.replace(/\u0000/g, '');
            const filesData: GeneratedFile[] = filesList.map(f => ({
                path: f.path,
                content: stripNull(f.content),
                type: f.path.split('.').pop() || 'other',
                operation: 'create',
            }));

            // Get current user for revision creation
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                throw new Error('User not authenticated');
            }

            // Persist via revisionService.createRevision   the same manifest-aware
            // (Storage upload + lean-manifest-row) path the agent loop uses. This
            // used to hand-roll its own upload to a dead flat path
            // (projects/{id}/files/{path}, read by nothing) and then raw-UPDATE
            // the existing latest revision's generated_files with full inline
            // content, bypassing the manifest system entirely   which is exactly
            // why the SAME revision row kept re-inflating to tens of MB every
            // time a workspace save fired, no matter how many times it was
            // repaired (found 2026-07-22, revision 870367e0 on project CardPro,
            // three separate occurrences with created_at never changing since
            // it was always an UPDATE, never a new INSERT).
            const { revisionService, isStaleParentError } = await import('@/services/revisionService');

            const attemptSave = () => revisionService.createRevision({
                project_id: projectId,
                prompt: 'Auto-saved workspace changes',
                generated_code: '',
                generated_files: { files: filesData },
                user_id: user.id,
                carry_paths: carryPaths,
                expected_parent_id: baseRevisionIdRef.current,
            });

            // Only this tab's dirty files ride any retry -- everything else is
            // carried by reference from the NEW head's manifest each time, so
            // concurrent work from another writer is preserved, not clobbered.
            const newRevisionId = await retryOnStaleParent(
                attemptSave,
                isStaleParentError,
                async () => { baseRevisionIdRef.current = await fetchHeadRevisionId(); },
            );
            baseRevisionIdRef.current = newRevisionId;

            // Also update project's latest_generated_code for backwards compatibility
            await supabase
                .from('projects')
                .update({
                    latest_generated_code: JSON.stringify(filesData),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', projectId);

            manager.markAllClean();
            setLastSyncedAt(new Date());
            console.log('[WorkspaceContext] Saved to database (revisions table)');
        } catch (error) {
            console.error('[WorkspaceContext] Save failed:', error);
            throw error;
        } finally {
            setIsLoading(false);
        }
    }, [manager, projectId, fetchHeadRevisionId]);

    const loadFromDatabase = useCallback(async (): Promise<boolean> => {
        setIsLoading(true);
        try {
            // ── Latest revision FIRST ──────────────────────────────────────────
            // Real bug (2026-07-21): every agent edit creates a new revision and
            // uploads changed files to a REVISION-SCOPED path
            // (projects/{id}/{revisionId}/{path}, via revisionService.createRevision
            // -> storageService.saveProjectFiles). The code below this block reads
            // a flat, non-revision-scoped path (projects/{id}/files/{path}) that
            // NOTHING currently writing keeps updated   it only ever gets
            // populated once, by the one-time legacy-migration fallback further
            // down. Once that migration ran once, this function found a
            // non-empty flat path forever after and used it, ignoring every
            // subsequent revision. Users saw their latest change in the live
            // preview (which reads the real files on the gen-server) but an old,
            // frozen snapshot on every page refresh (which read this path).
            // Fix: resolve the actual latest revision's manifest first; the flat
            // path is now only a last-resort fallback for a project with zero
            // revisions at all.
            try {
                // Newest READABLE revision, not merely the newest row: an
                // interrupted or legacy write leaves a row whose manifest is
                // null, and treating that as "no revisions" dropped the client
                // to the flat legacy store and a frozen snapshot. Mirrors the
                // server's pickReadableHead so both agree on what HEAD is.
                const { revisionService: revSvc } = await import('@/services/revisionService');
                const readable = await revSvc.getLatestReadableRevision(projectId);
                const latestRevisionId = readable?.id;
                if (latestRevisionId) {
                    baseRevisionIdRef.current = latestRevisionId; // M1: this tab now bases on head
                    const { revisionService } = await import('@/services/revisionService');
                    const revisionFiles = await revisionService.getRevisionFiles(projectId, latestRevisionId);
                    if (revisionFiles.length > 0) {
                        console.log(`[WorkspaceContext] Loaded ${revisionFiles.length} files from latest revision ${latestRevisionId}.`);
                        manager.setFiles(revisionFiles);
                        setLastSyncedAt(new Date());
                        setIsLoading(false);
                        return true;
                    }
                }
            } catch (revErr) {
                console.warn('[WorkspaceContext] Latest-revision load failed, falling back to legacy storage path:', revErr);
            }

            console.log('[WorkspaceContext] No usable revision found   falling back to legacy flat storage path (user-projects-free)...');

            // Recursive function to list all files in storage
            const loadFilesRecursively = async (basePath: string, relativePath: string = ''): Promise<{ path: string, content: string }[]> => {
                const fullPath = relativePath ? `${basePath}/${relativePath}` : basePath;
                const { data: items, error: listError } = await supabase
                    .storage
                    .from('user-projects-free')
                    .list(fullPath, {
                        limit: 500,
                        offset: 0,
                    });

                if (listError || !items) {
                    console.error(`[WorkspaceContext] Error listing ${fullPath}:`, listError);
                    return [];
                }

                const files: { path: string, content: string }[] = [];

                // Separate dirs and files so we can download files in parallel
                const dirItems = items.filter(item => item.id === null && item.name !== '.emptyFolderPlaceholder');
                const fileItems = items.filter(item => item.id !== null && item.name !== '.emptyFolderPlaceholder');

                // Recurse into sub-directories first
                for (const item of dirItems) {
                    const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
                    const subFiles = await loadFilesRecursively(basePath, itemRelativePath);
                    files.push(...subFiles);
                }

                // Download all files in this directory in parallel
                const downloadResults = await Promise.all(fileItems.map(async (item) => {
                    const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
                    const itemFullPath = `${basePath}/${itemRelativePath}`;

                    const { data: fileData, error: downloadError } = await supabase
                        .storage
                        .from('user-projects-free')
                        .download(itemFullPath);

                    if (downloadError) {
                        console.error(`[WorkspaceContext] Failed to download ${itemRelativePath}:`, downloadError);
                        return null;
                    }

                    if (fileData) {
                        const text = await fileData.text();
                        console.log(`[WorkspaceContext] ✓ Loaded: ${itemRelativePath}`);
                        return { path: itemRelativePath, content: text };
                    }
                    return null;
                }));

                files.push(...downloadResults.filter((f): f is { path: string; content: string } => f !== null));

                return files;
            };

            // Load all files recursively from projects/${projectId}/files
            const basePath = `projects/${projectId}/files`;
            const loadedFiles = await loadFilesRecursively(basePath);

            if (loadedFiles.length > 0) {
                console.log(`[WorkspaceContext] Successfully loaded ${loadedFiles.length} files from Storage.`);
                manager.setFiles(loadedFiles);
                setLastSyncedAt(new Date());
                setIsLoading(false);
                return true; // Success! Skip legacy methods
            } else {
                console.log('[WorkspaceContext] No files found in storage.');
            }

            // 2. Migration Fallback: If Storage is empty, check legacy revisions and migrate
            console.log('[WorkspaceContext] Storage empty. Checking for legacy data to migrate...');
            const { data: revisions } = await supabase
                .from('revisions')
                .select('generated_files')
                .eq('project_id', projectId)
                .order('created_at', { ascending: false })
                .limit(1);

            if (revisions && revisions.length > 0 && revisions[0].generated_files?.files) {
                type LegacyFile = { path: string; content: string };
                const legacyFiles: LegacyFile[] = (revisions[0].generated_files.files as LegacyFile[])
                    .filter((f): f is LegacyFile => typeof f?.path === 'string' && typeof f?.content === 'string')
                    .map((f) => ({ path: f.path, content: f.content }));

                // Perform migration: Upload all files to Storage (batched to avoid connection exhaustion)
                const BATCH_SIZE = 3;
                for (let i = 0; i < legacyFiles.length; i += BATCH_SIZE) {
                    const batch = legacyFiles.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(async (f: LegacyFile) => {
                        const { error: uploadError } = await supabase
                            .storage
                            .from('user-projects-free')
                            .upload(`projects/${projectId}/files/${f.path}`, f.content.replace(/\u0000/g, ''), {
                                upsert: true,
                                contentType: f.path.endsWith('.html') ? 'text/html' :
                                    f.path.endsWith('.css') ? 'text/css' :
                                        f.path.endsWith('.js') ? 'application/javascript' :
                                            f.path.endsWith('.json') ? 'application/json' : 'text/plain'
                            });

                        if (uploadError) {
                            console.error(`[WorkspaceContext] Migration upload failed for ${f.path}:`, uploadError);
                        }
                    }));
                }

                console.log('[WorkspaceContext] Migration complete. Using migrated files.');
                manager.setFiles(legacyFiles);
                setLastSyncedAt(new Date());
                return legacyFiles.length > 0;
            } else {
                console.log('[WorkspaceContext] No legacy data found. Project is clean.');
            }

            setLastSyncedAt(new Date());
            return false;
        } catch (error) {
            console.error('[WorkspaceContext] Load failed:', error);
            throw error;
        } finally {
            setIsLoading(false);
        }
    }, [manager, projectId]);

    // Memoize context value
    const contextValue = useMemo<WorkspaceContextType>(() => ({
        projectId,
        files,
        history,
        isLoading,
        lastSyncedAt,
        readFile,
        writeFile,
        modifyFile,
        deleteFile,
        listFiles,
        setFiles: setFilesAction,
        undo,
        redo,
        getHistory,
        saveToDatabase,
        loadFromDatabase,
        setBaseRevisionId,
    }), [
        projectId,
        files,
        history,
        isLoading,
        lastSyncedAt,
        readFile,
        writeFile,
        modifyFile,
        deleteFile,
        listFiles,
        setFilesAction,
        undo,
        redo,
        getHistory,
        saveToDatabase,
        loadFromDatabase,
        setBaseRevisionId,
    ]);

    return (
        <WorkspaceContext.Provider value={contextValue}>
            {children}
        </WorkspaceContext.Provider>
    );
};

export function useWorkspace(): WorkspaceContextType {
    const context = useContext(WorkspaceContext);
    if (!context) {
        throw new Error('useWorkspace must be used within a WorkspaceProvider');
    }
    return context;
}

export { WorkspaceContext };
