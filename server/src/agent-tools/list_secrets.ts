/**
 * list_secrets tool   lists which env vars/secrets already exist for this
 * project (names + masked preview only, never the real value) so the agent
 * can avoid asking the user to re-enter something that's already saved, and
 * knows which names to reference in generated code.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { supabase } from '../config/database.js';

const schema = z.object({});

export const listSecretsTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'list_secrets',
  description:
    'List the names of secrets/env vars already saved for this project (masked previews only, values are ' +
    'never returned). Call this before set_secret to check whether a key already exists, and to see which ' +
    'names are available to reference in code.',
  inputSchema: schema,
  getConsentPreview: () => 'List saved secrets (names only)',

  execute: async (_args, ctx: AgentContext) => {
    if (!ctx.projectId) return 'ERROR: no project context available.';
    const { data, error } = await supabase
      .from('project_secrets')
      .select('key_name, key_preview')
      .eq('project_id', ctx.projectId)
      .order('key_name', { ascending: true });
    if (error) return `ERROR: failed to list secrets: ${error.message}`;
    if (!data || data.length === 0) return 'No secrets saved yet for this project.';
    const lines = data.map((s: { key_name: string; key_preview: string }) =>
      `- ${s.key_name} (${s.key_preview})${s.key_name.startsWith('VITE_') ? '   usable in frontend code' : '   server/edge-function only'}`
    );
    return `Saved secrets (values hidden):\n${lines.join('\n')}`;
  },
};
