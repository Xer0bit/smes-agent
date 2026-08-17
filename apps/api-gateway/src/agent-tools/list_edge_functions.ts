/**
 * list_edge_functions tool   lists this project's edge functions with their
 * saved description, so the agent can check what already exists (and what it
 * does) without reading raw code out of __edge_functions__/ or guessing from
 * glob_files (which skips that directory entirely).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { supabase } from '../config/database.js';

const schema = z.object({});

export const listEdgeFunctionsTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'list_edge_functions',
  description:
    'List edge functions already saved for this project name, description, and access flags (no code). ' +
    'Call this before write_edge_function to check whether a function already covers what you need ' +
    'read_file the __edge_functions__/<name>.js mirror if you need the actual code.',
  inputSchema: schema,
  getConsentPreview: () => 'List saved edge functions',

  execute: async (_args, ctx: AgentContext) => {
    if (!ctx.projectId) return 'ERROR: no project context available.';
    const { data, error } = await supabase
      .from('edge_functions')
      .select('name, description, requires_service_role, is_public, updated_at')
      .eq('project_id', ctx.projectId)
      .order('name', { ascending: true });
    if (error) return `ERROR: failed to list edge functions: ${error.message}`;
    if (!data || data.length === 0) return 'No edge functions saved yet for this project.';
    const lines = data.map((f: {
      name: string;
      description: string | null;
      requires_service_role: boolean;
      is_public: boolean;
      updated_at: string;
    }) =>
      `- ${f.name}${f.description ? `: ${f.description}` : ' (no description saved)'} ` +
      `[${f.is_public ? 'public' : 'owner-only'}, ${f.requires_service_role ? 'service-role' : 'anon-role'}]`
    );
    return `Saved edge functions:\n${lines.join('\n')}\n\nRead __edge_functions__/<name>.js for the actual code.`;
  },
};
