import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, StopCircle, ChevronDown, Zap, Paperclip, X, FileText, Image as ImageIcon, RotateCcw, Sparkles, Bot, ClipboardList } from 'lucide-react';
import ecgAgentLogo from '@/assets/ecgagent.png';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { streamAgentGeneration } from '@/eCG/UserPrompt/agentStreamService';
import type { StepFinishData } from '@/eCG/UserPrompt/agentStreamService';
import { ChatMessage } from '@/components/ChatMessage';
import { getGenServerUrl, getGenServerCandidateUrls } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';
import { messageService } from '@/eCG/UserPrompt/messageService';
import { uploadChatAttachment, isAllowedFile, formatFileSize, type ChatAttachment } from '@/services/chatAttachmentService';
import { useUsage } from '@/contexts/UsageContext';
import type { StepEntry, LiveFileChange, Message } from '../_utils_/agentChatHelpers';
import {
  extractSummary,
  parseToolActivities,
  buildFallbackSummary,
  detectLiveTool,
  parseCommandSuggestions,
  stripEcomgearTags,
  filePathToLabel,
} from '../_utils_/agentChatHelpers';

// ─── Component ────────────────────────────────────────────────────────────────

interface AgentChatPanelProps {
  projectId: string;
  userId: string;
  currentOrganizationId?: string | null;
  onFilesGenerated?: (files: { path: string; content: string }[], filesToDelete?: string[], previewPushed?: boolean) => void;
  onGenerationComplete?: (tokensUsed: number) => void;
  /** Called with the real token count once the server resolves usage (fires after onGenerationComplete) */
  onUsage?: (tokensUsed: number) => void;
  isMinimized?: boolean;
  /** When set, automatically send this prompt to the agent (e.g. from Repair button). */
  triggerPrompt?: string | null;
  /** Chat-message label shown for the auto-sent triggerPrompt. Defaults to the repair-flow label. */
  triggerDisplayText?: string;
  /** Called once after triggerPrompt has been consumed so the parent can clear it. */
  onTriggerConsumed?: () => void;
  /** Called when user clicks a preview command button (e.g. 'restart', 'refresh'). */
  onPreviewCommand?: (cmd: string) => void;
  /** Called with each text-delta chunk as it streams from the agent. */
  onAgentStreamText?: (chunk: string) => void;
  /** Called when the stream resets (new generation started). */
  onAgentStreamClear?: () => void;
  /** Called when the agent starts installing an npm dependency mid-run, so the
   * preview can show an "installing" state instead of a false build error. */
  onDependencyInstallStart?: () => void;
}

export const AgentChatPanel: React.FC<AgentChatPanelProps> = ({
  projectId,
  userId,
  currentOrganizationId,
  onFilesGenerated,
  onGenerationComplete,
  onUsage,
  isMinimized = false,
  triggerPrompt,
  triggerDisplayText,
  onTriggerConsumed,
  onPreviewCommand,
  onAgentStreamText,
  onAgentStreamClear,
  onDependencyInstallStart,
}) => {
  const GREETING: Message = {
    id: 'greeting',
    role: 'assistant',
    content:
      "Welcome to **EcomGear App Builder**",
    status: 'complete',
  };

  const MAX_INPUT_CHARS = 4000;

  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  // The agent's real internal reasoning (the `think` tool's actual argument)  
  // shown live only, cleared on the next step/completion, never saved to the
  // persisted chat transcript.
  const [liveThought, setLiveThought] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [stepCount, setStepCount] = useState(0);
  // Timestamp until which LLM-generated statuses block lower-priority overrides.
  const llmStatusLockedUntil = useRef<number>(0);
  const [liveFiles, setLiveFiles] = useState<LiveFileChange[]>([]);
  const [filesWritten, setFilesWritten] = useState(0);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [agentMode, setAgentMode] = useState<'agent' | 'plan'>(() => {
    try {
      const saved = localStorage.getItem('ecomgear:agentMode');
      return saved === 'plan' ? 'plan' : 'agent';
    } catch { return 'agent'; }
  });

  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pagination state for chat history
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const oldestTimestampRef = useRef<string | null>(null);
  // Tracks consecutive auto-repair escalations from the frontend (after server repair exhausted).
  // Resets to 0 on any successful build. Capped at 2 to prevent infinite repair loops.
  const autoRepairCountRef = useRef<number>(0);

  const pushStatus = (message: string, isLLM = false, force = false) => {
    if (!isLLM && !force && Date.now() < llmStatusLockedUntil.current) return;
    if (isLLM) llmStatusLockedUntil.current = Date.now() + 4000;
    setStatusText((prev) => (prev === message ? prev : message));
  };

  const startProgressFeedback = () => {
    setStatusText('');
    setThinkingText('');
    setLiveThought('');
    setStepCount(0);
    setLiveFiles([]);
    setFilesWritten(0);
    llmStatusLockedUntil.current = 0;
    // Start elapsed seconds counter
    setElapsedSeconds(0);
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    elapsedIntervalRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
  };

  // ── Stop elapsed timer when generation ends ───────────────────────────────
  useEffect(() => {
    if (!isGenerating && elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, [isGenerating]);

  // Persist plan/build mode across refreshes
  useEffect(() => {
    try { localStorage.setItem('ecomgear:agentMode', agentMode); } catch {}
  }, [agentMode]);

  // ── Auto-trigger from external prompt (e.g. Repair button) ──────────────
  useEffect(() => {
    if (!triggerPrompt || isGenerating) return;
    onTriggerConsumed?.();
    handleSubmit(triggerPrompt, triggerDisplayText || '🔧 Repair request', 'build');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerPrompt]);

  // ── Eco usage ──────────────────────────────────────────────────────────────
  const { refreshUsage, isWithinLimit, applyUsageDelta } = useUsage();

  // ── Detect guest mode from userId ──────────────────────────────────────────
  const isGuest = userId.startsWith('guest:');
  const guestFingerprint = isGuest ? userId.slice('guest:'.length) : undefined;

  // Model is now auto-selected server-side based on request tier and user plan.

  // ── Load message history ──────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    // Guests have no persisted history
    if (isGuest) { setMessages([GREETING]); return; }
    // Guard: if the component unmounts or projectId changes before the async
    // load completes, don't overwrite whatever state is current (which may
    // include an in-flight generation the user started before history arrived).
    let cancelled = false;
    (async () => {
      try {
        // Ensure a valid session before querying   on page refresh the token
        // may be stale and getSession() returns null until the refresh completes.
        // Try getSession() first; if null, call refreshSession() once before giving up.
        let { data: { session } } = await lovableCloud.auth.getSession();
        if (!session && !cancelled) {
          const { data: refreshed } = await lovableCloud.auth.refreshSession();
          session = refreshed.session;
        }
        // Still no session   user is truly not logged in; show clean slate but
        // do NOT overwrite an already-populated messages array (e.g. a run is in progress)
        if (!session || cancelled) {
          if (!cancelled) setMessages(prev => prev.length <= 1 ? [GREETING] : prev);
          return;
        }
        const { messages: history, hasMore } = await messageService.loadRecentMessages(projectId, 10);
        if (cancelled) return;
        if (history.length === 0) {
          setMessages([GREETING]);
          return;
        }
        // Track oldest timestamp for "load more" cursor
        if (history.length > 0) oldestTimestampRef.current = history[0].created_at;
        setHasMoreMessages(hasMore);

        // Prepend GREETING once, then map DB rows using their real IDs.
        // Strip all ecomgear operational tags from stored content.
        const mapped: Message[] = [
          GREETING,
          ...history.map((m) => {
            if (m.role === 'assistant') {
              const { body, summary } = extractSummary(stripEcomgearTags(m.content));
              return { id: m.id, role: 'assistant' as const, content: body, status: 'complete' as const, summary };
            }
            // Map DB attachments to the ChatAttachment shape for rendering.
            // Use the permanent publicUrl as the previewUrl (no blob URL needed
            //   the image loads directly from Supabase Storage).
            const dbAttachments = (m.attachments ?? []).map(a => ({
              id: m.id,
              name: a.name,
              size: a.size,
              type: a.type,
              previewUrl: a.url,
              tempPath: '',
              publicUrl: a.url,
              category: a.category,
            }));
            return {
              id: m.id,
              role: 'user' as const,
              content: m.content,
              status: 'complete' as const,
              ...(dbAttachments.length > 0 ? { attachments: dbAttachments } : {}),
            };
          }),
        ];
        setMessages(mapped);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load message history', err);
        // Don't wipe existing messages on a transient error
        setMessages(prev => prev.length <= 1 ? [GREETING] : prev);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, isGuest]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  // scrollRef points to a plain div with overflow-y:auto   set scrollTop directly.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, statusText]);

  // ── Load older messages when scrolled to top ──────────────────────────────
  const loadMoreMessages = async () => {
    if (!hasMoreMessages || isLoadingMore || !oldestTimestampRef.current || isGuest) return;
    setIsLoadingMore(true);
    try {
      const { messages: older, hasMore } = await messageService.loadMessagesBefore(
        projectId, oldestTimestampRef.current, 20
      );
      if (older.length === 0) { setHasMoreMessages(false); return; }

      oldestTimestampRef.current = older[0].created_at;
      setHasMoreMessages(hasMore);

      const mapped: Message[] = older.map((m) => {
        if (m.role === 'assistant') {
          const { body, summary } = extractSummary(stripEcomgearTags(m.content));
          return { id: m.id, role: 'assistant' as const, content: body, status: 'complete' as const, summary };
        }
        const dbAttachments = (m.attachments ?? []).map(a => ({
          id: m.id,
          name: a.name,
          size: a.size,
          type: a.type,
          previewUrl: a.url,
          tempPath: '',
          publicUrl: a.url,
          category: a.category,
        }));
        return {
          id: m.id,
          role: 'user' as const,
          content: m.content,
          status: 'complete' as const,
          ...(dbAttachments.length > 0 ? { attachments: dbAttachments } : {}),
        };
      });

      // Preserve scroll position: save height before prepend, restore delta after
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      setMessages(prev => [...mapped, ...prev]);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (err) {
      console.error('Failed to load older messages', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80 && hasMoreMessages && !isLoadingMore) loadMoreMessages();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreMessages, isLoadingMore, projectId]);

  // ── Close model menu on outside click ────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Cleanup on unmount / project change ──────────────────────────────────
  // Do NOT abort the agent on unmount   it should keep running server-side.
  // Only clear local UI timers. The user can reconnect by navigating back.
  useEffect(() => () => {}, [projectId]);

  // ── Auto-reconnect to active run when loading this project ───────────────
  useEffect(() => {
    if (!projectId || isGuest) return;
    let cancelled = false;

    (async () => {
      try {
        const { data: { session } } = await lovableCloud.auth.getSession();
        if (!session || cancelled) return;

        const urls = getGenServerCandidateUrls(`/api/v1/ai/active-run/${projectId}`);
        for (const url of urls) {
          try {
            const r = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
            if (!r.ok) break;
            const json = await r.json();
            if (cancelled) return;
            if (json.active && !isGenerating) {
              // A run is in progress server-side   reconnect to it
              const asstId = `reconnect-${Date.now()}`;
              setMessages(prev => [...prev, { id: asstId, role: 'assistant', content: '', status: 'pending' }]);
              setIsGenerating(true);
              startProgressFeedback();

              let currentContent = '';
              let toolXmlAccum = '';
              let generationDone = false;

              abortRef.current = new AbortController();
              streamAgentGeneration({
                prompt: '__rejoin__',
                projectId,
                orgId: currentOrganizationId,
                callbacks: {
                  onTextDelta: (chunk) => {
                    if (generationDone || cancelled) return;
                    currentContent += chunk;
                    setMessages(prev => prev.map(m => m.id === asstId
                      ? { ...m, content: stripEcomgearTags(currentContent), status: 'streaming' }
                      : m));
                  },
                  onToolOutput: (xml) => {
                    if (generationDone || cancelled) return;
                    toolXmlAccum += xml + '\n';
                  },
                  onStepFinish: (stepData: StepFinishData) => {
                    if (generationDone || cancelled) return;
                    if (stepData.step > 0) setStepCount(stepData.step);
                    const isLLMStatus = stepData.step === 0 && stepData.toolCount === 0;
                    if (stepData.status) pushStatus(stepData.status, isLLMStatus);
                  },
                  onAgentNarration: (narration) => {
                    if (generationDone || cancelled) return;
                    pushStatus(narration, true, true);
                  },
                  onDone: (result) => {
                    generationDone = true;
                    setIsGenerating(false);
                    setStatusText('');
                    setThinkingText('');
                    setStepCount(0);
                    setLiveFiles([]);
                    setFilesWritten(0);
                    const rawContent = currentContent || result.summary || '';
                    const { body: finalContent, summary } = extractSummary(stripEcomgearTags(rawContent));
                    const toolActivities = parseToolActivities(toolXmlAccum || rawContent);
                    const displayContent = finalContent || buildFallbackSummary(toolActivities) || 'Something went wrong   please try again.';
                    setMessages(prev => prev.map(m => m.id === asstId
                      ? { ...m, status: 'complete', content: displayContent, summary, toolActivities, snapshotId: result.snapshotId }
                      : m));
                    if (onFilesGenerated && (result.filesToWrite?.length > 0 || result.filesToDelete?.length > 0)) {
                      onFilesGenerated(
                        (result.filesToWrite ?? []).map((f: { path: string; content: string | Buffer }) => ({
                          path: f.path,
                          content: typeof f.content === 'string' ? f.content : '',
                        })),
                        result.filesToDelete ?? [],
                        result.previewPushed === true
                      );
                    }
                    onGenerationComplete?.(result.tokensUsed ?? 0);
                    if (!isGuest) refreshUsage().catch(() => {});
                    if (!isGuest && result.ecoUsed && result.ecoUsed > 0) {
                      toast.success(`Used ${result.ecoUsed.toFixed(1)} eco`, { duration: 3000 });
                    }
                  },
                  onError: () => {
                    if (cancelled) return;
                    setIsGenerating(false);
                    setStatusText('');
                    setStepCount(0);
                    setLiveFiles([]);
                    setFilesWritten(0);
                    setMessages(prev => prev.filter(m => m.id !== asstId));
                  },
                },
                signal: abortRef.current.signal,
              }).catch(() => {
                if (!cancelled) {
                  setIsGenerating(false);
                  setMessages(prev => prev.filter(m => m.id !== asstId));
                }
              });
            }
            break;
          } catch { break; }
        }
      } catch { /* ignore */ }
    })();

    return () => {
      cancelled = true;
      // Abort any in-flight SSE stream so a stale project's events don't
      // bleed into the next project's chat panel when the user switches projects.
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ── File attachment handlers ──────────────────────────────────────────────
  const handleFiles = async (files: FileList | File[]) => {
    if (isGuest) { toast.error('Sign up to attach files'); return; }
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    for (const file of fileArray) {
      const check = isAllowedFile(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }

      setUploadingCount(prev => prev + 1);
      try {
        const attachment = await uploadChatAttachment(file, userId, projectId);
        setPendingAttachments(prev => [...prev, attachment]);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        toast.error(`Failed to upload ${file.name}: ${message}`);
      } finally {
        setUploadingCount(prev => prev - 1);
      }
    }
  };

  const removePendingAttachment = (id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (overridePrompt?: string, displayText?: string, forcedMode?: 'build' | 'plan', isAutoFix?: boolean) => {
    const raw = (overridePrompt ?? input).trim();
    const hasAttachments = !overridePrompt && pendingAttachments.length > 0;
    if ((!raw && !hasAttachments) || isGenerating || !projectId) return;

    // Eco gate   block non-guest users who are at their daily limit
    if (!isGuest && !isWithinLimit()) {
      toast.error('Monthly eco limit reached. Please upgrade your plan or wait for the reset.');
      return;
    }

    if (!overridePrompt) setInput('');

    // Capture and clear pending attachments
    const messageAttachments = !overridePrompt ? [...pendingAttachments] : [];
    if (!overridePrompt) setPendingAttachments([]);

    const effectivePrompt = raw || (messageAttachments.length > 0 ? 'Please review the attached files.' : '');

    // When in plan mode and user types an execution confirmation ("execute", "apply",
    // "do it", etc.), automatically switch to build mode so the agent actually makes
    // the changes instead of producing another plan response.
    const EXECUTE_RE = /^(execute|apply|do\s+it|go\s+ahead|proceed|yes|confirm|run|ship\s+it|make\s+(the\s+)?changes|ok\s+do\s+it|let'?s?\s+(do\s+it|go)|build\s+it)/i;
    const isExecuteCmd = !forcedMode && agentMode === 'plan' && EXECUTE_RE.test(raw);
    if (isExecuteCmd) setAgentMode('agent');
    const resolvedMode: 'build' | 'plan' | undefined = forcedMode ?? (isExecuteCmd ? 'build' : agentMode === 'plan' ? 'plan' : undefined);

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: displayText ?? raw,
      status: 'complete',
      attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
    };
    const asstId = (Date.now() + 1).toString();
    const asstMsg: Message = { id: asstId, role: 'assistant', content: '', status: 'pending' };

    setMessages(prev => [...prev, userMsg, asstMsg]);
    setIsGenerating(true);
    startProgressFeedback();

    // Optimistic eco display: increment counter by 1 immediately so the header
    // stays in sync without waiting for refreshUsage() after generation ends.
    if (!isGuest) applyUsageDelta(1);

    // Persist user message (skip for guests   no DB project row)
    if (!isGuest) {
      const attachmentsForDb = messageAttachments
        .filter(a => a.publicUrl)
        .map(a => ({ name: a.name, size: a.size, type: a.type, url: a.publicUrl, category: a.category }));
      messageService.saveUserMessage(projectId, raw, userId, attachmentsForDb.length > 0 ? attachmentsForDb : undefined).catch(err => {
        console.error('Failed to save user message', err);
        toast.error('Message could not be saved. Check your connection.');
      });
    }

    // ── Build conversation history ─────────────────────────────────────────
    // Grab all real turns (skip the static GREETING, skip the two new stubs
    // we just added).  Only include 'complete' messages so we never send
    // partial/pending/error turns as context.
    const HISTORY_WINDOW = 6;   // messages to send in full  (3 exchanges)
    const completedTurns = messages.filter(
      m => m.id !== 'greeting' && m.status === 'complete' && m.content.trim()
    );

    // Split: recent goes in full, older gets condensed to a summary line
    const recentTurns = completedTurns.slice(-HISTORY_WINDOW);
    const olderTurns  = completedTurns.slice(0, -HISTORY_WINDOW);

    const history = recentTurns.map(m => ({
      role: m.role as 'user' | 'assistant',
      // Content is already cleaned (ecomgear tags stripped on save/load)
      content: m.content,
    }));

    // Compress older turns into a structured summary to give the server stable,
    // verifiable context without hallucination from narrative-only chips.
    // Combines: verified file changes from tool activities + user constraints + summary chips.
    const olderSummary = olderTurns.length > 0
      ? (() => {
          // Collect verified file changes from tool activities (ground truth   not LLM narrative)
          const filesChanged: string[] = [];
          const constraints: string[] = [];

          for (const m of olderTurns) {
            if (m.role === 'assistant' && m.toolActivities) {
              for (const act of m.toolActivities) {
                if (act.type === 'write' || act.type === 'edit') {
                  filesChanged.push(act.label);
                }
              }
            }
            if (m.role === 'user') {
              const text = m.content.trim();
              if (/\b(keep|make sure|don't|do not|always|never|must|should)\b/i.test(text)) {
                constraints.push(text.slice(0, 100));
              }
            }
          }

          const structuredLines: string[] = [];
          const uniqueFiles = [...new Set(filesChanged)];
          if (uniqueFiles.length > 0) {
            structuredLines.push(`Files modified in earlier turns: ${uniqueFiles.slice(0, 20).join(', ')}`);
          }
          if (constraints.length > 0) {
            structuredLines.push(`User constraints to maintain: ${[...new Set(constraints)].slice(0, 3).join(' | ')}`);
          }

          // Also include assistant summary chips as narrative context fallback
          const summaryChips = olderTurns
            .filter(m => m.role === 'assistant')
            .map(m => `• ${m.summary || m.content.split('\n')[0].slice(0, 80)}`)
            .join('\n');

          return structuredLines.length > 0
            ? `${structuredLines.join('\n')}\n\nEarlier responses:\n${summaryChips}`
            : summaryChips;
        })()
      : undefined;

    let currentContent = '';
    // Accumulate XML from tool-output events (write_file / delete_file / rename_file).
    // This is the real source for toolActivities chips   the text-delta stream
    // almost never contains <ecomgear-*> tags when the agent uses tool calls.
    let toolXmlAccum = '';
    // Guard: once 'done' is received, ignore any late text-delta events.
    let generationDone = false;
    // Step-by-step history   survives after completion (unlike statusText/liveFiles,
    // which are wiped), rendered alongside the single-line status ticker, not instead of it.
    const stepsAccum: StepEntry[] = [];
    const syncSteps = () => {
      const snapshot = [...stepsAccum];
      setMessages(prev => prev.map(m => (m.id === asstId ? { ...m, steps: snapshot } : m)));
    };

    try {
      abortRef.current = new AbortController();
      await streamAgentGeneration({
        prompt: effectivePrompt,
        projectId,
        orgId: currentOrganizationId,
        mode: resolvedMode,
        history,
        olderSummary,
        fingerprint: guestFingerprint,
        // The auto-fix follow-up fires right after the run that triggered it
        // ends   the server can still be mid-cleanup (restore-push retries,
        // async lock release) for several seconds after the client sees the
        // stream close. Retry silently on PROJECT_LOCKED instead of showing
        // the user an alarming "another generation is running" error for a
        // race the system itself created.
        retryOnLock: isAutoFix,
        attachments: messageAttachments.length > 0
          ? messageAttachments.map(a => ({
              name: a.name,
              type: a.type,
              category: a.category,
              tempPath: a.tempPath,
            }))
          : undefined,
        callbacks: {
          onOpen: () => {
            onAgentStreamClear?.();
            // Honest initial state   the real per-step status arrives within
            // a moment via onStepFinish / step-status-refine. Never show a
            // fake "Working on your request" headline.
            pushStatus('Starting…');
          },
          onTextDelta: (chunk) => {
            if (generationDone) return;          // drop late post-done events
            onAgentStreamText?.(chunk);
            currentContent += chunk;
            const displayContent = stripEcomgearTags(currentContent);

            // Capture real streamed text for the thinking display.
            // Strip XML tags and take the last meaningful line being typed.
            const liveTool = detectLiveTool(currentContent);
            if (liveTool) {
              pushStatus(liveTool);
            } else {
              const clean = displayContent.replace(/<[^>]+>/g, '').trim();
              if (clean.length > 0) {
                // Last non-empty line the LLM is currently writing
                const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
                const last = lines[lines.length - 1] ?? '';
                setThinkingText(last.slice(-80)); // cap at 80 chars
              }
            }

            setMessages(prev =>
              prev.map(m =>
                m.id === asstId ? { ...m, content: displayContent, status: 'streaming' } : m
              )
            );
          },
          onToolOutput: (xml) => {
            if (generationDone) return;
            toolXmlAccum += xml + '\n';

            // Track live file changes
            const writeMatch = /ecomgear-write[^>]*\bpath="([^"]+)"/.exec(xml);
            const editMatch = /ecomgear-edit[^>]*\bpath="([^"]+)"/.exec(xml);
            const deleteMatch = /ecomgear-delete[^>]*\bpath="([^"]+)"/.exec(xml);
            const renameMatch = /ecomgear-rename[^>]*\bfrom="([^"]+)"/.exec(xml);
            const depMatch = /ecomgear-add-dependency[^>]*\bpackages="([^"]+)"/.exec(xml);

            // These template labels are a placeholder only   never force, so
            // real LLM narration (onAgentNarration/onStepStatusRefine) always
            // wins the live status ticker instead of being clobbered by them.
            // They still go into stepsAccum, which is the persistent step
            // history list, not the live headline.
            if (writeMatch) {
              const label = `Building ${filePathToLabel(writeMatch[1])}...`;
              pushStatus(label);
              setLiveFiles(prev => [...prev, { path: writeMatch[1], type: 'write', timestamp: Date.now() }]);
              setFilesWritten(prev => prev + 1);
              stepsAccum.push({ type: 'write', label, done: true });
            } else if (editMatch) {
              const label = `Updating ${filePathToLabel(editMatch[1])}...`;
              pushStatus(label);
              setLiveFiles(prev => [...prev, { path: editMatch[1], type: 'edit', timestamp: Date.now() }]);
              setFilesWritten(prev => prev + 1);
              stepsAccum.push({ type: 'edit', label, done: true });
            } else if (deleteMatch) {
              const label = `Removing ${filePathToLabel(deleteMatch[1])}...`;
              pushStatus(label);
              setLiveFiles(prev => [...prev, { path: deleteMatch[1], type: 'delete', timestamp: Date.now() }]);
              stepsAccum.push({ type: 'delete', label, done: true });
            } else if (renameMatch) {
              const label = `Renaming ${filePathToLabel(renameMatch[1])}...`;
              pushStatus(label);
              setLiveFiles(prev => [...prev, { path: `${renameMatch[1]} → ${renameMatch[2]}`, type: 'rename', timestamp: Date.now() }]);
              stepsAccum.push({ type: 'rename', label, done: true });
            } else if (depMatch) {
              const label = `Installing ${depMatch[1]}...`;
              pushStatus(label);
              onDependencyInstallStart?.();
              setLiveFiles(prev => [...prev, { path: depMatch[1], type: 'dependency', timestamp: Date.now() }]);
              stepsAccum.push({ type: 'dependency', label, done: true });
            } else {
              pushStatus('Applying changes…');
            }
            syncSteps();
          },
          onStepFinish: (stepData: StepFinishData) => {
            if (generationDone) return;
            if (stepData.step > 0) setStepCount(stepData.step);
            // Clear the live thought once the agent moves past thinking into a real
            // action step, so it doesn't linger stale behind a "Building X..." status.
            if (!stepData.tools.includes('think')) setLiveThought('');
            const isLLMStatus = stepData.step === 0 && stepData.toolCount === 0;
            // File-op steps already got their own permanent entry from onToolOutput
            // above. A narrative-only step (think, or any step with no file-changing
            // tool call) is shown live in the status ticker ONLY   it never gets a
            // permanent stepsAccum entry, so the saved chat transcript isn't cluttered
            // with a growing list of "thinking about X..." lines that never go away.
            if (stepData.status) {
              pushStatus(stepData.status, isLLMStatus);
            } else if (stepData.toolCount > 0) {
              pushStatus('Reviewing generated changes...');
            }
          },
          onStepStatusRefine: ({ status }) => {
            // A cheap-model-generated description of what the step actually did,
            // replacing the rule-based canned phrase once it resolves (feature/build
            // tiers only   see generateDynamicStepStatus on the server). Live ticker
            // only, same as onStepFinish above   never saved to the permanent history.
            if (generationDone) return;
            pushStatus(status, true, true);
          },
          onAgentNarration: (narration) => {
            // Real-time, LLM-written description of what the agent is doing RIGHT
            // NOW (from the narration microservice). Highest priority   force-push
            // so it always wins as the live headline, overriding canned strings.
            if (generationDone) return;
            pushStatus(narration, true, true);
          },
          onAgentThinking: ({ thought }) => {
            // The agent's real internal reasoning, live only   replaces the
            // previous thought each time a new `think` step arrives, never
            // accumulates, never gets saved to the persisted message.
            if (generationDone) return;
            setLiveThought(thought);
          },
          onDone: (result) => {
            generationDone = true;             // block any further text-delta updates
            setIsGenerating(false);
            setStatusText('');
            setThinkingText('');
            setLiveThought('');
            setStepCount(0);
            setLiveFiles([]);
            setFilesWritten(0);

            // Prefer full streamed text over backend summary
            const rawContent = currentContent || result.summary || '';
            const { body: strippedContent, summary } = extractSummary(stripEcomgearTags(rawContent));
            const isPlan = result.mode === 'plan'
              || (!result.mode && /reply\s+\*\*execute\*\*/i.test(rawContent) && !overridePrompt);
            // Tool activities come from tool-output XML (accumulated during streaming),
            // not from the text-delta stream which rarely contains ecomgear tags.
            const toolActivities = isPlan ? [] : parseToolActivities(toolXmlAccum || rawContent);
            // Show actual output; if model returned nothing and no tool activity, show a retry hint.
            const finalContent = strippedContent.trim() || result.summary?.trim()
              || buildFallbackSummary(toolActivities)
              || 'The model didn\'t respond. Please try rephrasing your request.';

            const suggestedCommands = isPlan ? [] : parseCommandSuggestions(toolXmlAccum || rawContent);
            const filePaths = (result.filesToWrite ?? []).map((f: { path: string }) => f.path);
            // Detect confirm-first spec: agent described a plan and asked for confirmation
            // (ghostRun=true because no files written yet, but it's not a plan-mode response).
            const isConfirmRequest = !isPlan && result.ghostRun === true &&
              /shall i (start building|begin|proceed|start coding|go ahead)|let me know if you.{0,10}d like (any changes|to (change|adjust))|ready to (start|build)|should i (start|build|proceed)|confirm or adjust/i.test(rawContent);

            // For confirm requests, show fixed chips immediately. For real builds, set null (loading)
            // while Gemini generates contextual suggestions   skeleton chips show in the meantime.
            const initialSuggestions: string[] | null = isConfirmRequest
              ? ['Yes, build it!', 'Make some changes first']
              : !isPlan && filePaths.length > 0 ? null   // null = Gemini loading
              : [];

            const noChanges = !isPlan && !isConfirmRequest && result.ghostRun === true;
            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? { ...m, status: 'complete', content: finalContent, isPlan, noChanges, summary, toolActivities, steps: stepsAccum, snapshotId: result.snapshotId, suggestedCommands, followUpSuggestions: initialSuggestions }
                  : m
              )
            );

            // Fire Gemini suggestion call   replaces null (loading) with real chips when done.
            if (!isConfirmRequest && !isPlan && filePaths.length > 0) {
              fetch(getGenServerUrl('/api/v1/ai/suggestions'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  summary: (summary || finalContent).slice(0, 800),
                  filePaths,
                  userPrompt: effectivePrompt.slice(0, 300),
                }),
              })
                .then(r => r.ok ? r.json() : null)
                .then((data: { suggestions?: string[] } | null) => {
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === asstId
                        ? { ...m, followUpSuggestions: data?.suggestions?.length ? data.suggestions : [] }
                        : m
                    )
                  );
                })
                .catch(() => {
                  // On failure, clear the loading state so skeleton doesn't stay forever
                  setMessages(prev =>
                    prev.map(m => m.id === asstId ? { ...m, followUpSuggestions: [] } : m)
                  );
                });
            }

            // Persist assistant message (skip for guests, save plan messages too)
            if (!isGuest && finalContent.trim()) {
              messageService.saveAssistantMessage(projectId, finalContent, userId).catch(err => {
                console.error('Failed to save assistant message', err);
                toast.error('Message could not be saved. Check your connection.');
              });
            }

            if (!isPlan) {
              if (onFilesGenerated && (result.filesToWrite?.length > 0 || result.filesToDelete?.length > 0)) {
                onFilesGenerated(
                  (result.filesToWrite ?? []).map((f: { path: string; content: string | Buffer }) => ({
                    path: f.path,
                    content: typeof f.content === 'string' ? f.content : '',
                  })),
                  result.filesToDelete ?? [],
                  result.previewPushed === true
                );
              }
              onGenerationComplete?.(result.tokensUsed ?? 0);
              // Refresh eco usage display after generation
              if (!isGuest) refreshUsage().catch(() => {});
              if (!isGuest && result.ecoUsed && result.ecoUsed > 0) {
                toast.success(`Used ${result.ecoUsed.toFixed(1)} eco`, { duration: 3000 });
              }
              if (result.ghostRun) {
                // Agent produced text but wrote no files   this is a normal conversational
                // response (question, clarification, limitation) OR a run that fumbled tool
                // calls and only narrated. Either way, nothing changed: never claim otherwise
                // with a success toast, and never auto-retry here (repair auto-fix only fires
                // via onRepairFailed on real build errors).
              } else {
                autoRepairCountRef.current = 0; // successful build   reset repair counter
                toast.success('App updated.');
              }
            }
          },
          onRepairFailed: (errors) => {
            autoRepairCountRef.current += 1;

            // Cap at 2 consecutive frontend escalations   beyond this the AI is clearly
            // stuck in a loop and further auto-retries will not help.
            if (autoRepairCountRef.current > 2) {
              autoRepairCountRef.current = 0;
              const errorSummary = errors.length > 0
                ? errors.slice(0, 3).map(e => `- ${e.split('\n')[0]}`).join('\n')
                : '- Unknown build error';
              setMessages(prev =>
                prev.map(m =>
                  m.id === asstId
                    ? {
                        ...m,
                        status: 'complete',
                        content: currentContent || `Build errors could not be fixed automatically. Please describe what you'd like to change and I'll try again.\n\n${errorSummary}`,
                      }
                    : m
                )
              );
              return;
            }

            // Server-side auto-repair exhausted   escalate once more with a focused prompt
            const errorList = errors.length > 0
              ? errors.map(e => `- ${e}`).join('\n')
              : '- Unknown build error';
            const autoFixPrompt =
              `The app has build errors that could not be auto-repaired. Please fix all of them now:\n${errorList}\n\nFocus only on these errors. Keep changes minimal.`;
            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? { ...m, status: 'complete', content: currentContent || 'Build errors detected. Attempting auto-fix…' }
                  : m
              )
            );
            // Brief delay so the completed message renders before the new run starts
            setTimeout(() => handleSubmit(autoFixPrompt, '🔧 Auto-fix', 'build', true), 300);
          },
          onError: (errMsg) => {
            setIsGenerating(false);
            setStatusText('');
            setStepCount(0);
            setLiveFiles([]);
            setFilesWritten(0);
            // Show real error so users/devs can diagnose   strip raw HTTP prefix if present
            const display = errMsg
              ? errMsg.replace(/^Agent stream failed \(\d+\):\s*/i, '').slice(0, 300)
              : 'Model temporarily unavailable. Please try again.';
            const errorContent = currentContent || display;
            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? { ...m, status: 'error', content: errorContent, steps: stepsAccum }
                  : m
              )
            );
            toast.error(display);
            // Persist whatever was streamed so far   otherwise a reload silently
            // erases the agent's partial reply, leaving only the user's prompt.
            if (!isGuest && errorContent.trim()) {
              messageService.saveAssistantMessage(projectId, `${errorContent}\n\n*[error]*`, userId).catch(err => {
                console.error('Failed to save partial assistant message on error', err);
              });
            }
          },
          onUsage: (tokensUsed) => {
            onUsage?.(tokensUsed);
          },
        },
        signal: abortRef.current.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setIsGenerating(false);
      setStatusText('');
      setStepCount(0);
      setLiveFiles([]);
      setFilesWritten(0);
      const errDisplay = err instanceof Error
        ? err.message.replace(/^Agent stream failed \(\d+\):\s*/i, '').slice(0, 300)
        : 'Model temporarily unavailable. Please try again.';
      const errorContent = currentContent || errDisplay;
      let alreadyHandled = false;
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== asstId) return m;
          if (m.status === 'error') { alreadyHandled = true; return m; }
          return { ...m, status: 'error', content: errorContent, steps: stepsAccum };
        })
      );
      toast.error(errDisplay);
      if (!alreadyHandled && !isGuest && errorContent.trim()) {
        messageService.saveAssistantMessage(projectId, `${errorContent}\n\n*[error]*`, userId).catch(err2 => {
          console.error('Failed to save partial assistant message on error', err2);
        });
      }
    }
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
    setStatusText('');
    setStepCount(0);
    setLiveFiles([]);
    setFilesWritten(0);
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && (last.status === 'pending' || last.status === 'streaming')) {
        const cancelledContent = `${last.content || ''}\n\n*Cancelled.*`;
        // Persist whatever was streamed so far   otherwise a reload silently
        // erases the agent's partial reply, leaving only the user's prompt.
        if (!isGuest && (last.content || '').trim()) {
          messageService.saveAssistantMessage(projectId, cancelledContent, userId).catch(err => {
            console.error('Failed to save partial assistant message on cancel', err);
          });
        }
        return prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, status: 'error', content: cancelledContent }
            : m
        );
      }
      return prev;
    });
  };

  const executePlan = (planContent: string) => {
    setAgentMode('agent');
    handleSubmit(`Execute the following plan:\n\n${planContent}`, 'Execute plan', 'build');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      setAgentMode(m => m === 'plan' ? 'agent' : 'plan');
    }
  };

  if (isMinimized) return null;

  // Honest fallback   only used for the very first frame before any step
  // status arrives. Once the server emits a step/status this is replaced.
  const statusLabel = statusText || 'Starting…';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full w-full" style={{ background: 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(99,102,241,0.04) 0%, transparent 70%), #09090b' }}>

      {/* ── Header ── */}
      <div>
        <div className="flex items-center gap-0.5">
          {isGenerating && (
            <button
              onClick={cancelGeneration}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-400/10 transition-colors"
            >
              <StopCircle className="w-3 h-3" /> Stop
            </button>
          )}
        </div>
      </div>

      {/* ── Screen-reader announcer   decoupled from the visual ticker below ──
          so SR announcements aren't fighting the visual animate-status-in
          re-mount on every update. Visually hidden; the sighted ticker
          further down is aria-hidden so nothing gets announced twice. */}
      <div aria-live="polite" className="sr-only">
        {isGenerating ? (statusLabel || 'Working…') : ''}
      </div>

      {/* ── Messages   plain div so scrollTop works directly ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0" aria-busy={isGenerating}>
        <div className="px-3 py-3 space-y-3">
          {/* Load-more indicator at top */}
          {isLoadingMore && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-400/60" />
            </div>
          )}
          {!isLoadingMore && hasMoreMessages && (
            <button
              onClick={loadMoreMessages}
              className="w-full text-center text-[11px] text-indigo-400/50 hover:text-indigo-300/80 py-1 transition-colors"
            >
              ↑ Load older messages
            </button>
          )}
          {messages.map((msg, msgIndex) => (
            <div key={msg.id} className="group">
              {msg.id === 'greeting' ? (
                <div className="relative overflow-hidden rounded-2xl p-4 mb-1"
                  style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(139,92,246,0.14) 40%, rgba(6,182,212,0.08) 100%)' }}>
                  {/* Grid dot texture */}
                  <div className="absolute inset-0 opacity-[0.04]"
                    style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.9) 1px, transparent 1px)' }} />
                  {/* Glow orb */}
                  <div className="absolute -top-6 -right-6 w-28 h-28 rounded-full opacity-20"
                    style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.8), transparent 70%)' }} />
                  <div className="relative z-10 flex items-center gap-3 mb-3">
                    {/* Decorative -- the adjacent label already says "EcomGear Agent",
                        so alt="" here (not a repeated alt text) prevents the browser
                        from ever showing a second "EcomGear Agent" as broken-image
                        fallback text, and avoids double-announcing it to screen readers. */}
                    <img src={ecgAgentLogo} alt="" className="w-10 h-8 shrink-0" />
                    <div>
                      <p className="text-[13px] font-semibold text-white/90 leading-tight">EcomGear Agent</p>
                      <p className="text-[10px] text-indigo-300/60 font-medium tracking-wide">App Builder · AI Powered</p>
                    </div>
                  </div>
                  <p className="relative z-10 text-[12.5px] text-white/75 leading-relaxed">
                    Welcome to <span className="font-semibold text-white">EcomGear App Builder</span> describe what you want to build and I'll generate it for you.
                  </p>
                </div>
              ) : (<>
              <ChatMessage
                role={msg.role}
                content={msg.content}
                status={msg.status}
                attachments={msg.attachments}
              />

              {/* Retry button   shown on hover below user messages */}
              {msg.role === 'user' && (
                <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleSubmit(msg.content)}
                    disabled={isGenerating}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-white/25 hover:text-white/60 hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-default transition-all duration-150"
                    title="Retry this prompt"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </button>
                </div>
              )}

              {/* Retry button   shown on an errored assistant message, resubmits the
                  preceding user prompt (same call shape as the user-message retry above). */}
              {msg.role === 'assistant' && msg.status === 'error' && (
                <div className="flex justify-start mt-1">
                  <button
                    onClick={() => {
                      for (let j = msgIndex - 1; j >= 0; j--) {
                        if (messages[j].role === 'user') { handleSubmit(messages[j].content); break; }
                      }
                    }}
                    disabled={isGenerating}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-red-400/70 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-default transition-all duration-150"
                    title="Retry this prompt"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </button>
                </div>
              )}

              {/* Step-by-step record. While streaming, the live status ticker
                  below already carries the "something's happening" signal --
                  a second bouncing-dots indicator here just duplicated it.
                  Once done, one neutral count chip replaces what used to be
                  one colored pill per file. */}
              {msg.role === 'assistant' && msg.steps && msg.steps.length > 0 && msg.status !== 'streaming' && msg.status !== 'pending' && (
                <div className="mt-1.5 ml-[30px]">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.03] text-[10px] font-medium text-gray-400">
                    {msg.steps.length} {msg.steps.length === 1 ? 'change' : 'changes'}
                  </span>
                </div>
              )}

              {/* Undo + preview-command action chips   one shared row so both read as the
                  same "message actions" language instead of two separately-spaced blocks;
                  only the accent color carries semantic meaning (yellow = destructive-ish
                  undo, indigo = neutral preview command), shape/size/padding match the
                  follow-up chips below. */}
              {((!isGuest && msg.role === 'assistant' && msg.status === 'complete' && !msg.isPlan && msg.snapshotId) ||
                (msg.role === 'assistant' && msg.status === 'complete' && msg.suggestedCommands && msg.suggestedCommands.length > 0)) && (
                <div className="mt-1.5 ml-[30px] flex flex-wrap gap-1.5">
                  {!isGuest && !msg.isPlan && msg.snapshotId && (
                    <button
                      disabled={isGenerating || rollingBack}
                      onClick={async () => {
                        if (!msg.snapshotId) return;
                        setRollingBack(true);
                        try {
                          const { data: { session } } = await lovableCloud.auth.getSession();
                          if (!session) throw new Error('Not authenticated');
                          const resp = await fetch(getGenServerUrl('/api/v1/ai/rollback'), {
                            method: 'POST',
                            headers: {
                              'Content-Type': 'application/json',
                              Authorization: `Bearer ${session.access_token}`,
                            },
                            body: JSON.stringify({ snapshotId: msg.snapshotId, projectId }),
                          });
                          if (!resp.ok) {
                            const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
                            throw new Error(err.error ?? 'Rollback failed');
                          }
                          // Remove snapshotId from this message so the button disappears
                          setMessages(prev => prev.map(m =>
                            m.id === msg.id ? { ...m, snapshotId: undefined } : m
                          ));
                          toast.success('Rolled back   project restored to previous state.');
                        } catch (err: unknown) {
                          toast.error(err instanceof Error ? err.message : 'Rollback failed');
                        } finally {
                          setRollingBack(false);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-yellow-500/25 bg-yellow-500/[0.08] text-yellow-300/80 hover:bg-yellow-500/15 text-[11px] font-medium transition-colors disabled:opacity-40"
                    >
                      {rollingBack
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <RotateCcw className="w-3 h-3" />}
                      Undo this change
                    </button>
                  )}
                  {msg.suggestedCommands?.map((cmd) => {
                    const labels: Record<string, string> = { restart: 'Restart', refresh: 'Refresh', rebuild: 'Rebuild' };
                    const label = labels[cmd] ?? cmd;
                    return (
                      <button
                        key={cmd}
                        disabled={isGenerating}
                        onClick={() => onPreviewCommand?.(cmd)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-600/15 hover:bg-indigo-600/25 border border-indigo-500/25 text-indigo-300/80 hover:text-indigo-200 text-[11px] font-medium transition-colors disabled:opacity-40"
                      >
                        <RotateCcw className="w-2.5 h-2.5" /> {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Follow-up suggestion chips   skeleton while Gemini is loading (null), chips when ready */}
              {msg.role === 'assistant' && msg.status === 'complete' && msg.followUpSuggestions !== undefined && !isGenerating && (
                <div className="mt-2 ml-[30px]">
                  {msg.followUpSuggestions === null ? (
                    /* Skeleton loading chips */
                    <div className="flex flex-wrap gap-1.5">
                      {[72, 96, 84].map((w) => (
                        <div
                          key={w}
                          className="h-[26px] rounded-full border border-white/[0.06] bg-white/[0.03] animate-pulse"
                          style={{ width: w }}
                        />
                      ))}
                    </div>
                  ) : msg.followUpSuggestions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {msg.followUpSuggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          disabled={isGenerating}
                          onClick={() => handleSubmit(suggestion)}
                          className="animate-chip-pop px-2.5 py-1 rounded-full
                            bg-white/[0.03] hover:bg-primary/[0.08]
                            border border-white/[0.07] hover:border-primary/30
                            text-gray-500 hover:text-gray-200 text-[11px]
                            transition-all duration-200 disabled:opacity-40"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
              </>)}
            </div>
          ))}

          {/* ── Live agent thinking   the model's real reasoning, shown once, live only.
              Never added to `messages`, so it's never part of the saved transcript;
              it just replaces itself each time a new `think` step arrives and
              disappears the moment the agent moves to a real action or finishes. ── */}
          {isGenerating && liveThought && (
            <div className="ml-[28px] mb-1 flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 max-w-[320px]" aria-hidden="true">
              <Sparkles className="w-3 h-3 mt-0.5 shrink-0 text-indigo-300/60 animate-pulse" />
              <p className="text-[11px] leading-snug text-white/40 italic line-clamp-3">
                {liveThought}
              </p>
            </div>
          )}

          {/* ── Live agent status   Lovable-style: real status headline first ── */}
          {isGenerating && (() => {
            const hasFile = liveFiles.length > 0;
            const f = hasFile ? liveFiles[liveFiles.length - 1] : null;
            const fileIcon: Record<string, string> = { write: '✦', edit: '✎', delete: '✕', rename: '↪', dependency: '⬡' };

            // Priority: REAL status (from the parallel cheap-model run / step)
            // wins as the headline. The current file is shown as a subtle
            // secondary detail, never replacing the descriptive status.
            const hasStatus = Boolean(statusText) && !/writing response/i.test(statusText ?? '');
            const headline = statusText || thinkingText || 'Working…';
            const fileDetail = f ? `${fileIcon[f.type] ?? '·'} ${f.path.replace(/^src\//, '')}` : '';

            return (
              <div className="ml-[28px] flex items-center gap-2 py-1" aria-hidden="true">
                {/* Pulsing activity dot   indigo while thinking, emerald while writing files */}
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${hasFile ? 'bg-emerald-400' : 'bg-indigo-400'} animate-ping`} />
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${hasFile ? 'bg-emerald-400' : 'bg-indigo-400'}`} />
                </span>
                {/* Headline   the real status (replaces the old raw-file-path line) */}
                <span
                  key={headline.slice(0, 20)}
                  className={`text-[11px] truncate max-w-[200px] animate-status-in ${hasStatus ? 'text-white/55' : 'text-white/35 italic'}`}
                >
                  {headline}
                </span>
                {/* Secondary: current file, subtle   only when a real status is present */}
                {hasStatus && fileDetail && (
                  <span className="text-[10px] text-white/25 truncate max-w-[120px] font-mono">
                    {fileDetail}
                  </span>
                )}
                {filesWritten > 1 && (
                  <span className="text-[10px] text-white/15 font-mono shrink-0">+{filesWritten - 1}</span>
                )}
                <span className="text-[10px] text-white/15 font-mono tabular-nums ml-auto shrink-0">{elapsedSeconds}s</span>
              </div>
            );
          })()}

          {/* Bottom anchor   keeps scroll pinned */}
          <div className="h-1" />
        </div>
      </div>

      {/* ── Input ── */}
      <div
        className="p-2.5 border-t border-white/[0.06]"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.csv,.md,.json,.docx,.xlsx"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="max-h-[32vh] overflow-y-auto overscroll-contain pr-1 sm:max-h-[45vh]">
          {/* Drag overlay */}
          {isDragOver && (
            <div className="mb-2 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-500/40 bg-indigo-500/[0.06] py-4">
              <p className="text-xs text-indigo-300">Drop files here</p>
            </div>
          )}

          {/* Pending attachment previews */}
          {(pendingAttachments.length > 0 || uploadingCount > 0) && (
            <div className="mb-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto overscroll-contain sm:max-h-40">
              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  className="group relative flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-gray-300"
                >
                  {att.category === 'image' ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <FileText className="h-4 w-4 text-gray-500 shrink-0" />
                  )}
                  <div className="min-w-0 max-w-[120px]">
                    <p className="truncate font-medium">{att.name}</p>
                    <p className="text-[9px] text-gray-600">{formatFileSize(att.size)}</p>
                  </div>
                  <button
                    onClick={() => removePendingAttachment(att.id)}
                    className="ml-1 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {uploadingCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Uploading…
                </div>
              )}
            </div>
          )}

          {/* Textarea   overflow-hidden only wraps this so rounded corners work */}
          <div className={`rounded-xl overflow-hidden transition-all duration-150
            ${isDragOver
              ? 'bg-[#0e0e14] border border-primary/40 shadow-[0_0_0_1px_rgba(45,212,191,0.22)]'
              : 'bg-[#0c0c10] border border-white/[0.08] focus-within:border-primary/35 focus-within:shadow-[0_0_0_1px_rgba(45,212,191,0.18)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_2px_8px_rgba(0,0,0,0.2)]'}`}>
            <Textarea
              ref={inputRef}
              placeholder={
                isGenerating ? 'Agent is working…'
                : 'Describe your idea or ask me to build something…'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData.items);
                const imageFiles = items
                  .filter(item => item.type.startsWith('image/'))
                  .map(item => item.getAsFile())
                  .filter((f): f is File => f !== null);
                if (imageFiles.length > 0) {
                  e.preventDefault();
                  handleFiles(imageFiles);
                }
              }}
              disabled={isGenerating || !projectId}
              className="min-h-[52px] max-h-[140px] w-full resize-none overflow-y-auto bg-transparent border-0 focus-visible:ring-0 shadow-none text-[12px] text-gray-200 placeholder:text-gray-600 px-3 pt-2.5 pb-2.5"
            />
          </div>
        </div>

        {/* Over-limit warning */}
        {input.length > MAX_INPUT_CHARS && (
          <p className="text-[11px] text-red-400 px-1 mt-1">
            Message is too long. Please shorten it before sending ({input.length - MAX_INPUT_CHARS} characters over the {MAX_INPUT_CHARS.toLocaleString()} limit).
          </p>
        )}

        {/* Toolbar */}
        <div className="flex items-center justify-between mt-1.5 px-0.5">

          {/* Left: attach */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating || !projectId}
            className="h-6 w-6 flex items-center justify-center rounded-md text-gray-600 hover:text-gray-300 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-default transition-all"
            title="Attach file"
          >
            <Paperclip className="w-3 h-3" />
          </button>

          {/* Right: char counter + mode dropdown + send */}
          <div className="flex items-center gap-1.5">
            {input.length >= MAX_INPUT_CHARS * 0.8 && (
              <span className={`text-[10px] tabular-nums transition-colors ${
                input.length >= MAX_INPUT_CHARS ? 'text-red-400' : input.length >= MAX_INPUT_CHARS * 0.95 ? 'text-amber-400' : 'text-gray-500'
              }`}>
                {input.length}/{MAX_INPUT_CHARS}
              </span>
            )}

            {/* Build / Plan mode dropdown */}
            <div className="relative" ref={modelMenuRef}>
              <button
                onClick={() => setModelMenuOpen(v => !v)}
                disabled={isGenerating}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium text-white/70 hover:text-white hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                <span>{agentMode === 'plan' ? 'Plan' : 'Build'}</span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>

              {/* Dropdown   opens upward */}
              {modelMenuOpen && (
                <div className="absolute bottom-full right-0 mb-1.5 bg-[#1c1c20] border border-white/[0.10] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.7)] z-[200] overflow-hidden" style={{ minWidth: 210 }}>
                  <button
                    onClick={() => { setAgentMode('agent'); setModelMenuOpen(false); }}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.05] ${agentMode === 'agent' ? 'text-white' : 'text-white/60'}`}
                  >
                    <span className="mt-0.5 w-3.5 shrink-0 text-indigo-400">{agentMode === 'agent' ? '✓' : ''}</span>
                    <div>
                      <p className="text-[13px] font-semibold leading-none mb-1">Build</p>
                      <p className="text-[11px] text-white/40">Make changes directly</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { setAgentMode('plan'); setModelMenuOpen(false); }}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.05] ${agentMode === 'plan' ? 'text-white' : 'text-white/60'}`}
                  >
                    <span className="mt-0.5 w-3.5 shrink-0 text-indigo-400">{agentMode === 'plan' ? '✓' : ''}</span>
                    <div>
                      <p className="text-[13px] font-semibold leading-none mb-1">Plan</p>
                      <p className="text-[11px] text-white/40">Discuss before building</p>
                    </div>
                  </button>
                  <div className="px-4 py-2 border-t border-white/[0.06]">
                    <span className="text-[11px] text-white/25">Toggle with <kbd className="px-1 py-0.5 rounded bg-white/[0.07] text-white/40 font-mono text-[10px]">Alt</kbd> <kbd className="px-1 py-0.5 rounded bg-white/[0.07] text-white/40 font-mono text-[10px]">P</kbd></span>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => handleSubmit()}
              disabled={(!input.trim() && pendingAttachments.length === 0) || isGenerating || !projectId || input.length > MAX_INPUT_CHARS}
              className="h-7 w-7 flex items-center justify-center rounded-lg
                bg-primary hover:bg-primary/90
                disabled:bg-white/[0.05] disabled:text-white/15
                text-primary-foreground
                transition-all duration-150"
            >
              {isGenerating
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Send className="w-3 h-3 translate-x-px" />
              }
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
