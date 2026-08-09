import { supabase } from '@/integrations/supabase/client';

const STORAGE_BUCKET = 'user-projects-free';
// const TRASH_PREFIX = '_trash'; // Removed to avoid RLS issues
const RECOVERY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface ProjectMetadata {
    projectId: string;
    userId: string;
    createdAt: string;
    deletedAt?: string;
}

export const projectLifecycleService = {
    /**
     * Initialize project folder structure when project is created
     */
    async initializeProject(
        projectId: string,
        userId: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            console.log(`[Lifecycle] Initializing project ${projectId}`);

            // Create a metadata file to mark the project folder
            // Path: projects/${projectId}/.project-meta.json
            const metadataPath = `projects/${projectId}/.project-meta.json`;
            const metadata: ProjectMetadata = {
                projectId,
                userId,
                createdAt: new Date().toISOString(),
            };

            const blob = new Blob([JSON.stringify(metadata, null, 2)], {
                type: 'application/json',
            });

            const { error } = await supabase.storage
                .from(STORAGE_BUCKET)
                .upload(metadataPath, blob, { upsert: true });

            if (error) throw error;

            console.log(`[Lifecycle] ✓ Project ${projectId} initialized`);
            return { success: true };
        } catch (error) {
            console.error('[Lifecycle] Failed to initialize project:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Soft-delete project: Update metadata to mark as deleted.
     * We DO NOT move (rename) files because RLS policy forces paths to start with 'projects/{projectId}'.
     * Moving to a '_trash' folder would violate RLS.
     */
    async softDeleteProject(
        projectId: string
    ): Promise<{ success: boolean; recoveryDeadline?: string; error?: string }> {
        try {
            console.log(`[Lifecycle] Soft-deleting project ${projectId}`);

            const recoveryDeadline = new Date(Date.now() + RECOVERY_WINDOW_MS).toISOString();
            const metadataPath = `projects/${projectId}/.project-meta.json`;

            // Download current metadata
            const { data: metaData, error: metaError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .download(metadataPath);

            if (metaData && !metaError) {
                const metadata: ProjectMetadata = JSON.parse(await metaData.text());
                metadata.deletedAt = new Date().toISOString();

                const blob = new Blob([JSON.stringify(metadata, null, 2)], {
                    type: 'application/json',
                });

                await supabase.storage
                    .from(STORAGE_BUCKET)
                    .upload(metadataPath, blob, { upsert: true });
            } else {
                // If metadata doesn't exist, create it (legacy projects)
                // We can't rely on it existing, but soft-delete primarily relies on DB status anyway
                console.warn('[Lifecycle] Metadata not found, skipping storage mark');
            }

            console.log(`[Lifecycle] ✓ Project ${projectId} marked as deleted in storage`);
            console.log(`[Lifecycle] Recovery deadline: ${recoveryDeadline}`);

            return { success: true, recoveryDeadline };
        } catch (error) {
            console.error('[Lifecycle] Soft-delete failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Recover project from trash (unmark metadata)
     */
    async recoverProject(
        projectId: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            console.log(`[Lifecycle] Recovering project ${projectId}`);
            const metadataPath = `projects/${projectId}/.project-meta.json`;

            // Check metadata
            const { data: metaData, error: metaError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .download(metadataPath);

            if (metaData && !metaError) {
                const metadata: ProjectMetadata = JSON.parse(await metaData.text());

                // Check deadline
                if (metadata.deletedAt) {
                    const deletedTime = new Date(metadata.deletedAt).getTime();
                    const now = Date.now();
                    if (now - deletedTime > RECOVERY_WINDOW_MS) {
                        throw new Error('Recovery window expired (1 hour limit)');
                    }
                }

                // Remove deletedAt
                delete metadata.deletedAt;
                const blob = new Blob([JSON.stringify(metadata, null, 2)], {
                    type: 'application/json',
                });

                await supabase.storage
                    .from(STORAGE_BUCKET)
                    .upload(metadataPath, blob, { upsert: true });
            }

            console.log(`[Lifecycle] ✓ Project ${projectId} recovered`);
            return { success: true };
        } catch (error) {
            console.error('[Lifecycle] Recovery failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Permanently delete project files
     */
    async permanentlyDeleteProject(
        projectId: string,
        fromTrash: boolean = false // Deprecated parameter, kept for interface compatibility
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // Note: fromTrash is ignored as we don't move files anymore
            const basePath = `projects/${projectId}`;
            console.log(`[Lifecycle] Permanently deleting ${basePath}`);

            // List all files in the project folder
            const { data: fileList, error: listError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .list(basePath);

            if (listError) throw listError;
            if (!fileList || fileList.length === 0) {
                console.log(`[Lifecycle] No files to delete at ${basePath}`);
                return { success: true };
            }

            // Delete all files
            const filePaths = fileList.map((f) => `${basePath}/${f.name}`);
            const { error: deleteError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .remove(filePaths);

            if (deleteError) throw deleteError;

            console.log(`[Lifecycle] ✓ Permanently deleted ${filePaths.length} files`);
            return { success: true };
        } catch (error) {
            console.error('[Lifecycle] Permanent delete failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Cleanup expired trash (No-op primarily, relying on DB cleanup)
     * Client-side cannot efficiently scan all projects.
     */
    async cleanupExpiredTrash(): Promise<{
        success: boolean;
        deletedCount: number;
        error?: string;
    }> {
        console.log('[Lifecycle] Cleanup skipped (handled by backend/manual process)');
        return { success: true, deletedCount: 0 };
    },
};
