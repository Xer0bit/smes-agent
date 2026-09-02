/**
 * Message Service - Handles message persistence to database
 */
import { supabase } from '@/integrations/supabase/client';

export interface MessageAttachment {
  name: string;
  /** Optional: the dashboard hero-launch path forwards AgentAttachment, which
   * carries no size. Nothing renders it -- it is stored metadata only. */
  size?: number;
  type: string;
  url: string;
  category: 'image' | 'document';
}

export interface DbMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  attachments?: MessageAttachment[] | null;
}

const isValidUUID = (id: string | null | undefined) => {
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
};

export const messageService = {
  async saveUserMessage(projectId: string, content: string, userId?: string, attachments?: MessageAttachment[]): Promise<void> {
    if (!isValidUUID(projectId)) throw new Error('Invalid projectId');

    const row: Record<string, unknown> = { project_id: projectId, role: 'user', content };
    if (userId) row.user_id = userId;
    if (attachments && attachments.length > 0) row.attachments = attachments;

    const { error } = await supabase.from('messages').insert(row);
    if (error) {
      console.error('[MessageService] Error saving user message:', error);
      throw error;
    }
  },

  /**
   * Persist an assistant reply. Pass `messageId` (the run's stable assistant id)
   * to make this idempotent: every save for one run -- streamed done, an error
   * save, a retry after reconnect -- upserts the SAME row instead of inserting
   * a new one. Without it, one question produced three DB rows and rendered
   * three identical replies on the next history load.
   */
  async saveAssistantMessage(projectId: string, content: string, userId?: string, messageId?: string): Promise<void> {
    if (!isValidUUID(projectId)) throw new Error('Invalid projectId');

    const row: Record<string, unknown> = { project_id: projectId, role: 'assistant', content };
    if (userId) row.user_id = userId;

    // Upsert when a valid run-scoped id is given; plain insert otherwise so
    // callers that never pass one keep their old behaviour.
    if (messageId && isValidUUID(messageId)) {
      row.id = messageId;
      const { error } = await supabase.from('messages').upsert(row, { onConflict: 'id' });
      if (error) {
        console.error('[MessageService] Error upserting assistant message:', error);
        throw error;
      }
      return;
    }

    const { error } = await supabase.from('messages').insert(row);
    if (error) {
      console.error('[MessageService] Error saving assistant message:', error);
      throw error;
    }
  },

  async loadMessages(projectId: string): Promise<DbMessage[]> {
    if (!isValidUUID(projectId)) return [];

    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, created_at, attachments')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[MessageService] Error loading messages:', error);
      throw error;
    }

    return (data || []).map(m => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      created_at: m.created_at,
      attachments: m.attachments as MessageAttachment[] | null,
    }));
  },

  /** Load the most recent `limit` messages. Returns messages in asc order plus a hasMore flag. */
  async loadRecentMessages(projectId: string, limit = 30): Promise<{ messages: DbMessage[]; hasMore: boolean }> {
    if (!isValidUUID(projectId)) return { messages: [], hasMore: false };

    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, created_at, attachments')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (error) {
      console.error('[MessageService] Error loading recent messages:', error);
      throw error;
    }

    const rows = data || [];
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(m => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      created_at: m.created_at,
      attachments: m.attachments as MessageAttachment[] | null,
    }));

    return { messages, hasMore };
  },

  /** Load older messages before a given ISO timestamp cursor. Returns asc-ordered rows + hasMore. */
  async loadMessagesBefore(projectId: string, beforeTimestamp: string, limit = 20): Promise<{ messages: DbMessage[]; hasMore: boolean }> {
    if (!isValidUUID(projectId)) return { messages: [], hasMore: false };

    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, created_at, attachments')
      .eq('project_id', projectId)
      .lt('created_at', beforeTimestamp)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (error) {
      console.error('[MessageService] Error loading older messages:', error);
      throw error;
    }

    const rows = data || [];
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(m => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      created_at: m.created_at,
      attachments: m.attachments as MessageAttachment[] | null,
    }));

    return { messages, hasMore };
  },

  async clearMessages(projectId: string): Promise<void> {
    if (!isValidUUID(projectId)) return;
    await supabase.from('messages').delete().eq('project_id', projectId);
  },

  async incrementProjectMessageCount(projectId: string): Promise<void> {
    const { error } = await supabase.rpc('increment_message_count', {
      p_project_id: projectId,
    });
    if (error) console.error('[MessageService] Error incrementing message count:', error);
  },
};
