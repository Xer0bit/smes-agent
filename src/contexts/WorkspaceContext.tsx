/**
 * Workspace Context
 * React context providing workspace access to all components
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { WorkspaceManager, getWorkspaceManager } from '../eCG/Workspace/WorkspaceManager';
import type { WorkspaceFile, FileChange, FileModification, WorkspaceContextType } from '../eCG/Workspace/types';
import { supabase } from '@/integrations/supabase/client';

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

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

    // Subscribe to workspace changes — stable, runs once per manager instance
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
    }, [manager]); // intentionally omit initialFiles — only seed on mount

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

    // Persistence operations
    const saveToDatabase = useCallback(async (): Promise<void> => {
        setIsLoading(true);
        try {
            const filesList = manager.listFiles();
            const stripNull = (s: string) => s.replace(/\u0000/g, '');
            const filesData = filesList.map(f => ({
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

            // --- NEW: Save to Storage Bucket (Single Source of Truth) ---
            console.log(`[WorkspaceContext] Saving ${filesList.length} files to Storage...`);
            const BATCH_SIZE = 3; // upload 3 files at a time to avoid connection exhaustion
            const failedUploads: string[] = [];
            for (let i = 0; i < filesList.length; i += BATCH_SIZE) {
                const batch = filesList.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (f) => {
                    const { error: uploadError } = await supabase
                        .storage
                        .from('user-projects-free')
                        .upload(`projects/${projectId}/files/${f.path}`, stripNull(f.content), {
                            upsert: true,
                            contentType: f.path.endsWith('.html') ? 'text/html' :
                                f.path.endsWith('.css') ? 'text/css' :
                                    f.path.endsWith('.js') ? 'application/javascript' :
                                        f.path.endsWith('.json') ? 'application/json' : 'text/plain'
                        });

                    if (uploadError) {
                        console.error(`[WorkspaceContext] Failed to upload ${f.path}:`, uploadError);
                        failedUploads.push(f.path);
                    }
                }));
            }

            if (failedUploads.length > 0) {
                throw new Error(`Failed to upload ${failedUploads.length} file(s): ${failedUploads.join(', ')}`);
            }

            console.log('[WorkspaceContext] Files saved to Storage.');
            // -------------------------------------------------------------

            // Create or update revision with files
            const { data: latestRevision } = await supabase
                .from('revisions')
                .select('id')
                .eq('project_id', projectId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (latestRevision) {
                // Update existing latest revision
                const { error: updateError } = await supabase
                    .from('revisions')
                    .update({
                        generated_files: {
                            files: filesData,
                            summary: 'Auto-saved workspace changes',
                        },
                    })
                    .eq('id', latestRevision.id);

                if (updateError) throw updateError;
            } else {
                // Create new revision if none exists
                const { error: insertError } = await supabase
                    .from('revisions')
                    .insert({
                        project_id: projectId,
                        prompt: 'Initial workspace',
                        user_id: user.id,
                        generated_files: {
                            files: filesData,
                            summary: 'Auto-saved workspace',
                        },
                    });

                if (insertError) throw insertError;
            }

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
    }, [manager, projectId]);

    const loadFromDatabase = useCallback(async (): Promise<void> => {
        setIsLoading(true);
        try {
            console.log('[WorkspaceContext] Attempting to load files from Storage (user-projects-free)...');

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
                return; // Success! Skip legacy methods
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
            } else {
                console.log('[WorkspaceContext] No legacy data found. Project is clean.');
            }

            setLastSyncedAt(new Date());
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
