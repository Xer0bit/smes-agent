/**
 * Prompt Service - Orchestrates prompt handling flow
 * Lines 473-808 from Editor.tsx extracted here
 */
import { supabase } from '@/integrations/supabase/client';
import { revisionService } from '@/services/revisionService';
import { messageService } from './messageService';
import { streamAgentGeneration } from './agentStreamService';
import {
  PromptHandlerParams,
  PromptHandlerCallbacks,
  GeneratedFile,
  GenerationResponse,
} from './types';

/**
 * Decode base64 content if needed
 */
function decodeFileContent(file: Omit<GeneratedFile, 'content'> & Partial<Pick<GeneratedFile, 'content'>> & { content_b64?: string }): GeneratedFile {
  let content = file.content || '';
  if (!content && file.content_b64) {
    try {
      const binaryString = atob(file.content_b64);
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      content = new TextDecoder().decode(bytes);
    } catch (e) {
      console.error('[PromptService] Decode error:', file.path, e);
      content = '// Decode error';
    }
  }
  return { ...file, content };
}

function applyToolXmlToMap(xml: string, fileMap: Map<string, GeneratedFile>): boolean {
  let changed = false;

  // <ecomgear-write path="...">...</ecomgear-write>
  const writeMatch = /<ecomgear-write\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/ecomgear-write>/.exec(xml);
  if (writeMatch) {
    const path = writeMatch[1];
    const content = writeMatch[2].trim();
    const existing = fileMap.get(path);
    if (!existing || existing.content !== content) {
      fileMap.set(path, { path, content, type: existing?.type || 'other', operation: 'update' });
      changed = true;
    }
  }

  // <ecomgear-delete path="..." />
  const deleteMatch = /<ecomgear-delete\s+path="([^"]+)"/.exec(xml);
  if (deleteMatch) {
    changed = fileMap.delete(deleteMatch[1]) || changed;
  }

  // <ecomgear-rename from="..." to="..." />
  const renameMatch = /<ecomgear-rename\s+from="([^"]+)"\s+to="([^"]+)"/.exec(xml);
  if (renameMatch) {
    const from = renameMatch[1];
    const to = renameMatch[2];
    const existing = fileMap.get(from);
    if (existing) {
      fileMap.delete(from);
      fileMap.set(to, { ...existing, path: to, operation: 'update' });
      changed = true;
    }
  }

  return changed;
}

export const promptService = {
  /**
   * Main prompt handler - orchestrates the entire generation flow
   * Extracted from Editor.tsx lines 473-808
   */
  async handlePrompt(
    params: PromptHandlerParams,
    callbacks: PromptHandlerCallbacks
  ): Promise<GenerationResponse> {
    const {
      promptText,
      projectId,
      userId,
      currentUser,
      organizationId,
      fileContext,
      existingFiles,
      hasRealApp,
      fingerprint
    } = params;

    const {
      onMessageAdd,
      onSystemMessage,
      onFilesUpdate,
      onCodeUpdate,
      onLoadingChange,
      onWorkflowComplete,
      onPreviewStatusChange,
      onPreviewUrlChange,
    } = callbacks;

    // Add user message to chat
    const userMessage = { role: 'user' as const, content: promptText };
    onMessageAdd(userMessage);

    // Save user message to database (skip for guests — no DB row)
    if (!fingerprint) {
      await messageService.saveUserMessage(projectId, promptText);
      await messageService.incrementProjectMessageCount(projectId);
    }

    onLoadingChange(true);
    onWorkflowComplete(false);

    try {
      console.log('[PromptService] Starting agent stream generation...');

      // Verify user session — guests are allowed without session
      if (!fingerprint) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error('Your session has expired. Please refresh the page and log in again.');
        }
      }

      await onSystemMessage(`Task: ${promptText}`);
      await onSystemMessage('Plan: Analyze files and prepare code changes.');
      await onSystemMessage('Working on agent...');

      let accumulatedText = '';
      let finalResult: GenerationResponse = { files: [] };
      const liveFileMap = new Map<string, GeneratedFile>();
      (hasRealApp ? existingFiles : []).forEach((f) => {
        liveFileMap.set(f.path, f);
      });

      const emitLiveFiles = () => {
        const liveFiles = Array.from(liveFileMap.values());
        onFilesUpdate(liveFiles);
        const htmlFile = liveFiles.find((f) => f.path === 'index.html') || liveFiles[0];
        if (htmlFile?.content) {
          onCodeUpdate(htmlFile.content);
        }
      };

      // Single-pass streaming agent generation
      finalResult = await streamAgentGeneration({
        prompt: promptText,
        projectId,
        orgId: organizationId,
        existingFiles: hasRealApp ? existingFiles : [],
        fingerprint,
        callbacks: {
          onTextDelta: (text) => {
            accumulatedText += text;
          },
          onToolOutput: (xml) => {
            // Apply tool operations immediately so progress survives stream interruptions.
            const changed = applyToolXmlToMap(xml, liveFileMap);
            if (changed) {
              emitLiveFiles();
            }
          },
          onDone: (result) => {
            finalResult = result;
          },
          onError: (message) => {
            void onSystemMessage(`Agent error: ${message}`);
            // Persist whatever was streamed so far — otherwise a reload silently
            // erases the agent's partial reply, leaving only the user's prompt.
            if (!fingerprint && accumulatedText.trim()) {
              void messageService.saveAssistantMessage(projectId, `${accumulatedText}\n\n*[error]*`, userId).catch(err => {
                console.error('Failed to save partial assistant message on error', err);
              });
            }
          },
        },
      });

      const files = (finalResult.filesToWrite ?? finalResult.files).map(decodeFileContent);

      // Apply deletions
      const deletedPaths = new Set(finalResult.filesToDelete ?? []);
      const renames = finalResult.renames ?? [];
      const renameMap = new Map(renames.map(r => [r.from, r.to]));

      // Build merged file map with renames/deletes applied
      const byPath = new Map<string, GeneratedFile>();
      (hasRealApp ? existingFiles : []).forEach(f => {
        if (!deletedPaths.has(f.path)) byPath.set(f.path, f);
      });
      files.forEach(f => {
        if (!deletedPaths.has(f.path)) {
          const finalPath = renameMap.get(f.path) ?? f.path;
          byPath.set(finalPath, { ...f, path: finalPath });
        }
      });

      // Handle renames of existing files
      for (const [from, to] of renameMap) {
        if (byPath.has(from)) {
          const entry = byPath.get(from)!;
          byPath.delete(from);
          byPath.set(to, { ...entry, path: to });
        }
      }

      const mergedFiles = Array.from(byPath.values());

      // Ensure final merged state is emitted in case onDone includes additional writes.
      onFilesUpdate(mergedFiles);

      const htmlFile = mergedFiles.find(f => f.path === 'index.html') || mergedFiles[0];
      const code = htmlFile?.content || accumulatedText;
      onCodeUpdate(code);

      await this.saveRevisionAndBuildPreview({
        projectId,
        promptText,
        code,
        mergedFiles,
        userId,
        summary: finalResult.summary,
        onSystemMessage,
        onPreviewStatusChange,
        onPreviewUrlChange,
        onWorkflowComplete,
        onMessageAdd,
      });

      return finalResult;
    } catch (error) {
      console.error('[PromptService] Error in prompt handling:', error);
      throw error;
    }
  },

  /**
   * Save revision and trigger preview build
   */
  async saveRevisionAndBuildPreview(params: {
    projectId: string;
    promptText: string;
    code: string;
    mergedFiles: GeneratedFile[];
    userId: string;
    summary?: string;
    onSystemMessage: (content: string) => Promise<void>;
    onPreviewStatusChange: (status: 'pending' | 'building' | 'ready' | 'failed') => void;
    onPreviewUrlChange: (url: string) => void;
    onWorkflowComplete: (complete: boolean) => void;
    onMessageAdd: (message: { role: 'assistant'; content: string }) => void;
  }): Promise<void> {
    const {
      projectId,
      promptText,
      code,
      mergedFiles,
      userId: initialUserId,
      summary,
      onSystemMessage,
      onPreviewStatusChange,
      onPreviewUrlChange,
      onWorkflowComplete,
      onMessageAdd,
    } = params;

    // Guest mode: skip revision creation (no user row), just build preview
    const isGuestProject = projectId.startsWith('guest-');

    try {
      if (!isGuestProject) {
        // Ensure we have a valid user ID
        let userId = initialUserId;
        if (!userId) {
          const { data: { user } } = await supabase.auth.getUser();
          userId = user?.id;
        }

        if (!userId) {
          throw new Error('User authentication required to create revision');
        }

        const revisionId = await revisionService.createRevision({
          project_id: projectId,
          prompt: promptText,
          generated_code: code,
          user_id: userId,
          generated_files: {
            files: mergedFiles.map(f => ({
              path: f.path,
              content: f.content,
              type: f.type || 'other',
              operation: f.operation || 'create',
            })),
            summary: summary || '',
          },
        });
        console.log('[PromptService] Created revision:', revisionId);
      }

      // Build preview
      onPreviewStatusChange('building');

      console.log('[PromptService] Syncing files to local Docker preview...');
      try {
        // Normalise the base URL: ensure it has a protocol, strip trailing slashes
        // and any stray /preview suffix so we can safely append our own path.
        let rawBase = import.meta.env.VITE_PREVIEW_SERVICE_URL || 'http://localhost:3001';
        if (!rawBase.startsWith('http://') && !rawBase.startsWith('https://')) {
          rawBase = `http://${rawBase}`;
        }
        const previewBaseUrl = rawBase.replace(/\/+$/, '').replace(/\/preview\/?$/, '');

        const updateRes = await fetch(`${previewBaseUrl}/preview/${projectId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: mergedFiles.map(f => ({ path: f.path, content: f.content }))
          })
        });

        if (!updateRes.ok) {
          const body = await updateRes.text().catch(() => '');
          throw new Error(`Preview update returned ${updateRes.status}: ${body.slice(0, 200)}`);
        }

        // Set preview URL with projectId path
        onPreviewUrlChange(`${previewBaseUrl}/preview/${projectId}/`);
        onPreviewStatusChange('ready');
      } catch (err) {
        console.error('[PromptService] Docker preview failed:', err);
        onPreviewStatusChange('failed');
      }

      if (!isGuestProject) {
        window.dispatchEvent(new CustomEvent('revision:created', { detail: { projectId } }));
      }
      onWorkflowComplete(true);

      const aiMessage = {
        role: 'assistant' as const,
        content: summary
          ? `${summary}\n\nYou can see the preview on the right. Want me to make any changes?`
          : 'Generated complete app successfully! You can see the preview on the right. Want me to make any changes?'
      };
      onMessageAdd(aiMessage);
      if (!isGuestProject) {
        await messageService.saveAssistantMessage(projectId, aiMessage.content);
      }

    } catch (error) {
      console.error('[PromptService] Error saving revision:', error);
      throw error;
    }
  },
};
