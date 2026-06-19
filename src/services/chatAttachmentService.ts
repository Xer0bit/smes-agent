/**
 * Chat Attachment Service
 * Uploads files to the backend /tmp storage for use in the agent chat.
 * No Supabase storage bucket required — files live in /tmp with auto-cleanup.
 */
import { getGenServerCandidateUrls } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  /** Local object URL for preview in the chat bubble (revoked on unmount) */
  previewUrl: string;
  /** Server-side temp path — sent to the agent loop */
  tempPath: string;
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
  _userId: string,
  projectId: string,
): Promise<ChatAttachment> {
  const check = isAllowedFile(file);
  if (!check.ok) throw new Error(check.reason);

  // Get auth token
  const { data: { session } } = await lovableCloud.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const formData = new FormData();
  formData.append('projectId', projectId);  // must come before file so req.body is populated when multer destination runs
  formData.append('file', file);

  const urls = getGenServerCandidateUrls('/api/v1/ai/upload-attachment');
  let lastError = '';

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
      return {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: URL.createObjectURL(file),
        tempPath: result.tempPath,
        category: categorize(file.type),
      };
    } catch (err: any) {
      lastError = err.message;
    }
  }

  throw new Error(`Upload failed: ${lastError}`);
}

/**
 * Format a human-readable file size.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
