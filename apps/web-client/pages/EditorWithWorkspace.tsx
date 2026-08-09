import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import Editor, { OnMount } from '@monaco-editor/react';
import {
  Sparkles,
  Play,
  Square,
  ExternalLink,
  RotateCw,
  FileCode,
  Send,
  Bot,
  User,
  Folder,
  Cpu,
  Globe,
  CheckCircle2,
  Paperclip,
  X,
  Image as ImageIcon,
  UploadCloud,
  Rocket,
  Copy,
  Check,
  Loader2,
  Github,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAgentStream } from '@/hooks/useAgentStream';

const QUICK_START_SUGGESTIONS = [
  '🚀 Build a SaaS Landing Page with Pricing Cards',
  '🔒 Add Supabase Authentication Login & Signup',
  '💳 Integrate Stripe Subscription Checkout',
  '🎨 Add Dark Mode & Modern CSS Animations',
];

export default function EditorWithWorkspace() {
  const { projectId = 'demo-project' } = useParams<{ projectId: string }>();

  const {
    isGenerating,
    chatMessages,
    activeToolCall,
    followUpSuggestions,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    files,
    activeFilePath,
    activeFileContent,
    activeFileLanguage,
    previewPort,
    startAgentStream,
    cancelStream,
    selectFile,
    updateFileContent,
  } = useAgentStream(projectId);

  const [inputPrompt, setInputPrompt] = useState('');
  const [iframeKey, setIframeKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentUrl, setDeploymentUrl] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // GitHub Export State
  const [isGithubModalOpen, setIsGithubModalOpen] = useState(false);
  const [isExportingGithub, setIsExportingGithub] = useState(false);
  const [githubPat, setGithubPat] = useState(() => localStorage.getItem('github_pat') || '');
  const [githubRepoName, setGithubRepoName] = useState(() => `ecg-${projectId.slice(0, 12)}`);
  const [githubIsPrivate, setGithubIsPrivate] = useState(true);
  const [githubRepoUrl, setGithubRepoUrl] = useState<string | null>(null);

  const handleGithubExport = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!githubPat.trim()) {
      toast.error('Please enter a GitHub Personal Access Token');
      return;
    }
    if (!githubRepoName.trim()) {
      toast.error('Please enter a repository name');
      return;
    }

    setIsExportingGithub(true);

    try {
      localStorage.setItem('github_pat', githubPat.trim());

      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const response = await fetch(`/api/v1/github/export/${projectId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          githubToken: githubPat.trim(),
          repoName: githubRepoName.trim(),
          isPrivate: githubIsPrivate,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to export to GitHub');
      }

      if (data.repoUrl) {
        setGithubRepoUrl(data.repoUrl);
        setIsGithubModalOpen(false);
        toast.success('Pushed to GitHub successfully!', {
          description: (
            <a
              href={data.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-indigo-400 font-semibold flex items-center gap-1 mt-1"
            >
              View Repository ({data.repoUrl})
              <ExternalLink className="h-3 w-3 inline" />
            </a>
          ),
        });
      } else {
        throw new Error('Response missing repository URL');
      }
    } catch (error: any) {
      toast.error(error?.message || 'GitHub export failed');
    } finally {
      setIsExportingGithub(false);
    }
  };

  const editorRef = useRef<any>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDeploy = async () => {
    if (isDeploying) return;
    setIsDeploying(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const response = await fetch(`/api/v1/deploy/${projectId}`, {
        method: 'POST',
        headers,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Deployment failed');
      }

      if (data.deploymentUrl) {
        setDeploymentUrl(data.deploymentUrl);
        toast.success('Project deployed live to Vercel!');
      } else {
        throw new Error('Deployment response missing live URL');
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to deploy project';
      toast.error(errorMessage);
    } finally {
      setIsDeploying(false);
    }
  };

  const handleCopyLink = () => {
    if (!deploymentUrl) return;
    navigator.clipboard.writeText(deploymentUrl);
    setCopiedLink(true);
    toast.success('Deployment link copied to clipboard!');
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Auto-scroll chat to bottom on new messages or deltas
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, activeToolCall]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const handleSubmitPrompt = useCallback(
    (overridePrompt?: string) => {
      const promptToSubmit = overridePrompt || inputPrompt;
      if ((!promptToSubmit.trim() && pendingAttachments.length === 0) || isGenerating) return;

      startAgentStream(promptToSubmit);
      if (!overridePrompt) {
        setInputPrompt('');
      }
    },
    [inputPrompt, pendingAttachments, isGenerating, startAgentStream]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitPrompt();
    }
  };

  // Drag-and-drop Handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          addAttachment(file);
        }
      });
    }
  };

  const handleFilePickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      Array.from(e.target.files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          addAttachment(file);
        }
      });
    }
    // Reset file input value to allow selecting same file again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const previewUrl = `http://localhost:${previewPort}`;

  return (
    <div className="h-screen w-screen bg-[#09090b] text-slate-100 flex flex-col overflow-hidden font-sans select-none">
      {/* ── Top Navigation Bar ────────────────────────────────────────── */}
      <header className="h-12 border-b border-zinc-800 bg-[#0d0d10] px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <div className="h-7 w-7 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xs shadow-inner">
            eCG
          </div>
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-sm tracking-tight text-zinc-100">
              eComGear AI IDE
            </span>
            <span className="text-zinc-600 text-xs">/</span>
            <span className="text-xs text-zinc-400 font-mono bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
              {projectId}
            </span>
          </div>
        </div>

        {/* Center: Active Tool & Status Badge */}
        <div className="flex items-center space-x-2">
          {isGenerating ? (
            <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-indigo-950/80 border border-indigo-500/40 text-indigo-300 text-xs shadow-lg animate-pulse">
              <Sparkles className="w-3.5 h-3.5 animate-spin text-indigo-400" />
              <span className="font-medium">
                {activeToolCall || 'AI Agent active...'}
              </span>
            </div>
          ) : (
            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-400 text-xs">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>MicroVM Sandbox Ready</span>
            </div>
          )}
        </div>

        {/* Right Controls */}
        <div className="flex items-center space-x-2">
          {deploymentUrl ? (
            <div className="flex items-center space-x-1.5">
              <a
                href={deploymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1 text-xs rounded-md font-semibold bg-emerald-600/20 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-600/30 transition-all flex items-center space-x-1.5 shadow-sm"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span>Live Deployment</span>
                <ExternalLink className="w-3.5 h-3.5 ml-0.5" />
              </a>
              <button
                onClick={handleCopyLink}
                title="Copy deployment URL"
                className="p-1.5 text-xs rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                {copiedLink ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          ) : (
            <button
              onClick={handleDeploy}
              disabled={isDeploying}
              className="px-3 py-1 text-xs rounded-md font-medium bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-md hover:shadow-indigo-500/20 transition-all flex items-center space-x-1.5 border border-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDeploying ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Deploying...</span>
                </>
              ) : (
                <>
                  <Rocket className="w-3.5 h-3.5" />
                  <span>Publish to Edge</span>
                </>
              )}
            </button>
          )}

          {/* Push to GitHub Button */}
          <button
            onClick={() => setIsGithubModalOpen(true)}
            disabled={isExportingGithub}
            className="px-3 py-1 text-xs rounded-md font-medium bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-zinc-200 shadow-md transition-all flex items-center space-x-1.5 disabled:opacity-50"
          >
            {isExportingGithub ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <Github className="w-3.5 h-3.5 text-white" />
                <span>Push to GitHub</span>
              </>
            )}
          </button>

          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className={`px-2.5 py-1 text-xs rounded-md border font-medium transition-colors flex items-center space-x-1.5 ${
              sidebarOpen
                ? 'bg-zinc-800 border-zinc-700 text-zinc-200'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Agent Assistant</span>
          </button>
        </div>
      </header>

      {/* ── Main Workspace Body ───────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: File Tree & Project Files */}
        <aside className="w-56 border-r border-zinc-800 bg-[#0d0d10] flex flex-col shrink-0">
          <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center space-x-2 text-zinc-400 text-xs font-semibold uppercase tracking-wider">
              <Folder className="w-3.5 h-3.5 text-indigo-400" />
              <span>Workspace Files</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5 font-mono text-xs">
            {Object.keys(files).map((filePath) => {
              const isActive = filePath === activeFilePath;
              return (
                <button
                  key={filePath}
                  onClick={() => selectFile(filePath)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md flex items-center space-x-2 transition-colors ${
                    isActive
                      ? 'bg-indigo-600/20 text-indigo-300 font-medium border border-indigo-500/30'
                      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                  }`}
                >
                  <FileCode className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-indigo-400' : 'text-zinc-500'}`} />
                  <span className="truncate">{filePath}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Split-Pane: Editor (Left) & Preview (Right) */}
        <div className="flex-1 overflow-hidden">
          <PanelGroup direction="horizontal" className="h-full w-full">
            {/* ── Left Pane: Monaco Editor ────────────────────────────── */}
            <Panel defaultSize={50} minSize={25}>
              <div className="h-full flex flex-col bg-[#09090b]">
                {/* Editor Header Tab */}
                <div className="h-9 bg-[#0d0d10] border-b border-zinc-800 flex items-center justify-between px-3 shrink-0">
                  <div className="flex items-center space-x-2">
                    <FileCode className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-mono font-medium text-zinc-200">
                      {activeFilePath}
                    </span>
                    {isGenerating && (
                      <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/30 font-sans">
                        Read-Only (Diff Mode)
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500 uppercase">
                    {activeFileLanguage}
                  </div>
                </div>

                {/* Monaco Component */}
                <div className="flex-1 relative overflow-hidden">
                  <Editor
                    height="100%"
                    language={activeFileLanguage}
                    value={activeFileContent}
                    theme="vs-dark"
                    onChange={(value) => updateFileContent(activeFilePath, value || '')}
                    onMount={handleEditorMount}
                    options={{
                      automaticLayout: true,
                      readOnly: isGenerating,
                      minimap: { enabled: false },
                      fontSize: 13,
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      lineNumbers: 'on',
                      tabSize: 2,
                      padding: { top: 12, bottom: 12 },
                      fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
                    }}
                  />
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="w-1.5 bg-zinc-900 hover:bg-indigo-600/50 transition-colors cursor-col-resize flex items-center justify-center">
              <div className="w-0.5 h-6 bg-zinc-700 rounded" />
            </PanelResizeHandle>

            {/* ── Right Pane: MicroVM Sandbox Iframe ─────────────────── */}
            <Panel defaultSize={50} minSize={25}>
              <div className="h-full flex flex-col bg-[#09090b] relative">
                {/* MicroVM Header Bar */}
                <div className="h-9 bg-[#0d0d10] border-b border-zinc-800 flex items-center justify-between px-3 shrink-0">
                  <div className="flex items-center space-x-2 flex-1 max-w-md">
                    <Globe className="w-3.5 h-3.5 text-zinc-400" />
                    <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-xs font-mono text-zinc-400 truncate">
                      {previewUrl}
                    </div>
                  </div>

                  <div className="flex items-center space-x-1.5 ml-2">
                    <button
                      onClick={() => setIframeKey((prev) => prev + 1)}
                      className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
                      title="Reload Preview"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
                      title="Open in New Tab"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>

                {/* MicroVM Sandbox Iframe & Overlay Mask */}
                <div className="flex-1 relative bg-white">
                  <iframe
                    key={iframeKey}
                    src={previewUrl}
                    className="w-full h-full border-0"
                    title="MicroVM Live Sandbox Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms"
                  />

                  {/* Glassmorphism Thinking Overlay Mask */}
                  {isGenerating && (
                    <div className="absolute inset-0 backdrop-blur-md bg-slate-950/75 flex flex-col items-center justify-center p-6 text-center z-20 animate-in fade-in duration-300">
                      <div className="relative mb-4">
                        <div className="w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shadow-2xl">
                          <Cpu className="w-7 h-7 animate-pulse text-indigo-400" />
                        </div>
                        <div className="absolute -inset-1 rounded-2xl bg-indigo-500/20 blur-md -z-10 animate-pulse" />
                      </div>
                      
                      <h3 className="text-base font-semibold text-white mb-1 tracking-tight">
                        MicroVM Hot Reloading
                      </h3>
                      <p className="text-xs text-indigo-300 max-w-sm font-mono bg-indigo-950/50 border border-indigo-500/30 px-3 py-1.5 rounded-lg shadow-inner">
                        {activeToolCall || '⚡ Materializing code changes...'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </div>

        {/* ── Right Floating Drawer / Multi-Modal Chat Panel ───────────── */}
        {sidebarOpen && (
          <aside
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="w-80 border-l border-zinc-800 bg-[#0d0d10] flex flex-col shrink-0 relative"
          >
            {/* Drag & Drop Visual Overlay */}
            {isDragging && (
              <div className="absolute inset-0 z-50 backdrop-blur-md bg-indigo-950/90 border-2 border-dashed border-indigo-500 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-200">
                <div className="w-12 h-12 rounded-full bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center text-indigo-300 mb-3 animate-bounce">
                  <UploadCloud className="w-6 h-6" />
                </div>
                <h4 className="text-sm font-semibold text-white mb-1">
                  Drop Image Wireframe or UI Mockup
                </h4>
                <p className="text-xs text-indigo-200">
                  Agent will analyze image structure with Vision LLM
                </p>
              </div>
            )}

            {/* Chat Panel Header */}
            <div className="p-3 border-b border-zinc-800 flex items-center justify-between bg-[#0d0d10]">
              <div className="flex items-center space-x-2 text-xs font-semibold text-zinc-200">
                <Sparkles className="w-4 h-4 text-indigo-400" />
                <span>AI Architect Assistant</span>
              </div>
              <span className="text-[10px] font-mono bg-indigo-950 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.5 rounded flex items-center space-x-1">
                <ImageIcon className="w-2.5 h-2.5" />
                <span>Vision Ready</span>
              </span>
            </div>

            {/* Chat Message History */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs font-sans">
              {chatMessages.length === 0 ? (
                /* Empty State: Quick-start Intent Cards */
                <div className="h-full flex flex-col justify-center space-y-3 p-2">
                  <div className="text-center space-y-1 mb-2">
                    <div className="h-8 w-8 rounded-full bg-indigo-600/20 text-indigo-400 flex items-center justify-center mx-auto mb-2 border border-indigo-500/30">
                      <ImageIcon className="w-4 h-4" />
                    </div>
                    <h4 className="font-semibold text-zinc-200 text-sm">
                      Multi-Modal AI Building
                    </h4>
                    <p className="text-zinc-400 text-xs">
                      Drop wireframes, design mockups, or select a template to generate code.
                    </p>
                  </div>

                  <div className="space-y-2">
                    {QUICK_START_SUGGESTIONS.map((chip, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSubmitPrompt(chip)}
                        className="w-full text-left p-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-indigo-500/40 text-zinc-300 hover:text-white transition-all text-xs flex items-center justify-between group shadow-sm"
                      >
                        <span className="truncate pr-2">{chip}</span>
                        <Play className="w-3 h-3 text-zinc-500 group-hover:text-indigo-400 shrink-0 transition-colors" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* Render Chat Messages */
                chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col space-y-1 ${
                      msg.role === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div className="flex items-center space-x-1.5 text-[10px] text-zinc-500">
                      {msg.role === 'user' ? (
                        <>
                          <span>You</span>
                          <User className="w-3 h-3 text-indigo-400" />
                        </>
                      ) : (
                        <>
                          <Bot className="w-3 h-3 text-emerald-400" />
                          <span>eComGear Agent</span>
                        </>
                      )}
                    </div>
                    
                    <div
                      className={`p-3 rounded-xl max-w-[90%] text-xs leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-none shadow-md space-y-2'
                          : 'bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-bl-none shadow-sm whitespace-pre-wrap'
                      }`}
                    >
                      {/* Attached Vision Image Thumbnails in History */}
                      {msg.images && msg.images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pb-1">
                          {msg.images.map((imgSrc, i) => (
                            <img
                              key={i}
                              src={imgSrc}
                              alt={`Attachment ${i + 1}`}
                              className="w-16 h-16 object-cover rounded-lg border border-white/20 shadow"
                            />
                          ))}
                        </div>
                      )}

                      {msg.content || (isGenerating && msg.id === chatMessages[chatMessages.length - 1]?.id ? (
                        <span className="italic text-zinc-400 animate-pulse flex items-center space-x-1">
                          <Sparkles className="w-3 h-3 text-indigo-400 animate-spin" />
                          <span>Generating code response...</span>
                        </span>
                      ) : (
                        ''
                      ))}
                    </div>
                  </div>
                ))
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Proactive Elicitation Chips & Multi-Modal Input Bar */}
            <div className="p-3 border-t border-zinc-800 bg-[#0d0d10] space-y-2">
              {/* Proactive Chips */}
              {followUpSuggestions.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider flex items-center space-x-1">
                    <Sparkles className="w-3 h-3" />
                    <span>Suggested Next Steps</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {followUpSuggestions.map((suggestion, i) => (
                      <button
                        key={i}
                        onClick={() => handleSubmitPrompt(suggestion)}
                        className="text-[11px] px-2.5 py-1 rounded-full bg-indigo-950/70 hover:bg-indigo-900 border border-indigo-500/30 text-indigo-200 hover:text-white transition-all text-left truncate max-w-full shadow-sm"
                      >
                        ✨ {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Chat Input Bar with Drag & Attachment Preview */}
              <div className="relative flex flex-col bg-zinc-900 border border-zinc-800 rounded-xl focus-within:border-indigo-500/60 transition-colors p-2 shadow-inner">
                {/* Pending Attachments Preview Bar */}
                {pendingAttachments.length > 0 && (
                  <div className="flex items-center space-x-2 overflow-x-auto pb-2 mb-2 border-b border-zinc-800/80">
                    {pendingAttachments.map((file, idx) => (
                      <div key={idx} className="relative group shrink-0">
                        <img
                          src={URL.createObjectURL(file)}
                          alt={file.name}
                          className="w-12 h-12 object-cover rounded-lg border border-indigo-500/40 shadow-sm"
                        />
                        <button
                          type="button"
                          onClick={() => removeAttachment(idx)}
                          className="absolute -top-1.5 -right-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-full p-0.5 shadow transition-colors"
                          title="Remove attachment"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Textarea Input */}
                <textarea
                  value={inputPrompt}
                  onChange={(e) => setInputPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask agent or drop image wireframe to generate UI..."
                  rows={2}
                  disabled={isGenerating}
                  className="w-full bg-transparent text-xs text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none"
                />

                {/* Input Actions Footer */}
                <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60 mt-1">
                  <div className="flex items-center space-x-1.5">
                    {/* Hidden Native File Input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleFilePickerChange}
                      className="hidden"
                    />

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isGenerating}
                      className="p-1.5 text-zinc-400 hover:text-indigo-300 hover:bg-zinc-800 rounded-lg transition-colors"
                      title="Attach image wireframe or screenshot"
                    >
                      <Paperclip className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[10px] text-zinc-500 hidden sm:inline">
                      Shift+Enter for line break
                    </span>
                  </div>

                  {isGenerating ? (
                    <button
                      onClick={cancelStream}
                      className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium flex items-center space-x-1 transition-colors"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>Stop</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSubmitPrompt()}
                      disabled={!inputPrompt.trim() && pendingAttachments.length === 0}
                      className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white text-xs font-medium flex items-center space-x-1 transition-colors shadow-sm"
                    >
                      <span>Send</span>
                      <Send className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* GitHub Export Modal */}
      {isGithubModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-md space-y-5 shadow-2xl relative text-left animate-in fade-in zoom-in-95 duration-150">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center space-x-3">
                <div className="p-2 rounded-xl bg-zinc-800 text-white border border-zinc-700">
                  <Github className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Push to GitHub</h3>
                  <p className="text-xs text-zinc-400">Export sandboxed project files to a GitHub repo</p>
                </div>
              </div>
              <button
                onClick={() => setIsGithubModalOpen(false)}
                className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleGithubExport} className="space-y-4">
              
              {/* Personal Access Token Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  GitHub Personal Access Token (PAT)
                </label>
                <input
                  type="password"
                  value={githubPat}
                  onChange={(e) => setGithubPat(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  required
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 text-xs focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                />
                <p className="text-[11px] text-zinc-500">
                  Saved securely in browser local storage for future pushes.
                </p>
              </div>

              {/* Repository Name Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  Repository Name
                </label>
                <input
                  type="text"
                  value={githubRepoName}
                  onChange={(e) => setGithubRepoName(e.target.value)}
                  placeholder="my-ecomgear-app"
                  required
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 text-xs focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                />
              </div>

              {/* Private Repository Toggle */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="space-y-0.5">
                  <span className="text-xs font-semibold text-zinc-200">Private Repository</span>
                  <p className="text-[11px] text-zinc-400">Only visible to your GitHub account</p>
                </div>
                <input
                  type="checkbox"
                  checked={githubIsPrivate}
                  onChange={(e) => setGithubIsPrivate(e.target.checked)}
                  className="h-4 w-4 rounded bg-zinc-900 border-zinc-700 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
              </div>

              {/* Modal Actions */}
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsGithubModalOpen(false)}
                  className="px-4 py-2 text-xs rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isExportingGithub}
                  className="px-5 py-2 text-xs rounded-xl font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20 transition-all flex items-center space-x-2 disabled:opacity-50"
                >
                  {isExportingGithub ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Exporting Repo...</span>
                    </>
                  ) : (
                    <>
                      <Github className="w-3.5 h-3.5" />
                      <span>Create & Push Repo</span>
                    </>
                  )}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}
    </div>
  );
}
