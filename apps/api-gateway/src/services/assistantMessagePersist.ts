/**
 * Persist the run's answer server-side, keyed by the run id.
 *
 * Until now assistant messages were written ONLY by the browser -- a
 * `git grep "from('messages')"` over the server returned no insert or upsert,
 * and six client call sites did the writing. Two consequences:
 *
 *  1. A run whose browser closed completed server-side, wrote files, and its
 *     answer existed in NO store. The run-detachment work made runs outlive
 *     their connection, which made this MORE likely, not less.
 *  2. The six client paths disagreed about identity. Four passed a UUID and
 *     upserted; two plain-inserted, so a retry produced duplicate rows -- the
 *     triplicate-history bug, fixed in one implementation and not the other.
 *
 * Keying on the run id makes this idempotent by construction: every save for one
 * run targets the same row, whether it comes from the stream ending, a retry, or
 * a later reconnect. The client paths become a fallback and can then be removed.
 */
import { createHash } from 'node:crypto';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * A stable UUID derived from the run id.
 *
 * `messages.id` is a uuid, and agentRunId already is one -- but reusing it
 * verbatim would collide if anything else ever keyed a row by run id. Hashing
 * into a v5-shaped uuid keeps it deterministic (same run -> same row, so the
 * write is idempotent) while staying distinct from the run's own id.
 */
export function assistantMessageId(agentRunId: string): string {
  const h = createHash('sha256').update(`assistant-message:${agentRunId}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,                                   // version 5
    ((parseInt(h.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + h.slice(17, 20), // RFC-4122 variant
    h.slice(20, 32),
  ].join('-');
}

/**
 * Write (or overwrite) this run's assistant message.
 *
 * Best-effort: the answer has already been streamed to whoever is listening, so
 * a failure here costs history, not the response. Never throws.
 */
export async function persistAssistantMessage(opts: {
  projectId: string;
  agentRunId: string | null;
  userId?: string;
  content: string;
}): Promise<void> {
  const { projectId, agentRunId, userId, content } = opts;
  if (!supabase || !agentRunId || !projectId) return;
  if (!content.trim()) return; // nothing worth persisting

  try {
    const row: Record<string, unknown> = {
      id: assistantMessageId(agentRunId),
      project_id: projectId,
      role: 'assistant',
      content,
    };
    if (userId && !userId.startsWith('guest:')) row.user_id = userId;

    const { error } = await supabase.from('messages').upsert(row, { onConflict: 'id' });
    if (error) throw error;
    logger.debug('[assistantMessage] persisted server-side', { projectId, agentRunId });
  } catch (err) {
    logger.warn('[assistantMessage] server-side persist failed (client fallback still applies)', {
      projectId, agentRunId, error: (err as Error)?.message,
    });
  }
}
