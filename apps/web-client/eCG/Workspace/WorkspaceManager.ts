/**
 * WorkspaceManager
 * Central state management for all workspace files
 * Provides file operations, history tracking, and persistence
 */

import type {
    WorkspaceFile,
    FileChange,
    WorkspaceState,
    FileModification
} from './types';

export class WorkspaceManager {
    private state: WorkspaceState;
    private undoStack: FileChange[] = [];
    private redoStack: FileChange[] = [];
    private listeners: Set<(state: WorkspaceState) => void> = new Set();

    constructor(projectId: string) {
        this.state = {
            projectId,
            files: new Map(),
            history: [],
            isLoading: false,
            lastSyncedAt: null,
        };
    }

    // ============================================
    // GETTERS
    // ============================================

    getState(): WorkspaceState {
        return { ...this.state, files: new Map(this.state.files) };
    }

    getFile(path: string): WorkspaceFile | null {
        return this.state.files.get(this.normalizePath(path)) || null;
    }

    readFile(path: string): string | null {
        const file = this.getFile(path);
        return file?.content || null;
    }

    listFiles(): WorkspaceFile[] {
        return Array.from(this.state.files.values());
    }

    getFilesByType(type: WorkspaceFile['type']): WorkspaceFile[] {
        return this.listFiles().filter(f => f.type === type);
    }

    // ============================================
    // FILE OPERATIONS
    // ============================================

    writeFile(path: string, content: string, source: 'user' | 'ai' = 'user'): void {
        const normalizedPath = this.normalizePath(path);
        const existingFile = this.state.files.get(normalizedPath);

        const change: FileChange = {
            id: this.generateId(),
            timestamp: new Date(),
            path: normalizedPath,
            type: existingFile ? 'modify' : 'create',
            previousContent: existingFile?.content,
            newContent: content,
            source,
        };

        const file: WorkspaceFile = {
            path: normalizedPath,
            content,
            // Dirty means "user-authored and not yet persisted". 'ai'-sourced
            // writes are agent output or revision loads -- both already
            // persisted server-side (the agent inserts its own revision; a
            // load IS the persisted state). Marking them dirty made every
            // agent run trigger an immediate client re-save of the same
            // content as a duplicate "Auto-saved workspace changes" revision,
            // and let an idle tab's rejoin republish a full stale snapshot
            // (the 2026-08-16 05:27 clobber incident).
            isDirty: source === 'user',
            lastModified: new Date(),
            type: this.getFileType(normalizedPath),
        };

        this.state.files.set(normalizedPath, file);
        this.addToHistory(change);
        this.notifyListeners();
    }

    modifyFile(path: string, modifications: FileModification[], source: 'user' | 'ai' = 'user'): void {
        const normalizedPath = this.normalizePath(path);
        const file = this.state.files.get(normalizedPath);

        if (!file) {
            console.error(`[WorkspaceManager] File not found: ${path}`);
            return;
        }

        let content = file.content;
        const lines = content.split('\n');

        // Apply modifications in reverse order to maintain line numbers
        const sortedMods = [...modifications].sort((a, b) =>
            (b.startLine || 0) - (a.startLine || 0)
        );

        for (const mod of sortedMods) {
            switch (mod.type) {
                case 'insert':
                    if (mod.startLine !== undefined && mod.content) {
                        lines.splice(mod.startLine, 0, mod.content);
                    }
                    break;
                case 'replace':
                    if (mod.search && mod.replace !== undefined) {
                        content = content.replace(mod.search, mod.replace);
                    } else if (mod.startLine !== undefined && mod.endLine !== undefined && mod.content) {
                        lines.splice(mod.startLine, mod.endLine - mod.startLine + 1, mod.content);
                    }
                    break;
                case 'delete':
                    if (mod.startLine !== undefined && mod.endLine !== undefined) {
                        lines.splice(mod.startLine, mod.endLine - mod.startLine + 1);
                    }
                    break;
            }
        }

        const newContent = content.includes('\n') ? content : lines.join('\n');
        this.writeFile(normalizedPath, newContent, source);
    }

    deleteFile(path: string, source: 'user' | 'ai' = 'user'): void {
        const normalizedPath = this.normalizePath(path);
        const existingFile = this.state.files.get(normalizedPath);

        if (!existingFile) {
            console.warn(`[WorkspaceManager] File not found for deletion: ${path}`);
            return;
        }

        const change: FileChange = {
            id: this.generateId(),
            timestamp: new Date(),
            path: normalizedPath,
            type: 'delete',
            previousContent: existingFile.content,
            source,
        };

        this.state.files.delete(normalizedPath);
        this.addToHistory(change);
        this.notifyListeners();
    }

    // ============================================
    // BULK OPERATIONS
    // ============================================

    setFiles(files: Array<{ path: string; content: string }>): void {
        this.state.files.clear();

        for (const file of files) {
            const normalizedPath = this.normalizePath(file.path);
            this.state.files.set(normalizedPath, {
                path: normalizedPath,
                content: file.content,
                isDirty: false,
                lastModified: new Date(),
                type: this.getFileType(normalizedPath),
            });
        }

        this.notifyListeners();
    }

    markAllClean(): void {
        for (const file of this.state.files.values()) {
            file.isDirty = false;
        }
        this.notifyListeners();
    }

    // ============================================
    // HISTORY / UNDO / REDO
    // ============================================

    private addToHistory(change: FileChange): void {
        this.state.history.push(change);
        this.undoStack.push(change);
        this.redoStack = []; // Clear redo stack on new change

        // Keep history limited
        if (this.state.history.length > 100) {
            this.state.history.shift();
        }
        if (this.undoStack.length > 50) {
            this.undoStack.shift();
        }
    }

    undo(): boolean {
        const change = this.undoStack.pop();
        if (!change) return false;

        // Revert the change
        if (change.type === 'create') {
            this.state.files.delete(change.path);
        } else if (change.type === 'delete' && change.previousContent !== undefined) {
            this.state.files.set(change.path, {
                path: change.path,
                content: change.previousContent,
                isDirty: true,
                lastModified: new Date(),
                type: this.getFileType(change.path),
            });
        } else if (change.type === 'modify' && change.previousContent !== undefined) {
            const file = this.state.files.get(change.path);
            if (file) {
                file.content = change.previousContent;
                file.isDirty = true;
                file.lastModified = new Date();
            }
        }

        this.redoStack.push(change);
        this.notifyListeners();
        return true;
    }

    redo(): boolean {
        const change = this.redoStack.pop();
        if (!change) return false;

        // Re-apply the change
        if (change.type === 'create' && change.newContent !== undefined) {
            this.state.files.set(change.path, {
                path: change.path,
                content: change.newContent,
                isDirty: true,
                lastModified: new Date(),
                type: this.getFileType(change.path),
            });
        } else if (change.type === 'delete') {
            this.state.files.delete(change.path);
        } else if (change.type === 'modify' && change.newContent !== undefined) {
            const file = this.state.files.get(change.path);
            if (file) {
                file.content = change.newContent;
                file.isDirty = true;
                file.lastModified = new Date();
            }
        }

        this.undoStack.push(change);
        this.notifyListeners();
        return true;
    }

    getHistory(): FileChange[] {
        return [...this.state.history];
    }

    // ============================================
    // LISTENERS
    // ============================================

    subscribe(listener: (state: WorkspaceState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notifyListeners(): void {
        const state = this.getState();
        for (const listener of this.listeners) {
            listener(state);
        }
    }

    // ============================================
    // UTILITIES
    // ============================================

    private normalizePath(path: string): string {
        // Remove leading slash if present
        let normalized = path.startsWith('/') ? path.slice(1) : path;
        // Normalize separators
        normalized = normalized.replace(/\\/g, '/');
        return normalized;
    }

    private getFileType(path: string): WorkspaceFile['type'] {
        const ext = path.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'tsx': return 'tsx';
            case 'ts': return 'ts';
            case 'css': return 'css';
            case 'html': return 'html';
            case 'json': return 'json';
            case 'js': case 'jsx': return 'js';
            default: return 'other';
        }
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    // ============================================
    // PERSISTENCE
    // ============================================

    toJSON(): { projectId: string; files: Array<{ path: string; content: string }> } {
        return {
            projectId: this.state.projectId,
            files: this.listFiles().map(f => ({ path: f.path, content: f.content })),
        };
    }

    static fromJSON(data: { projectId: string; files: Array<{ path: string; content: string }> }): WorkspaceManager {
        const manager = new WorkspaceManager(data.projectId);
        manager.setFiles(data.files);
        return manager;
    }
}

// Singleton factory for workspace managers
const workspaces = new Map<string, WorkspaceManager>();

export function getWorkspaceManager(projectId: string): WorkspaceManager {
    let manager = workspaces.get(projectId);
    if (!manager) {
        manager = new WorkspaceManager(projectId);
        workspaces.set(projectId, manager);
    }
    return manager;
}

export function clearWorkspaceManager(projectId: string): void {
    workspaces.delete(projectId);
}
