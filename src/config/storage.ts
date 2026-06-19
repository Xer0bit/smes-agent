/**
 * Storage Configuration
 * Defines bucket names and paths for Supabase storage
 */

export const STORAGE_CONFIG = {
    // Main bucket for user project files
    PROJECTS_BUCKET: 'user-projects-free',

    // Path structure: {projectId}/{revisionId}/{filename}
    getRevisionPath: (projectId: string, revisionId: string, filename?: string) => {
        const base = `${projectId}/${revisionId}`;
        return filename ? `${base}/${filename}` : base;
    },

    // Get project path
    getProjectPath: (projectId: string) => projectId,

    // File types and their content types
    CONTENT_TYPES: {
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
        'webp': 'image/webp',
        'ico': 'image/x-icon',
    } as Record<string, string>,

    // Get content type from filename
    getContentType: (filename: string): string => {
        const ext = filename.split('.').pop()?.toLowerCase();
        return STORAGE_CONFIG.CONTENT_TYPES[ext || ''] || 'text/plain';
    },
};
