/**
 * Chat Attachment Service
 * Uploads files to BOTH the backend /tmp storage (for the agent to read from
 * disk) AND Supabase Storage (permanent URL for message persistence). The
 * public URL survives reloads; the temp path is ephemeral and cleaned up.
 */
import { getGenServerCandidateUrls } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';
import { supabase } from '@/integrations/supabase/client';

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  /** Local object URL for preview in the chat bubble (revoked on unmount) */
  previewUrl: string;
  /** Server-side temp path — sent to the agent loop */
  tempPath: string;
  /** Permanent Supabase Storage URL — persists across reloads */
  publicUrl: string;
  /** 'image' | 'document' — determines rendering */
  category: 'image' | 'document';
}

const IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
]);

const ALLOWED_TYPES = new Set([
  ...IMAGE_TYPES,
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function isAllowedFile(file: File): { ok: boolean; reason?: string } {
  if (!ALLOWED_TYPES.has(file.type)) {
    return { ok: false, reason: `Unsupported file type: ${file.type || 'unknown'}` };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, reason: `File too large (max 10 MB)` };
  }
  return { ok: true };
}

export function categorize(mimeType: string): 'image' | 'document' {
  return IMAGE_TYPES.has(mimeType) ? 'image' : 'document';
}

/**
 * Upload a file to the backend temp storage.
 * The backend stores it in /tmp/ecomgear-chat-uploads/{projectId}/ and returns
 * a tempPath the agent loop can read directly from disk.
 */
export async function uploadChatAttachment(
  file: File,
  userId: string,
  projectId: string,
): Promise<ChatAttachment> {
  const check = isAllowedFile(file);
  if (!check.ok) throw new Error(check.reason);

  // Get auth token
  const { data: { session } } = await lovableCloud.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  // ── Step 1: Upload to backend /tmp (agent reads from disk) ────────────
  const formData = new FormData();
  formData.append('projectId', projectId);
  formData.append('file', file);

  const urls = getGenServerCandidateUrls('/api/v1/ai/upload-attachment');
  let lastError = '';
  let tempPath = '';

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!resp.ok) {
        const body = await resp.text();
        lastError = body || `HTTP ${resp.status}`;
        continue;
      }

      const result = await resp.json();
      tempPath = result.tempPath;
      break;
    } catch (err: any) {
      lastError = err.message;
    }
  }

  if (!tempPath) throw new Error(`Upload failed: ${lastError}`);

  // ── Step 2: Upload to the (private) chat-attachments bucket for a durable URL ──
  // RLS on this bucket requires the path to start with the uploader's own
  // auth.uid() (see supabase/migrations/20260402120000_chat_attachments_bucket.sql).
  // Falls back to the local blob URL if storage upload fails — the chat works
  // for the current session, but the attachment won't survive reload (a
  // message with no publicUrl gets dropped when saved, see AgentChatPanel.tsx).
  const storagePath = `${userId}/${projectId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  let publicUrl = '';
  try {
    const { error: uploadError } = await supabase.storage
      .from('chat-attachments')
      .upload(storagePath, file, { upsert: false, contentType: file.type });
    if (uploadError) {
      console.error('Chat attachment storage upload failed — image will not persist after reload:', uploadError);
    } else {
      // Bucket is private — a public URL 403s. Sign it for 5 years, effectively
      // permanent for chat history purposes.
      const { data: signedData, error: signError } = await supabase.storage
        .from('chat-attachments')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 5);
      if (signError) console.error('Chat attachment signed URL failed:', signError);
      publicUrl = signedData?.signedUrl ?? '';
    }
  } catch (err) {
    console.error('Chat attachment storage upload threw — image will not persist after reload:', err);
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type,
    previewUrl: URL.createObjectURL(file),
    tempPath,
    publicUrl,
    category: categorize(file.type),
  };
}

/**
 * Format a human-readable file size.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
