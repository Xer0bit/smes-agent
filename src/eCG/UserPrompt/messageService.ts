/**
 * Message Service - Handles message persistence to database
 */
import { supabase } from '@/integrations/supabase/client';

export interface DbMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

const isValidUUID = (id: string | null | undefined) => {
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
};

export const messageService = {
  async saveUserMessage(projectId: string, content: string, userId?: string): Promise<void> {
    if (!isValidUUID(projectId)) throw new Error('Invalid projectId');

    const row: Record<string, unknown> = { project_id: projectId, role: 'user', content };
    if (userId) row.user_id = userId;

    const { error } = await supabase.from('messages').insert(row);
    if (error) {
      console.error('[MessageService] Error saving user message:', error);
      throw error;
    }
  },

  async saveAssistantMessage(projectId: string, content: string, userId?: string): Promise<void> {
    if (!isValidUUID(projectId)) throw new Error('Invalid projectId');

    const row: Record<string, unknown> = { project_id: projectId, role: 'assistant', content };
    if (userId) row.user_id = userId;

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
      .select('id, role, content, created_at')
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
    }));
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
