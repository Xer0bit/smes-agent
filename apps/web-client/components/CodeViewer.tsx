/**
 * Read-only source viewer.
 *
 * Replaces the Monaco (VS Code) editor: this platform's code panel is for
 * REVIEW only -- no editing, no IntelliSense, no save. A plain line-numbered
 * <pre> renders any file with zero editor weight and zero new dependencies.
 * File bodies are fetched lazily one at a time (see CodeEditorPanel's
 * onFileOpen), so this only ever holds the single file the user opened.
 */
import React, { useMemo } from 'react';
import { Code2 } from 'lucide-react';

interface CodeViewerProps {
  file: { path: string; content: string } | null;
  height?: string;
  showHeader?: boolean;
  fontSize?: number;
  /** Accepted for drop-in compatibility with the old editor; always read-only. */
  readOnly?: boolean;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml',
  py: 'python', sql: 'sql', sh: 'shell', bash: 'shell', dockerfile: 'dockerfile',
};
const languageOf = (path: string) =>
  LANGUAGE_BY_EXT[path.split('.').pop()?.toLowerCase() || ''] || 'plaintext';

export const CodeViewer: React.FC<CodeViewerProps> = ({
  file,
  height = '100%',
  showHeader = true,
  fontSize = 13,
}) => {
  const language = file ? languageOf(file.path) : 'plaintext';
  const fileName = file?.path.split('/').pop() || 'No file selected';
  const folderPath = useMemo(() => {
    if (!file?.path?.includes('/')) return 'workspace';
    return file.path.split('/').slice(0, -1).join('/');
  }, [file?.path]);

  const lines = useMemo(() => (file ? file.content.split('\n') : []), [file]);

  if (!file) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,#0f172a_0%,#060a12_55%,#05070d_100%)] text-slate-500">
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] px-8 py-10 text-center shadow-[0_20px_70px_rgba(0,0,0,0.3)]">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-200">
            <Code2 className="h-5 w-5" />
          </div>
          <p className="text-base font-medium text-slate-200">Select a file to inspect the source</p>
          <p className="mt-2 text-sm text-slate-500">Files load one at a time, only when you open them.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#060a12]" style={{ height }}>
      {showHeader && (
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-white/[0.03] px-5 py-3 text-sm text-slate-400 backdrop-blur-xl">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-200">
              <Code2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-100">{fileName}</div>
              <div className="truncate text-xs text-slate-500">{folderPath}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 uppercase tracking-[0.18em] text-slate-300">
              {language}
            </span>
            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-amber-100">
              Read only
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto bg-[#060a12]">
        <pre className="m-0 flex min-w-full text-slate-200" style={{ fontSize, lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', tabSize: 2 }}>
          <code aria-hidden className="select-none border-r border-white/10 px-3 py-3 text-right text-slate-600">
            {lines.map((_, i) => `${i + 1}\n`).join('')}
          </code>
          <code className="whitespace-pre px-4 py-3">{file.content}</code>
        </pre>
      </div>
    </div>
  );
};

export default CodeViewer;
