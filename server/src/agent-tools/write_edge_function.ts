/**
 * write_edge_function tool — create or replace an edge function in the DB.
 *
 * This is the ONLY write path for edge functions. The HTTP POST/PATCH on
 * /api/v1/functions is locked to users; only the agent (running server-side)
 * can create or modify edge functions via this tool.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { supabase } from '../config/database.js';

const schema = z.object({
  name: z.string().describe(
    'Unique function name (alphanumeric, hyphens, underscores). ' +
    'Use the same name to overwrite an existing function.'
  ),
  code: z.string().describe(
    'Full JavaScript/TypeScript source for the edge function. ' +
    'The function receives (params, ctx) where ctx provides supabase client, ' +
    'ecg helper (if portal-linked), and fetch. Must export a default async function ' +
    'or be a self-contained module.'
  ),
  description: z.string().optional().describe(
    'Short description of what the function does (shown in the UI).'
  ),
});

export const writeEdgeFunctionTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'write_edge_function',
  description:
    "Create or update an edge function stored in the project's database. " +
    "Edge functions run server-side with access to the database, ECG portal APIs, " +
    "and user-defined secrets. Use this to add backend logic, scheduled tasks, " +
    "webhook handlers, or data transformations. " +
    "Provide the full function code — this overwrites any existing function with the same name. " +
    "After writing, the function is immediately invocable via POST /api/v1/functions/:name/invoke.",
  inputSchema: schema,
  modifiesState: true,

  getConsentPreview: (args) =>
    `Write edge function: ${args.name}${args.description ? ` — ${args.description}` : ''}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';

    const name = args.name.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return 'ERROR: function name must be alphanumeric with hyphens/underscores only.';
    }

    try {
      const { data, error } = await supabase
        .from('edge_functions')
        .upsert(
          {
            user_id: ctx.userId,
            name,
            description: args.description ?? null,
            code: args.code,
            is_active: true,
          },
          { onConflict: 'user_id,name' }
        )
        .select('id, name, created_at, updated_at')
        .single();

      if (error) return `ERROR writing edge function: ${error.message}`;

      const verb = data.created_at === data.updated_at ? 'Created' : 'Updated';
      return `${verb} edge function "${name}" (id: ${data.id}). It is active and invocable via POST /api/v1/functions/${name}/invoke.`;
    } catch (err: unknown) {
      return `ERROR writing edge function: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
