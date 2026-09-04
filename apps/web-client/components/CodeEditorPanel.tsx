/**
 * Source review panel: project file tree + read-only viewer.
 *
 * View-only by design -- there is no code editor on this platform (the agent
 * writes files server-side; users review, they do not hand-edit). Files load
 * lazily one at a time: the tree renders from a manifest of paths, and a file's
 * body is fetched only when it is opened (onFileOpen). Export (single file /
 * ZIP) stays. The editing props remain on the interface but are inert, so the
 * Editor's existing call site keeps compiling.
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { CodeViewer } from './CodeViewer';
import { FileTree } from './FileTree';
import { Download, Plus, Minus } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { cn } from '@/lib/utils';

interface WorkspaceFile {
    path: string;
    /** null = not yet downloaded (lazy) -- selecting it triggers onFileOpen */
    content: string | null;
}

interface CodeEditorPanelProps {
    files: WorkspaceFile[];
    /** Called when a file with content === null is selected; the parent fetches and updates `files`. */
    onFileOpen?: (path: string) => void;
    // Inert: this panel is view-only. Kept optional so existing call sites compile.
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
        .replace(/<SMEsAgent-[^>]*>/g, '')
        .replace(/<\/SMEsAgent-[^>]*>/g, '')
        .trim();
}

export const CodeEditorPanel: React.FC<CodeEditorPanelProps> = ({
    files,
    onFileOpen,
    canExport = true,
    exportLockedReason = 'Upgrade to Professional to export source code.',
    streamingText,
}) => {
    const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
    const streamRef = useRef<HTMLDivElement>(null);
    const [fontSize, setFontSize] = useState(13);
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
    const selectedIsLoading = selectedFile != null && selectedFile.content === null;

    // Select a file to view. Bodies are lazy: content === null means it has not
    // been fetched yet, so ask the parent to fetch just this one.
    const handleFileSelect = useCallback((path: string) => {
        setSelectedFilePath(path);
        const f = files.find(x => x.path === path);
        if (f && f.content === null) onFileOpen?.(path);
    }, [files, onFileOpen]);

    const handleDownloadFile = useCallback(() => {
        if (!canExport) { toast.error(exportLockedReason); return; }
        if (!selectedFile || selectedFile.content === null) return;
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
        if (!canExport) { toast.error(exportLockedReason); return; }
        try {
            const unloaded = normalizedFiles.filter(f => f.content === null);
            if (unloaded.length > 0) {
                // Lazy panel: bodies are fetched on open, so a ZIP of everything
                // would need a full fetch. Tell the user rather than silently
                // shipping a partial archive.
                toast.error(`${unloaded.length} unopened file(s) -- open them first, or use per-file export`);
                return;
            }
            const zip = new JSZip();
            normalizedFiles.forEach(file => { zip.file(file.path, file.content as string); });
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

    // Default the selection to a main file once the tree is known.
    useEffect(() => {
        if (!selectedFilePath && normalizedFiles.length > 0) {
            const mainFile = normalizedFiles.find(f =>
                f.path.endsWith('App.tsx') || f.path.endsWith('main.tsx') || f.path.endsWith('index.tsx')
            );
            const next = mainFile?.path || normalizedFiles[0].path;
            setSelectedFilePath(next);
            const f = normalizedFiles.find(x => x.path === next);
            if (f && f.content === null) onFileOpen?.(next);
        }
    }, [normalizedFiles, selectedFilePath, onFileOpen]);

    // Keep the selection valid if the tree changes under it.
    useEffect(() => {
        if (!selectedFilePath) return;
        if (normalizedFiles.some((file) => file.path === selectedFilePath)) return;
        const fallback = normalizedFiles.find((file) =>
            file.path.endsWith('main.tsx') || file.path.endsWith('App.tsx')
        ) || normalizedFiles[0] || null;
        setSelectedFilePath(fallback?.path || null);
    }, [normalizedFiles, selectedFilePath]);

    useEffect(() => {
        if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
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
                </div>

                <div className="flex items-center gap-0.5 flex-shrink-0">
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

            {/* Main content: file tree + read-only viewer */}
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
                        {selectedIsLoading ? (
                            <div className="flex h-full items-center justify-center gap-2 text-xs text-white/40">
                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                                Loading {selectedFilePath?.split('/').pop()}…
                            </div>
                        ) : (
                            <CodeViewer
                                file={selectedFile as { path: string; content: string } | null}
                                showHeader={false}
                                fontSize={fontSize}
                            />
                        )}
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
