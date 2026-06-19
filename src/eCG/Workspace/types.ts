/**
 * Workspace Types
 * Core type definitions for workspace state management
 */

export interface WorkspaceFile {
    path: string;
    content: string;
    isDirty: boolean;
    lastModified: Date;
    type: 'tsx' | 'ts' | 'css' | 'html' | 'json' | 'js' | 'other';
}

export interface FileChange {
    id: string;
    timestamp: Date;
    path: string;
    type: 'create' | 'modify' | 'delete';
    previousContent?: string;
    newContent?: string;
    source: 'user' | 'ai';
}

export interface WorkspaceState {
    projectId: string;
    files: Map<string, WorkspaceFile>;
    history: FileChange[];
    isLoading: boolean;
    lastSyncedAt: Date | null;
}

export interface WorkspaceActions {
    // File operations
    readFile: (path: string) => string | null;
    writeFile: (path: string, content: string, source?: 'user' | 'ai') => void;
    modifyFile: (path: string, modifications: FileModification[], source?: 'user' | 'ai') => void;
    deleteFile: (path: string, source?: 'user' | 'ai') => void;
    listFiles: () => WorkspaceFile[];

    // Bulk operations
    setFiles: (files: Array<{ path: string; content: string }>) => void;

    // History
    undo: () => boolean;
    redo: () => boolean;
    getHistory: () => FileChange[];

    // Sync
    saveToDatabase: () => Promise<void>;
    loadFromDatabase: () => Promise<void>;
}

export interface FileModification {
    type: 'insert' | 'replace' | 'delete';
    startLine?: number;
    endLine?: number;
    content?: string;
    search?: string;
    replace?: string;
}

export type WorkspaceContextType = WorkspaceState & WorkspaceActions;
