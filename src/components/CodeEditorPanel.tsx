/**
 * Code Editor Panel
 * Full project explorer + Monaco editor with creation/deletion/save actions.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { MonacoCodeEditor } from './MonacoCodeEditor';
import { FileTree } from './FileTree';
import { Download, Save, Plus, Trash2, Minus } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { cn } from '@/lib/utils';

interface WorkspaceFile {
    path: string;
    content: string;
}

interface CodeEditorPanelProps {
    files: WorkspaceFile[];
    onFileChange?: (path: string, content: string) => void;
    onFileCreate?: (path: string, content: string) => void;
    onFileDelete?: (path: string) => void;
    onSave?: () => void;
    readOnly?: boolean;
    canExport?: boolean;
    exportLockedReason?: string;
    streamingText?: string;
}

function stripXmlTags(text: string): string {
    return text
        .replace(/<ecomgear-[^>]*>/g, '')
        .replace(/<\/ecomgear-[^>]*>/g, '')
        .trim();
}

export const CodeEditorPanel: React.FC<CodeEditorPanelProps> = ({
    files,
    onFileChange,
    onFileCreate,
    onFileDelete,
    onSave,
    readOnly = false,
    canExport = true,
    exportLockedReason = 'Upgrade to Professional to export source code.',
    streamingText,
}) => {
    const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
    const selectedFilePathRef = useRef<string | null>(null);
    selectedFilePathRef.current = selectedFilePath;
    const [isDirty, setIsDirty] = useState(false);
    const [showNewFileInput, setShowNewFileInput] = useState(false);
    const [newFilePath, setNewFilePath] = useState('');
    const streamRef = useRef<HTMLDivElement>(null);
    const [fontSize, setFontSize] = useState(14);
    const [treeWidth, setTreeWidth] = useState(176);
    const bodyRef = useRef<HTMLDivElement>(null);
    const resizingRef = useRef(false);

    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        resizingRef.current = true;
        const containerLeft = bodyRef.current?.getBoundingClientRect().left ?? 0;
        const onMove = (moveEvent: MouseEvent) => {
            if (!resizingRef.current) return;
            setTreeWidth(Math.min(400, Math.max(140, moveEvent.clientX - containerLeft)));
        };
        const onUp = () => {
            resizingRef.current = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    const normalizedFiles = useMemo(() => {
        return [...files].sort((a, b) => a.path.localeCompare(b.path));
    }, [files]);

    const selectedFile = normalizedFiles.find(f => f.path === selectedFilePath) || null;

    const handleFileSelect = useCallback((path: string) => {
        setSelectedFilePath(path);
    }, []);

    const handleContentChange = useCallback((content: string) => {
        const path = selectedFilePathRef.current;
        if (path && onFileChange) {
            onFileChange(path, content);
            setIsDirty(true);
        }
    }, [onFileChange]);

    const normalizeNewPath = (raw: string): string => {
        return raw
            .trim()
            .replace(/\\/g, '/')
            .replace(/^\.\//, '')
            .replace(/^\/+/, '')
            .replace(/\s+/g, ' ')
            .replace(/\/+/g, '/');
    };

    const handleCreateFile = useCallback(() => {
        if (!onFileCreate || readOnly) return;

        const nextPath = normalizeNewPath(newFilePath);
        if (!nextPath) {
            toast.error('Enter a valid file path');
            return;
        }

        if (nextPath.endsWith('/')) {
            toast.error('File path cannot end with /');
            return;
        }

        if (normalizedFiles.some((file) => file.path === nextPath)) {
            toast.error('File already exists');
            return;
        }

        onFileCreate(nextPath, '');
        setSelectedFilePath(nextPath);
        setIsDirty(true);
        setNewFilePath('');
        setShowNewFileInput(false);
        toast.success(`Created ${nextPath}`);
    }, [newFilePath, normalizedFiles, onFileCreate, readOnly]);

    const handleDeleteSelectedFile = useCallback(() => {
        if (!selectedFilePath || !onFileDelete || readOnly) return;

        const confirmed = window.confirm(`Delete ${selectedFilePath}?`);
        if (!confirmed) return;

        const currentIndex = normalizedFiles.findIndex((file) => file.path === selectedFilePath);
        const fallbackFile = normalizedFiles[currentIndex + 1] || normalizedFiles[currentIndex - 1] || null;

        onFileDelete(selectedFilePath);
        setSelectedFilePath(fallbackFile?.path || null);
        setIsDirty(true);
        toast.success(`Deleted ${selectedFilePath}`);
    }, [selectedFilePath, onFileDelete, readOnly, normalizedFiles]);

    const handleSave = useCallback(() => {
        if (onSave) {
            onSave();
            setIsDirty(false);
            toast.success('Project synced');
        }
    }, [onSave]);

    const handleDownloadFile = useCallback(() => {
        if (!canExport) {
            toast.error(exportLockedReason);
            return;
        }
        if (!selectedFile) return;

        const blob = new Blob([selectedFile.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = selectedFile.path.split('/').pop() || 'file.txt';
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Downloaded ${selectedFile.path}`);
    }, [canExport, exportLockedReason, selectedFile]);

    const handleDownloadAll = useCallback(async () => {
        if (!canExport) {
            toast.error(exportLockedReason);
            return;
        }
        try {
            const zip = new JSZip();
            normalizedFiles.forEach(file => {
                zip.file(file.path, file.content);
            });

            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'project.zip';
            a.click();
            URL.revokeObjectURL(url);
            toast.success('Downloaded project as ZIP');
        } catch {
            toast.error('Failed to create ZIP');
        }
    }, [canExport, exportLockedReason, normalizedFiles]);

    useEffect(() => {
        if (!selectedFilePath && normalizedFiles.length > 0) {
            const mainFile = normalizedFiles.find(f =>
                f.path.endsWith('App.tsx') ||
                f.path.endsWith('main.tsx') ||
                f.path.endsWith('index.tsx')
            );
            setSelectedFilePath(mainFile?.path || normalizedFiles[0].path);
        }
    }, [normalizedFiles, selectedFilePath]);

    useEffect(() => {
        if (!selectedFilePath) return;
        if (normalizedFiles.some((file) => file.path === selectedFilePath)) return;

        const fallback = normalizedFiles.find((file) =>
            file.path.endsWith('main.tsx') || file.path.endsWith('App.tsx')
        ) || normalizedFiles[0] || null;

        setSelectedFilePath(fallback?.path || null);
    }, [normalizedFiles, selectedFilePath]);

    // Auto-scroll streaming panel to bottom as text arrives
    useEffect(() => {
        if (streamRef.current) {
            streamRef.current.scrollTop = streamRef.current.scrollHeight;
        }
    }, [streamingText]);

    const visibleStreamText = streamingText ? stripXmlTags(streamingText) : '';

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[#09090b]">
            {/* Slim single-line header */}
            <div className="flex items-center justify-between px-2.5 h-8 border-b border-white/[0.05] bg-[#0d0d0f] flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-white/60 font-mono truncate">
                        {selectedFilePath ?? 'No file selected'}
                    </span>
                    {isDirty && !readOnly && (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Unsynced changes" />
                    )}
                </div>

                <div className="flex items-center gap-0.5 flex-shrink-0">
                    {!readOnly && (
                        <button
                            onClick={() => { setShowNewFileInput(p => !p); if (showNewFileInput) setNewFilePath(''); }}
                            title="New file"
                            className="p-1.5 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors"
                        >
                            <Plus className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {!readOnly && (
                        <button
                            onClick={handleDeleteSelectedFile}
                            disabled={!selectedFilePath}
                            title="Delete file"
                            className="p-1.5 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors disabled:opacity-30"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {isDirty && !readOnly && (
                        <button
                            onClick={handleSave}
                            title="Sync preview"
                            className="p-1.5 rounded hover:bg-white/5 text-amber-400/70 hover:text-amber-400 transition-colors"
                        >
                            <Save className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {canExport && (
                        <button
                            onClick={handleDownloadFile}
                            disabled={!selectedFile}
                            title="Export file"
                            className="p-1.5 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors disabled:opacity-30"
                        >
                            <Download className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {canExport && (
                        <button
                            onClick={handleDownloadAll}
                            disabled={normalizedFiles.length === 0}
                            title="Download all as ZIP"
                            className={cn(
                                'px-2 py-1 rounded text-[10px] font-mono tracking-wide transition-colors',
                                'text-white/40 hover:text-white/70 hover:bg-white/5 disabled:opacity-30'
                            )}
                        >
                            ZIP
                        </button>
                    )}
                    {!canExport && (
                        <span className="px-2 py-0.5 rounded text-[10px] text-amber-400/60 border border-amber-400/20">
                            Pro+
                        </span>
                    )}
                    <div className="flex items-center gap-0.5 ml-1 pl-1.5 border-l border-white/[0.06]">
                        <button
                            onClick={() => setFontSize(f => Math.max(10, f - 1))}
                            title="Decrease font size"
                            className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors"
                        >
                            <Minus className="w-3 h-3" />
                        </button>
                        <span className="text-[10px] text-white/35 font-mono w-6 text-center tabular-nums">{fontSize}</span>
                        <button
                            onClick={() => setFontSize(f => Math.min(22, f + 1))}
                            title="Increase font size"
                            className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors"
                        >
                            <Plus className="w-3 h-3" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Inline new-file input */}
            {!readOnly && showNewFileInput && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-white/[0.05] bg-[#0d0d0f]">
                    <input
                        autoFocus
                        value={newFilePath}
                        onChange={e => setNewFilePath(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); handleCreateFile(); }
                            if (e.key === 'Escape') { setShowNewFileInput(false); setNewFilePath(''); }
                        }}
                        placeholder="src/components/NewComponent.tsx"
                        className="flex-1 px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-white/80 placeholder-white/25 outline-none focus:border-white/20 font-mono"
                    />
                    <button
                        onClick={handleCreateFile}
                        className="px-2.5 py-1 rounded text-xs bg-white/10 hover:bg-white/15 text-white/70 hover:text-white transition-colors"
                    >
                        Create
                    </button>
                </div>
            )}

            {/* Main content: file tree + editor */}
            <div ref={bodyRef} className="flex min-h-0 flex-1 overflow-hidden">
                <div className="flex-shrink-0 border-r border-white/[0.05] overflow-hidden" style={{ width: treeWidth }}>
                    <FileTree
                        files={normalizedFiles}
                        selectedFile={selectedFilePath}
                        onFileSelect={handleFileSelect}
                    />
                </div>

                <div
                    onMouseDown={handleResizeStart}
                    className="w-1 flex-shrink-0 cursor-col-resize hover:bg-indigo-500/40 active:bg-indigo-500/60 transition-colors"
                />

                <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <MonacoCodeEditor
                            file={selectedFile}
                            onChange={handleContentChange}
                            readOnly={readOnly}
                            showHeader={false}
                            fontSize={fontSize}
                        />
                    </div>

                    {/* Agent streaming panel */}
                    {visibleStreamText.length > 0 && (
                        <div className="flex-shrink-0 border-t border-white/[0.05] bg-[#0a0a0c]" style={{ maxHeight: '90px' }}>
                            <div className="flex items-center gap-1.5 px-2.5 h-[20px] border-b border-white/[0.05]">
                                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="text-[9px] text-white/30 uppercase tracking-widest font-mono">Agent</span>
                            </div>
                            <div
                                ref={streamRef}
                                className="overflow-y-auto px-2.5 py-1.5 text-[10px] text-white/40 font-mono leading-relaxed whitespace-pre-wrap"
                                style={{ maxHeight: '68px' }}
                            >
                                {visibleStreamText}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default CodeEditorPanel;
