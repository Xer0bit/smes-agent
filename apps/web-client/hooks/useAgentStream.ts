import { useState, useRef, useCallback, useEffect } from 'react';
import { toast } from 'sonner';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  images?: string[]; // Base64 data URIs for vision model rendering
}

export interface UseAgentStreamReturn {
  isGenerating: boolean;
  chatMessages: ChatMessage[];
  activeToolCall: string | null;
  followUpSuggestions: string[];
  pendingAttachments: File[];
  addAttachment: (file: File) => void;
  removeAttachment: (index: number) => void;
  clearAttachments: () => void;
  files: Record<string, string>;
  activeFilePath: string;
  activeFileContent: string;
  activeFileLanguage: string;
  previewPort: number;
  startAgentStream: (prompt: string) => Promise<void>;
  cancelStream: () => void;
  selectFile: (filePath: string) => void;
  updateFileContent: (filePath: string, newContent: string) => void;
}

/**
 * Translates raw tool call payloads into human-readable narrative text.
 */
function translateToolIntent(toolName: string, args?: Record<string, any>): string {
  if (!toolName) return '⚙️ Processing request...';
  
  const targetPath = args?.path || args?.filePath || args?.file || '';
  
  switch (toolName) {
    case 'write_file':
      return `✨ Scaffolding ${targetPath || 'new file'}...`;
    case 'edit_file':
      return `⚡ Refactoring ${targetPath || 'existing file'}...`;
    case 'read_file':
      return `🔍 Inspecting codebase ${targetPath ? `(${targetPath})` : ''}...`;
    case 'run_command':
    case 'exec_command':
      return `🚀 Executing command: ${args?.command || args?.cmd || 'task'}...`;
    case 'validate_ast':
    case 'run_ast_validation':
      return `🛡️ Validating TypeScript AST safeguards...`;
    case 'list_dir':
      return `📁 Scanning project directory layout...`;
    case 'think':
      return `🧠 Reasoning about workspace architecture...`;
    default:
      return `⚙️ Executing tool: ${toolName}...`;
  }
}

/**
 * Helper to convert a File to a base64 Data URI asynchronously.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read image attachment as base64 data URI'));
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

function inferLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
      return 'markdown';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

const DEFAULT_FILES: Record<string, string> = {
  'src/App.tsx': `import React from 'react';

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl space-y-4">
        <div className="h-10 w-10 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold">
          eCG
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">eComGear Workspace Ready</h1>
        <p className="text-sm text-slate-400">
          Your MicroVM sandbox environment is initialized. Drag-and-drop UI wireframes or prompts to start building.
        </p>
      </div>
    </div>
  );
}
`,
  'src/index.css': `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
  'package.json': `{
  "name": "ecomgear-sandbox-project",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
`,
};

export function useAgentStream(projectId: string): UseAgentStreamReturn {
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const [followUpSuggestions, setFollowUpSuggestions] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  
  // Workspace files state
  const [files, setFiles] = useState<Record<string, string>>(DEFAULT_FILES);
  const [activeFilePath, setActiveFilePath] = useState<string>('src/App.tsx');
  const [previewPort, setPreviewPort] = useState<number>(3000);

  // Active streaming refs
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const assistantBufferRef = useRef<string>('');

  const cancelStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
    setActiveToolCall(null);
  }, []);

  useEffect(() => {
    return () => {
      cancelStream();
    };
  }, [cancelStream]);

  const addAttachment = useCallback((file: File) => {
    if (file && file.type.startsWith('image/')) {
      setPendingAttachments((prev) => [...prev, file]);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachments = useCallback(() => {
    setPendingAttachments([]);
  }, []);

  const selectFile = useCallback((filePath: string) => {
    if (filePath && files[filePath] !== undefined) {
      setActiveFilePath(filePath);
    }
  }, [files]);

  const updateFileContent = useCallback((filePath: string, newContent: string) => {
    setFiles((prev) => ({
      ...prev,
      [filePath]: newContent,
    }));
  }, []);

  const startAgentStream = useCallback(async (promptText: string) => {
    if ((!promptText.trim() && pendingAttachments.length === 0) || isGenerating) return;

    // 1. Process image attachments asynchronously to base64 data URIs
    let base64Images: string[] = [];
    if (pendingAttachments.length > 0) {
      try {
        base64Images = await Promise.all(pendingAttachments.map(fileToBase64));
      } catch (err) {
        console.error('[useAgentStream] Image base64 conversion failed:', err);
      }
    }

    // 2. Add User Message with images
    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: promptText || (base64Images.length ? '[Attached Vision Reference Image(s)]' : ''),
      images: base64Images.length > 0 ? base64Images : undefined,
      timestamp: Date.now(),
    };

    // 3. Prepare Assistant Message Placeholder
    const assistantMsgId = `assistant-${Date.now()}`;
    activeAssistantMessageIdRef.current = assistantMsgId;
    assistantBufferRef.current = '';

    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    setChatMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setIsGenerating(true);
    setActiveToolCall(base64Images.length ? '🖼️ Processing Vision Model context...' : '🧠 Initializing agent planning loop...');
    setFollowUpSuggestions([]);
    setPendingAttachments([]); // Clear pending attachments state after submitting

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/api/v1/ai/agent-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          projectId,
          prompt: promptText,
          images: base64Images,
          files,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        let errorData: any = null;
        try {
          errorData = await response.clone().json();
        } catch {
          // Response body may not be JSON
        }

        if (response.status === 403 || errorData?.code === 'USAGE_LIMIT_EXCEEDED') {
          toast.error('Free tier limit reached. Please upgrade to Pro to continue generating code.', {
            action: {
              label: 'Upgrade to Pro',
              onClick: () => {
                window.location.href = '/billing';
              },
            },
            duration: 10000,
          });

          setChatMessages((prev) => prev.filter((msg) => msg.id !== assistantMsgId));
          setIsGenerating(false);
          setActiveToolCall(null);
          return;
        }

        throw new Error(errorData?.error || `Server returned HTTP status ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const rawEvent of events) {
          if (!rawEvent.trim()) continue;

          let eventName = 'message';
          let dataStr = '';

          const lines = rawEvent.split('\n');
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }

          let payload: any = null;
          if (dataStr) {
            try {
              payload = JSON.parse(dataStr);
            } catch {
              payload = dataStr;
            }
          }

          switch (eventName) {
            case 'start':
              setActiveToolCall(null);
              break;

            case 'text-delta':
              if (payload?.text || typeof payload === 'string') {
                const delta = typeof payload === 'string' ? payload : payload.text;
                assistantBufferRef.current += delta;
                
                const currentContent = assistantBufferRef.current;
                setChatMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId ? { ...msg, content: currentContent } : msg
                  )
                );
              }
              break;

            case 'tool-call':
              if (payload?.toolName || payload?.name) {
                const toolName = payload.toolName || payload.name;
                const toolArgs = payload.args || payload.input || {};
                const narrative = translateToolIntent(toolName, toolArgs);
                setActiveToolCall(narrative);
              }
              break;

            case 'tool-output':
              setActiveToolCall(null);
              if (payload?.path && typeof payload?.content === 'string') {
                const { path: p, content: c } = payload;
                setFiles((prev) => ({ ...prev, [p]: c }));
                setActiveFilePath(p);
              } else if (payload?.files && Array.isArray(payload.files)) {
                setFiles((prev) => {
                  const updated = { ...prev };
                  for (const f of payload.files) {
                    if (f.path && typeof f.content === 'string') {
                      updated[f.path] = f.content;
                    }
                  }
                  return updated;
                });
              }
              break;

            case 'step-finish':
              if (payload?.suggested_actions && Array.isArray(payload.suggested_actions)) {
                setFollowUpSuggestions(payload.suggested_actions);
              } else if (payload?.status?.suggestedActions) {
                setFollowUpSuggestions(payload.status.suggestedActions);
              }
              break;

            case 'done':
              setIsGenerating(false);
              setActiveToolCall(null);
              if (payload?.filesToWrite && Array.isArray(payload.filesToWrite)) {
                setFiles((prev) => {
                  const updated = { ...prev };
                  for (const f of payload.filesToWrite) {
                    if (f.path && typeof f.content === 'string') {
                      updated[f.path] = f.content;
                    }
                  }
                  return updated;
                });
              }
              if (payload?.port) {
                setPreviewPort(payload.port);
              }
              break;

            case 'ecomgear:hmr-error':
            case 'error':
              setIsGenerating(false);
              setActiveToolCall(null);
              const errorText = payload?.message || payload?.error || 'A stream error occurred.';
              setChatMessages((prev) => [
                ...prev,
                {
                  id: `error-${Date.now()}`,
                  role: 'assistant',
                  content: `⚠️ **Runtime Alert:** ${errorText}`,
                  timestamp: Date.now(),
                },
              ]);
              break;
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('[useAgentStream] SSE Fetch error:', err);
        setChatMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: `⚠️ Connection disrupted: ${err.message || 'Stream failed to connect.'}`,
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      setIsGenerating(false);
      setActiveToolCall(null);
      abortControllerRef.current = null;
    }
  }, [projectId, files, pendingAttachments, isGenerating]);

  const activeFileContent = files[activeFilePath] ?? '';
  const activeFileLanguage = inferLanguageFromPath(activeFilePath);

  return {
    isGenerating,
    chatMessages,
    activeToolCall,
    followUpSuggestions,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    files,
    activeFilePath,
    activeFileContent,
    activeFileLanguage,
    previewPort,
    startAgentStream,
    cancelStream,
    selectFile,
    updateFileContent,
  };
}
