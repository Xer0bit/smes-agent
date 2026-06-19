/**
 * Storage Service for Project Files
 * Uses Supabase PRIVATE storage bucket: user-projects-free
 * All file access requires signed URLs (no public access)
 */

import { supabase } from '@/integrations/supabase/client';

export interface ProjectFile {
    path: string;
    content: string;
}

const STORAGE_BUCKET = 'user-projects-free'; // PRIVATE bucket

export const storageService = {
    /**
     * Save project files to Supabase storage
     * Files are stored under: {projectId}/{revisionId}/{filename}
     */
    async saveProjectFiles(
        projectId: string,
        revisionId: string,
        files: ProjectFile[]
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const BATCH_SIZE = 5; // upload 5 files concurrently
            const errors: string[] = [];

            for (let i = 0; i < files.length; i += BATCH_SIZE) {
                const batch = files.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (file) => {
                    const filePath = `projects/${projectId}/${revisionId}/${file.path}`;
                    const blob = new Blob([file.content], { type: 'text/plain' });

                    const { error } = await supabase.storage
                        .from(STORAGE_BUCKET)
                        .upload(filePath, blob, {
                            contentType: this.getContentType(file.path),
                            upsert: true,
                        });

                    if (error) {
                        errors.push(`${file.path}: ${error.message}`);
                    }
                }));
            }

            if (errors.length > 0) {
                return { success: false, error: `Failed uploads: ${errors.join('; ')}` };
            }

            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Load project files from Supabase storage
     */
    async loadProjectFiles(
        projectId: string,
        revisionId: string
    ): Promise<{ files: ProjectFile[]; error?: string }> {
        try {
            console.log(`[Storage] Loading files for project ${projectId}, revision ${revisionId}`);

            const files: ProjectFile[] = [];

            // Recursive helper to list and download files
            const fetchDir = async (dirPath: string) => {
                const { data: list, error: listError } = await supabase.storage
                    .from(STORAGE_BUCKET)
                    .list(dirPath);

                if (listError) throw listError;

                for (const item of list || []) {
                    const fullPath = `${dirPath}/${item.name}`;

                    if (!item.id) {
                        // Directory - recurse
                        await fetchDir(fullPath);
                    } else if (item.name !== '.emptyFolderPlaceholder') {
                        // File - download
                        // Calculate relative path from the revision root
                        // fullPath is projects/{projectId}/{revisionId}/src/App.tsx
                        // we want src/App.tsx
                        const rootPrefix = `projects/${projectId}/${revisionId}/`;
                        const relativePath = fullPath.replace(rootPrefix, '');

                        const { data, error: downloadError } = await supabase.storage
                            .from(STORAGE_BUCKET)
                            .download(fullPath);

                        if (downloadError) {
                            console.error(`[Storage] Failed to download ${fullPath}:`, downloadError);
                            continue;
                        }

                        const content = await data.text();
                        files.push({
                            path: relativePath,
                            content,
                        });

                        if (import.meta.env.DEV) {
                            console.log(`[Storage] ✓ Downloaded ${relativePath}`);
                        }
                    }
                }
            };

            await fetchDir(`projects/${projectId}/${revisionId}`);

            return { files };
        } catch (error) {
            console.error('[Storage] Load failed:', error);
            return {
                files: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Get signed URL for a file (private bucket - expires in 1 hour)
     * This is the ONLY way to access files since the bucket is private
     */
    async getSignedUrl(
        projectId: string,
        revisionId: string,
        filename: string,
        expiresIn: number = 3600 // Default 1 hour
    ): Promise<string | null> {
        try {
            const filePath = `projects/${projectId}/${revisionId}/${filename}`;

            const { data, error } = await supabase.storage
                .from(STORAGE_BUCKET)
                .createSignedUrl(filePath, expiresIn);

            if (error) throw error;
            return data.signedUrl;
        } catch (error) {
            console.error('[Storage] Failed to get signed URL:', error);
            return null;
        }
    },

    /**
     * Get signed URLs for all files in a revision (for preview)
     * Returns a map of filename -> signed URL
     */
    async getRevisionSignedUrls(
        projectId: string,
        revisionId: string,
        expiresIn: number = 3600
    ): Promise<Record<string, string>> {
        try {
            // List all files
            const { data: fileList, error: listError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .list(`projects/${projectId}/${revisionId}`);

            if (listError) throw listError;
            if (!fileList || fileList.length === 0) {
                return {};
            }

            // Generate signed URL for each file
            const urls: Record<string, string> = {};
            for (const fileInfo of fileList) {
                const url = await this.getSignedUrl(projectId, revisionId, fileInfo.name, expiresIn);
                if (url) {
                    urls[fileInfo.name] = url;
                }
            }

            return urls;
        } catch (error) {
            console.error('[Storage] Failed to get revision URLs:', error);
            return {};
        }
    },

    /**
     * Delete all files for a revision
     */
    async deleteRevisionFiles(
        projectId: string,
        revisionId: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            console.log(`[Storage] Deleting files for revision ${revisionId}`);

            // List files first
            const { data: fileList, error: listError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .list(`projects/${projectId}/${revisionId}`);

            if (listError) throw listError;
            if (!fileList || fileList.length === 0) {
                return { success: true };
            }

            // Delete all files
            const filePaths = fileList.map(f => `projects/${projectId}/${revisionId}/${f.name}`);
            const { error: deleteError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .remove(filePaths);

            if (deleteError) throw deleteError;

            console.log(`[Storage] ✓ Deleted ${filePaths.length} files`);
            return { success: true };
        } catch (error) {
            console.error('[Storage] Delete failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Delete all files for a project
     */
    async deleteProjectFiles(
        projectId: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            console.log(`[Storage] Deleting all files for project ${projectId}`);

            // List all revisions (folders)
            const { data: revisionList, error: listError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .list(`projects/${projectId}`);

            if (listError) throw listError;
            if (!revisionList || revisionList.length === 0) {
                return { success: true };
            }

            // Delete each revision
            for (const revision of revisionList) {
                await this.deleteRevisionFiles(projectId, revision.name);
            }

            console.log(`[Storage] ✓ Deleted all files for project ${projectId}`);
            return { success: true };
        } catch (error) {
            console.error('[Storage] Delete project failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },

    /**
     * Get content type based on file extension
     */
    getContentType(filename: string): string {
        const ext = filename.split('.').pop()?.toLowerCase();
        const contentTypes: Record<string, string> = {
            'html': 'text/html',
            'css': 'text/css',
            'js': 'application/javascript',
            'jsx': 'application/javascript',
            'ts': 'application/typescript',
            'tsx': 'application/typescript',
            'json': 'application/json',
            'md': 'text/markdown',
            'txt': 'text/plain',
            'svg': 'image/svg+xml',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
        };
        return contentTypes[ext || ''] || 'text/plain';
    },
};
