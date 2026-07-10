/**
 * set_secret tool — save an API key / env variable for the project so generated
 * code can reference it as a real environment variable, without ever putting the
 * raw value in a file, a chat message, or this tool's own result.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

const schema = z.object({
  key_name: z.string().describe(
    'Env var name, UPPER_SNAKE_CASE (letters, digits, underscores; must start with a letter or underscore). ' +
    "Use a VITE_ prefix if the value must be readable from frontend code (import.meta.env.VITE_X); omit it for " +
    'server-only/edge-function secrets that should never reach the browser bundle.'
  ),
  value: z.string().min(1).describe('The secret value to store. Never echo this back or log it.'),
  description: z.string().optional().describe('Optional short note on what this secret is for.'),
});

function previewBase(): string {
  return (process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
}

export const setSecretTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'set_secret',
  description:
    'Save a project secret / environment variable (API key, token, etc.) so it becomes available to ' +
    'the running app as a real env var — never write secret values directly into source files. ' +
    'After saving, reference the variable by NAME in code: `import.meta.env.KEY_NAME` in frontend code ' +
    '(only works if the key starts with VITE_), or `secrets.KEY_NAME` inside edge functions written with ' +
    'write_edge_function. Call list_secrets first to check what already exists before asking the user to ' +
    'repeat a value. CRITICAL: never print, log, repeat, or restate the secret value in your response to ' +
    'the user — only confirm that it was saved.',
  inputSchema: schema,
  getConsentPreview: (args) => `Save secret ${args.key_name} (value hidden)`,

  execute: async (args, ctx: AgentContext) => {
    const keyName = args.key_name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!/^[A-Z_][A-Z0-9_]*$/.test(keyName)) {
      return `ERROR: "${args.key_name}" is not a valid env var name. Use UPPER_SNAKE_CASE only.`;
    }
    if (!ctx.projectId) return 'ERROR: no project context available.';

    const value = args.value;
    const preview = value.length > 4 ? `****${value.slice(-4)}` : '****';

    try {
      const { error } = await supabase.from('project_secrets').upsert(
        [{ project_id: ctx.projectId, key_name: keyName, key_value: value, key_preview: preview }],
        { onConflict: 'project_id,key_name' }
      );
      if (error) throw new Error(error.message);

      // Push the FULL current secret set to the live preview so it's usable
      // immediately as import.meta.env.KEY_NAME (Vite only reads .env.local at
      // server startup, so the preview-service endpoint restarts it for us).
      try {
        const { data: allSecrets } = await supabase
          .from('project_secrets')
          .select('key_name, key_value')
          .eq('project_id', ctx.projectId);
        const secretsUrl = `${previewBase()}/preview/${ctx.projectId}/secrets`;
        await fetch(secretsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
          },
          body: JSON.stringify({ secrets: allSecrets ?? [] }),
        });
      } catch (syncErr) {
        logger.warn('[set_secret] preview sync failed (secret is still saved)', syncErr);
      }

      ctx.onXmlComplete?.(
        `<ecomgear-write path="secrets/${keyName}" description="Saved secret ${keyName} (value hidden)" />`
      );

      const frontendUsable = keyName.startsWith('VITE_');
      return (
        `Saved secret "${keyName}" (value hidden — never display it). It is now live in the running preview.\n` +
        (frontendUsable
          ? `Reference it in frontend code as \`import.meta.env.${keyName}\`.`
          : `This key has no VITE_ prefix, so it is NOT exposed to frontend code. ` +
            `Use it inside an edge function (write_edge_function) as \`secrets.${keyName}\`. ` +
            `If you need it in the browser instead, save it again with a VITE_ prefix.`) +
        `\nDo not repeat the value back to the user — just confirm it's saved.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: failed to save secret "${keyName}": ${msg}`;
    }
  },
};
