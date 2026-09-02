/**
 * agentStreamService   Frontend client for the /api/v1/ai/agent-stream SSE endpoint.
 *
 * Replaces the old blocking promptService.generateStage() approach with a real-time
 * SSE stream that mirrors the agent's tool-calling loop back to the UI.
 */

import { getGenServerCandidateUrls } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';
import type { GeneratedFile, GenerationResponse } from './types';

function extractSummaryFromText(content: string): string {
  const summaryMatch = content.match(/<ecomgear-chat-summary>([\s\S]*?)<\/ecomgear-chat-summary>/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }

  return content
    .replace(/<ecomgear-chat-summary>[\s\S]*?<\/ecomgear-chat-summary>/gi, '')
    .trim()
    .split('\n')[0] ?? '';
}

function normalizeMode(value: unknown): 'build' | 'plan' | undefined {
  return value === 'build' || value === 'plan' ? value : undefined;
}

function applyToolXmlToResult(xml: string, filesByPath: Map<string, GeneratedFile>, filesToDelete: Set<string>, renames: Array<{ from: string; to: string }>, dependencies: Set<string>) {
  const writeMatch = /<ecomgear-write\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/ecomgear-write>/i.exec(xml);
  if (writeMatch) {
    const path = writeMatch[1];
    const content = writeMatch[2].trim();
    filesByPath.set(path, {
      path,
      content,
      type: 'other',
      operation: 'create',
    });
    filesToDelete.delete(path);
    return;
  }

  const deleteMatch = /<ecomgear-delete\s+path="([^"]+)"/i.exec(xml);
  if (deleteMatch) {
    const path = deleteMatch[1];
    filesByPath.delete(path);
    filesToDelete.add(path);
    return;
  }

  const renameMatch = /<ecomgear-rename\s+from="([^"]+)"\s+to="([^"]+)"/i.exec(xml);
  if (renameMatch) {
    const from = renameMatch[1];
    const to = renameMatch[2];
    const existing = filesByPath.get(from);
    if (existing) {
      filesByPath.delete(from);
      filesByPath.set(to, { ...existing, path: to, operation: 'update' });
    }
    renames.push({ from, to });
    return;
  }

  const dependencyMatch = /<ecomgear-add-dependency\s+packages="([^"]+)"/i.exec(xml);
  if (dependencyMatch) {
    dependencyMatch[1]
      .split(/[\s,]+/)
      .map((pkg) => pkg.trim())
      .filter(Boolean)
      .forEach((pkg) => dependencies.add(pkg));
  }
}

// ─── SSE Event Types ──────────────────────────────────────────────────────────

export interface StepFinishData {
  step: number;
  hasText: boolean;
  toolCount: number;
  tools: string[];
  failedEdits: number;
  /** Optional status message (e.g. retry/fallback info) */
  status?: string;
}

export interface AgentStreamCallbacks {
  /** Called once the SSE response is accepted and streaming has started */
  onOpen?: () => void;
  /** Called for each text token the agent produces */
  onTextDelta?: (text: string) => void;
  /** Discard text streamed so far: the run that produced it was superseded. */
  onTextReset?: () => void;
  /** Called when files are available (on 'done' event) */
  onDone?: (result: GenerationResponse) => void;
  /** Called when the agent emits tool XML (e.g. <ecomgear-write>) */
  onToolOutput?: (xml: string) => void;
  /**
   * A tool call's arguments are being generated: which tool, which file (or
   * function / command), how many characters so far, and whether the input
   * is complete. Fires as soon as the target is known and then every few
   * hundred ms, so the UI can show the file being written while it is.
   */
  onToolProgress?: (data: { id: string; tool: string; path: string; chars: number; done: boolean }) => void;
  /** Called when the agent finishes a thinking/tool step */
  onStepFinish?: (data: StepFinishData) => void;
  /** Called when a cheap-model-generated status arrives to replace the canned one for a given step (feature/build tiers only) */
  onStepStatusRefine?: (data: { step: number; status: string }) => void;
  /** Called with a real-time, LLM-written narration of what the agent is doing right now */
  onAgentNarration?: (narration: string) => void;
  /** Called with the agent's actual internal reasoning (the `think` tool's real argument)   live/transient only, never persisted */
  onAgentThinking?: (data: { step: number; thought: string }) => void;
  /** Called on error */
  onError?: (message: string, serverMessageId?: string) => void;
  /** Called when all auto-repair attempts fail   errors can be shown to user for manual fix */
  onRepairFailed?: (errors: string[]) => void;
  /** Called with the real token count once the AI SDK resolves usage (after 'done') */
  onUsage?: (tokensUsed: number) => void;
}

// ─── Stream function ──────────────────────────────────────────────────────────

export async function streamAgentGeneration(params: {
  prompt: string;
  projectId: string;
  orgId?: string | null;
  existingFiles?: GeneratedFile[];
  model?: string;
  /** 'build' (default) or 'plan'   handled server-side */
  mode?: 'build' | 'plan';
  /**
   * User-selected chat mode from the editor's mode toggle: 'normal'
   * (default) is regular development work, no direct database access.
   * 'admin' additionally lets the agent stage arbitrary SQL against the
   * project's hosted database (query_database) -- any resulting dangerous
   * statement still requires a human to click confirm, the agent can never
   * execute it itself. See AgentContext.chatMode server-side.
   */
  chatMode?: 'normal' | 'admin';
  /** Recent conversation turns (last 6 messages, cleaned) */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** One-line bullet summary of turns older than the history window */
  olderSummary?: string;
  /** Attachments uploaded in the current message */
  attachments?: Array<{
    name: string;
    type: string;
    category: 'image' | 'document';
    tempPath: string;
    /** Durable fallback if tempPath's /tmp copy has expired (1hr TTL). */
    publicUrl?: string;
  }>;
  /** Guest fingerprint   when set, auth token is optional */
  fingerprint?: string;
  /**
   * When set, a PROJECT_LOCKED response is retried silently (with backoff)
   * instead of surfacing to the user immediately   for system-triggered
   * follow-up requests (like the post-repair auto-fix escalation) that can
   * legitimately race the tail end of the very run that triggered them: the
   * server may still be mid-cleanup (restore-push retries, lock release)
   * for several seconds after the client sees the stream end. User-initiated
   * requests should NOT set this   they want to know immediately if locked.
   */
  retryOnLock?: boolean;
  callbacks: AgentStreamCallbacks;
  signal?: AbortSignal;
}): Promise<GenerationResponse> {
  const { prompt, projectId, orgId, model, mode, chatMode, history, olderSummary, attachments, fingerprint, retryOnLock, callbacks, signal } = params;

  // Get session; if access token is missing, attempt a silent refresh before giving up.
  let sessionData = (await lovableCloud.auth.getSession()).data.session;
  let token = sessionData?.access_token ?? '';
  if (!token && !fingerprint) {
    const { data: refreshed } = await lovableCloud.auth.refreshSession();
    token = refreshed.session?.access_token ?? '';
  }
  // Second attempt: if token still empty (e.g. expired refresh token), force sign-out so
  // the user sees a clean "session expired" error rather than a confusing 401 from the server.
  if (!token && !fingerprint) {
    await lovableCloud.auth.signOut({ scope: 'local' });
    const message = 'Your session has expired. Please refresh the page and log in again.';
    callbacks.onError?.(message);
    throw Object.assign(new Error(message), { sessionExpired: true });
  }
  const isGuest = !token && !!fingerprint;

  const candidateUrls = getGenServerCandidateUrls('/api/v1/ai/agent-stream');
  let response: globalThis.Response | null = null;
  let lastNetworkError = '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  // Only send Authorization header if we have a token
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // existingFiles is deliberately NOT sent.
  //
  // The server does not need it: agentLoopService builds preAgentDiskSnapshot
  // from /var/ecomgear/projects/<projectId> on every run, and that disk state is
  // authoritative -- it is what the preview push and every file tool operate on.
  // Sending the client's copy uploaded the whole project source on each message
  // (hundreds of files on a real project) purely to be ignored or, worse, used.
  //
  // "Worse", because agentLoopService's fileSources PREFERS a non-empty
  // existingFiles over the disk snapshot. Two concrete failures came from that:
  //   - Stale context. The client array is a snapshot from whenever the browser
  //     last synced. After a rollback, a timeout salvage, or any out-of-band
  //     change, it describes files that no longer exist on disk, and the agent
  //     writes SEARCH blocks against code that is not there.
  //   - It defeats the micro fast path, which deliberately snapshots only the
  //     one target file; a full client tree silently restores the full cost.
  //
  // existingFiles is still threaded through promptService for the local
  // liveFileMap seed, which merges streamed partial updates onto the tree the
  // user is looking at. That is a client-side concern and stays client-side.
  const bodyPayload: Record<string, unknown> = { prompt, projectId, model, mode, chatMode, history, olderSummary, attachments };
  if (orgId) {
    bodyPayload.orgId = orgId;
  }
  if (fingerprint) {
    bodyPayload.fingerprint = fingerprint;
  }

  // One pass over every candidate URL. Returns the response on success, or
  // throws: a terminal tagged error (session/guest/eco/lock), a retryable
  // lock signal (projectLockedRetry   only when retryOnLock lets a caller
  // ask for it), or falls through to the generic "tried everything" path.
  const tryAllCandidates = async (allowLockRetry: boolean): Promise<globalThis.Response | null> => {
    for (const url of candidateUrls) {
      try {
        const candidateResponse = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyPayload),
          signal,
        });

        if (!candidateResponse.ok) {
          const errText = await candidateResponse.text().catch(() => '');

          // Parse guest limit error specifically
          try {
            const errJson = JSON.parse(errText);
            if (errJson.error === 'guest_limit_reached') {
              const message = errJson.message || 'Guest request limit reached. Please sign up to continue.';
              callbacks.onError?.(message);
              throw Object.assign(new Error(message), { guestLimitReached: true });
            }
            if (errJson.code === 'ECO_LIMIT_REACHED') {
              const message = errJson.error || 'Monthly eco limit reached. Please upgrade your plan or wait for the reset.';
              callbacks.onError?.(message);
              throw Object.assign(new Error(message), { ecoLimitReached: true });
            }
            if (candidateResponse.status === 401 && errJson.error?.includes('Authentication required')) {
              const message = 'Your session has expired. Please refresh the page and log in again.';
              callbacks.onError?.(message);
              throw Object.assign(new Error(message), { sessionExpired: true });
            }
            if (errJson.code === 'NO_ACTIVE_RUN') {
              // A rejoin that arrived after the run finished. Not an error the
              // user should see -- the run is simply over. Silent, like the
              // lock-retry path: the caller clears its optimistic bubble.
              throw Object.assign(new Error('no active run to rejoin'), { noActiveRun: true });
            }
            if (errJson.code === 'PROJECT_LOCKED') {
              if (allowLockRetry) {
                // Silent   no onError, no toast. The caller decides whether
                // to retry or give up after enough attempts.
                throw Object.assign(new Error('project locked   retrying'), { projectLockedRetry: true });
              }
              const message = 'Another generation is already running for this project. Please wait for it to finish before starting a new one.';
              callbacks.onError?.(message);
              throw Object.assign(new Error(message), { projectLocked: true });
            }
          } catch (parseErr) {
            if ((parseErr as any).guestLimitReached || (parseErr as any).ecoLimitReached || (parseErr as any).sessionExpired || (parseErr as any).noActiveRun || (parseErr as any).projectLocked || (parseErr as any).projectLockedRetry) throw parseErr;
          }

          const message = `Agent stream failed (${candidateResponse.status}): ${errText}`;
          callbacks.onError?.(message);
          throw new Error(message);
        }

        callbacks.onOpen?.();
        return candidateResponse;
      } catch (error) {
        // Terminal/retryable-lock errors   don't try other candidate URLs, propagate immediately
        if ((error as any).sessionExpired || (error as any).guestLimitReached || (error as any).ecoLimitReached || (error as any).projectLocked || (error as any).projectLockedRetry) throw error;
        // A genuine abort (user cancelled, or the signal's owner tore down)
        // is also terminal -- without this, an abort on candidate 1 fell
        // through to trying candidates 2..N (each aborting too, on the same
        // signal), eventually exhausting every URL and reporting "connection
        // failed on all local endpoints" instead of cleanly stopping. Rethrow
        // the ORIGINAL error so its real name ('AbortError') survives -- the
        // caller's `err.name === 'AbortError'` check depends on that.
        if (error instanceof Error && error.name === 'AbortError') throw error;
        lastNetworkError = error instanceof Error ? error.message : String(error);
      }
    }
    return null;
  };

  const LOCK_RETRY_ATTEMPTS = 5;
  const LOCK_RETRY_DELAY_MS = 2000;
  for (let attempt = 1; attempt <= (retryOnLock ? LOCK_RETRY_ATTEMPTS : 1); attempt++) {
    try {
      response = await tryAllCandidates(!!retryOnLock && attempt < LOCK_RETRY_ATTEMPTS);
      break;
    } catch (error) {
      if ((error as any).projectLockedRetry) {
        await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  if (!response) {
    const message = `Agent stream connection failed on all local endpoints: ${lastNetworkError}`;
    callbacks.onError?.(message);
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('Agent stream: response body is null');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: GenerationResponse = { files: [] };
  let terminalEventReceived = false;
  let streamFailed = false;
  let streamFailedMessage = '';
  let streamFailedMessageId: string | null = null;
  let streamedText = '';
  const streamedFiles = new Map<string, GeneratedFile>();
  const streamedDeletes = new Set<string>();
  const streamedRenames: Array<{ from: string; to: string }> = [];
  const streamedDependencies = new Set<string>();

  // Inactivity watchdog: if no bytes arrive for 90 s (and no heartbeat), assume
  // the connection is dead and bail out rather than spinning forever.
  // DeepSeek reasoning models have an extended internal thinking phase before
  // streaming the first token, so we allow them a larger first-token window.
  const isDeepSeekModel = (model ?? '').toLowerCase().includes('deepseek');
  const INACTIVITY_TIMEOUT_MS = isDeepSeekModel ? 300_000 : 90_000; // 5 min or 90 s
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
      const minutes = Math.round(INACTIVITY_TIMEOUT_MS / 60_000);
      const label = INACTIVITY_TIMEOUT_MS < 60_000
        ? `${INACTIVITY_TIMEOUT_MS / 1000} s`
        : `${minutes} min`;
      callbacks.onError?.(`Agent connection timed out (no response for ${label}). Please try again.`);
    }, INACTIVITY_TIMEOUT_MS);
  };

  resetInactivityTimer();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (timedOut) break;

      resetInactivityTimer();
      buffer += decoder.decode(value, { stream: true });
      const normalizedBuffer = buffer.replace(/\r\n/g, '\n');
      const frames = normalizedBuffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const lines = frame.split('\n').filter(Boolean);
        if (lines.length === 0) continue;

        let eventType = 'message';
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        const rawData = dataLines.join('\n').trim();
        if (!rawData || rawData === ':') continue;

        try {
          const payload = JSON.parse(rawData);

          switch (eventType) {
            case 'text-delta':
              streamedText += payload.text ?? '';
              callbacks.onTextDelta?.(payload.text ?? '');
              break;
            case 'text-reset':
              // The server superseded the attempt that produced the text so
              // far (cheap-first escalation). Drop it locally instead of
              // appending the replacement underneath it.
              streamedText = '';
              callbacks.onTextReset?.();
              break;
            case 'tool-progress': {
              if (typeof payload.id === 'string' && typeof payload.tool === 'string' && typeof payload.path === 'string') {
                callbacks.onToolProgress?.({ id: payload.id, tool: payload.tool, path: payload.path, chars: Number(payload.chars) || 0, done: payload.done === true });
              }
              break;
            }
            case 'tool-output': {
              const xml = payload.xml ?? '';
              if (xml) {
                applyToolXmlToResult(xml, streamedFiles, streamedDeletes, streamedRenames, streamedDependencies);
              }
              callbacks.onToolOutput?.(xml);
              break;
            }
            case 'step-finish': {
              callbacks.onStepFinish?.({
                step: payload.step ?? 0,
                hasText: payload.hasText ?? false,
                toolCount: payload.toolCount ?? 0,
                tools: Array.isArray(payload.tools) ? payload.tools : [],
                failedEdits: payload.failedEdits ?? 0,
                status: typeof payload.status === 'string' ? payload.status : undefined,
              });
              break;
            }
            case 'step-status-refine': {
              if (typeof payload.step === 'number' && typeof payload.status === 'string') {
                callbacks.onStepStatusRefine?.({ step: payload.step, status: payload.status });
              }
              break;
            }
            case 'agent-narration': {
              if (typeof payload.narration === 'string' && payload.narration.trim()) {
                callbacks.onAgentNarration?.(payload.narration);
              }
              break;
            }
            case 'agent-thinking': {
              if (typeof payload.thought === 'string' && payload.thought.trim()) {
                callbacks.onAgentThinking?.({ step: payload.step ?? 0, thought: payload.thought });
              }
              break;
            }
            case 'done': {
              terminalEventReceived = true;
              // Default to 'build' when mode is absent/unrecognised   callers type it as 'build' | 'plan'.
              const mode = normalizeMode(payload.mode) ?? 'build';
              const filesRaw = Array.isArray(payload.filesToWrite) ? payload.filesToWrite : [];
              const files: GeneratedFile[] = filesRaw.map((f) => {
                const file = (f ?? {}) as { path?: string; content?: string };
                return {
                  path: file.path ?? '',
                  content: file.content ?? '',
                  type: 'other' as const,
                  operation: 'create' as const,
                };
              }).filter((f) => f.path.length > 0);
              finalResult = {
                files,
                mode,
                filesToWrite: files,
                filesToDelete: payload.filesToDelete ?? [],
                renames: payload.renames ?? [],
                dependencies: payload.dependencies ?? [],
                summary: payload.summary ?? '',
                tokensUsed: typeof payload.tokensUsed === 'number' ? payload.tokensUsed : 0,
                snapshotId: typeof payload.snapshotId === 'string' ? payload.snapshotId : undefined,
                previewPushed: payload.previewPushed === true,
                ghostRun: payload.ghostRun === true,
                stagedSql: Array.isArray(payload.stagedSql) ? payload.stagedSql : [],
                batchId: typeof payload.batchId === 'string' ? payload.batchId : null,
                smokeFailureSurvivedRepair: payload.smokeFailureSurvivedRepair === true,
                previewDepsError: typeof payload.previewDepsError === 'string' ? payload.previewDepsError : null,
                costUsd: typeof payload.costUsd === 'number' ? payload.costUsd : undefined,
                ecoUsed: typeof payload.ecoUsed === 'number' ? payload.ecoUsed : undefined,
                needsAutoContinue: payload.needsAutoContinue === true,
                continuationPrompt: typeof payload.continuationPrompt === 'string' ? payload.continuationPrompt : undefined,
              };
              callbacks.onDone?.(finalResult);
              break;
            }
            case 'usage':
              if (typeof payload.tokensUsed === 'number' && payload.tokensUsed > 0) {
                callbacks.onUsage?.(payload.tokensUsed);
              }
              break;
            case 'error':
              // Ignore error events that arrive AFTER a 'done' was already processed  
              // this happens on timeout: the server sends done (salvage) then abort throws,
              // causing the route handler to emit a second 'error' SSE. We don't want to
              // overwrite the already-resolved done state.
              if (terminalEventReceived) break;
              terminalEventReceived = true;
              streamFailed = true;
              streamFailedMessage = payload.message ?? 'Unknown agent error';
              // The server persists interrupt/error messages itself, keyed by
              // run id, and passes that id here. Both client implementations
              // (this panel and promptService) also save on error, so without a
              // shared id ONE interrupt produced two chat bubbles -- seen on
              // CardPro 2026-09-02, two rows at the same second from one run.
              streamFailedMessageId = typeof payload.assistantMessageId === 'string'
                ? payload.assistantMessageId
                : null;
              callbacks.onError?.(streamFailedMessage, streamFailedMessageId ?? undefined);
              break;
            case 'repair-failed':
              callbacks.onRepairFailed?.(Array.isArray(payload.errors) ? payload.errors : []);
              break;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    reader.releaseLock();
  }

  if (timedOut) {
    const _minutes = Math.round(INACTIVITY_TIMEOUT_MS / 60_000);
    const _label = INACTIVITY_TIMEOUT_MS < 60_000
      ? `${INACTIVITY_TIMEOUT_MS / 1000} s`
      : `${_minutes} min`;
    throw new Error(`Agent connection timed out (no response for ${_label}). Please try again.`);
  }

  if (streamFailed) {
    throw new Error(streamFailedMessage || 'Agent stream failed before completion.');
  }

  if (!terminalEventReceived) {
    const fallbackFiles = Array.from(streamedFiles.values());
    const sawWork = fallbackFiles.length > 0 || streamedDeletes.size > 0 || streamedRenames.length > 0 || streamedDependencies.size > 0 || streamedText.trim().length > 0;

    if (sawWork) {
      const inferredMode: 'build' | 'plan' =
        fallbackFiles.length > 0 || streamedDeletes.size > 0 || streamedRenames.length > 0 || streamedDependencies.size > 0
          ? 'build'
          : (/reply\s+\*\*execute\*\*/i.test(streamedText) ? 'plan' : 'build');
      finalResult = {
        files: fallbackFiles,
        mode: inferredMode,
        filesToWrite: fallbackFiles,
        filesToDelete: Array.from(streamedDeletes),
        renames: streamedRenames,
        dependencies: Array.from(streamedDependencies),
        summary: extractSummaryFromText(streamedText),
        tokensUsed: 0,
      };
      callbacks.onDone?.(finalResult);
    } else {
      const message = 'Agent stream ended before completion. Please try again.';
      callbacks.onError?.(message);
      throw new Error(message);
    }
  }
  return finalResult;
}
