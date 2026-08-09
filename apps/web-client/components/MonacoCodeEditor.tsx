/**
 * Monaco Code Editor Component
 * Professional code editor with syntax highlighting and editing capabilities.
 */

import React, { useCallback, useMemo } from 'react';
import Editor, { OnMount, OnChange } from '@monaco-editor/react';
import { Code2 } from 'lucide-react';
import type * as MonacoType from 'monaco-editor';

interface MonacoCodeEditorProps {
    file: {
        path: string;
        content: string;
    } | null;
    onChange?: (content: string) => void;
    readOnly?: boolean;
    height?: string;
    theme?: 'vs-dark' | 'light' | 'hc-black';
    showHeader?: boolean;
    fontSize?: number;
}

// Map file extensions to Monaco languages
const getLanguage = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'typescript',
        'js': 'javascript',
        'jsx': 'javascript',
        'json': 'json',
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'md': 'markdown',
        'yaml': 'yaml',
        'yml': 'yaml',
        'xml': 'xml',
        'svg': 'xml',
        'py': 'python',
        'sql': 'sql',
        'sh': 'shell',
        'bash': 'shell',
        'dockerfile': 'dockerfile',
    };
    return languageMap[ext] || 'plaintext';
};

export const MonacoCodeEditor: React.FC<MonacoCodeEditorProps> = ({
    file,
    onChange,
    readOnly = false,
    height = '100%',
    theme = 'vs-dark',
    showHeader = true,
    fontSize = 14,
}) => {
    // Determine language from file extension
    const language = useMemo(() => {
        return file?.path ? getLanguage(file.path) : 'plaintext';
    }, [file?.path]);

    const fileName = file?.path.split('/').pop() || 'No file selected';

    const folderPath = useMemo(() => {
        if (!file?.path?.includes('/')) return 'workspace';
        return file.path.split('/').slice(0, -1).join('/');
    }, [file?.path]);

    // Handle editor mount for additional configuration
    const handleEditorMount: OnMount = useCallback((editor, monaco) => {
        // Configure TypeScript/JavaScript compiler options for JSX
        monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ESNext,
            allowNonTsExtensions: true,
            moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
            module: monaco.languages.typescript.ModuleKind.ESNext,
            noEmit: true,
            esModuleInterop: true,
            jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
            reactNamespace: 'React',
            allowJs: true,
            typeRoots: ['node_modules/@types'],
        });

        // Add React type definitions for better IntelliSense
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
            `declare module 'react' {
        export = React;
        export as namespace React;
        declare namespace React {
          type FC<P = {}> = (props: P) => ReactElement | null;
          interface ReactElement { }
          function useState<T>(initialState: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
          function useEffect(effect: () => void | (() => void), deps?: any[]): void;
          function useCallback<T extends (...args: any[]) => any>(callback: T, deps: any[]): T;
          function useMemo<T>(factory: () => T, deps: any[]): T;
          function useRef<T>(initialValue: T): { current: T };
          function forwardRef<T, P = {}>(render: (props: P, ref: React.Ref<T>) => ReactElement | null): React.FC<P & { ref?: React.Ref<T> }>;
          type Ref<T> = { current: T | null } | null;
          interface CSSProperties { [key: string]: string | number }
        }
      }`,
            'file:///node_modules/@types/react/index.d.ts'
        );

        // Focus the editor
        editor.focus();
    }, []);

    // Handle content changes
    const handleChange: OnChange = useCallback((value) => {
        if (onChange && value !== undefined) {
            onChange(value);
        }
    }, [onChange]);

    // Render placeholder if no file selected
    if (!file) {
        return (
            <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,#0f172a_0%,#060a12_55%,#05070d_100%)] text-slate-500">
                <div className="rounded-3xl border border-white/10 bg-white/[0.03] px-8 py-10 text-center shadow-[0_20px_70px_rgba(0,0,0,0.3)]">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-200">
                        <Code2 className="h-5 w-5" />
                    </div>
                    <p className="text-base font-medium text-slate-200">Select a file to inspect the source</p>
                    <p className="mt-2 text-sm text-slate-500">Your workspace tree stays on the left for fast switching.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-[#060a12]">
            {showHeader && (
                <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-white/[0.03] px-5 py-3 text-sm text-slate-400 backdrop-blur-xl">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-200">
                                <Code2 className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="truncate font-medium text-slate-100">{fileName}</div>
                                <div className="truncate text-xs text-slate-500">{folderPath}</div>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 uppercase tracking-[0.18em] text-slate-300">
                            {language}
                        </span>
                        {readOnly && (
                            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-amber-100">
                                Read only
                            </span>
                        )}
                    </div>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-hidden">
                <div className="h-full overflow-hidden bg-[#060a12]">
                <Editor
                    height={height}
                    language={language}
                    path={file.path}
                    value={file.content}
                    theme={theme}
                    onChange={handleChange}
                    onMount={handleEditorMount}
                    options={{
                        readOnly,
                        minimap: { enabled: true, size: 'proportional', showSlider: 'mouseover' },
                        fontSize,
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        automaticLayout: true,
                        scrollBeyondLastLine: false,
                        folding: true,
                        formatOnPaste: true,
                        formatOnType: true,
                        tabSize: 2,
                        insertSpaces: true,
                        bracketPairColorization: { enabled: true },
                        cursorBlinking: 'smooth',
                        cursorSmoothCaretAnimation: 'on',
                        smoothScrolling: true,
                        renderWhitespace: 'selection',
                        padding: { top: 10 },
                    }}
                    loading={
                        <div className="flex h-full w-full items-center justify-center bg-[#05070d] text-slate-400">
                            Loading editor...
                        </div>
                    }
                />
                </div>
            </div>
        </div>
    );
};

export default MonacoCodeEditor;
