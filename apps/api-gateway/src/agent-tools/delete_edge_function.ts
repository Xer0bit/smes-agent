/**
 * delete_edge_function tool   remove an edge function from the DB and VPS5.
 *
 * This is the ONLY delete path for edge functions now. The Settings UI's
 * DELETE endpoint is locked (403)   same policy as create/update   so a
 * user asks the agent to remove a function instead of doing it manually
 * behind the agent's back.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';
import { supabase } from '../config/database.js';
import { databaseService } from '../services/database.service.js';
import { logger } from '../utils/logger.js';
import { EDGE_FUNCTIONS_DIR } from './write_edge_function.js';
import fs from 'node:fs';

const schema = z.object({
  name: z.string().describe('Name of the edge function to delete (matches the __edge_functions__/<name>.js mirror).'),
});

export const deleteEdgeFunctionTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'delete_edge_function',
  description:
    'Delete an edge function permanently   removes the DB row, the VPS5 copy, and the __edge_functions__/<name>.js mirror. ' +
    'Use when a function is no longer needed or is being replaced. This cannot be undone.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Delete edge function: ${args.name}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.projectId) return 'ERROR: no project context available.';
    const name = args.name.trim();

    const { data: projectRow } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', ctx.projectId)
      .maybeSingle();
    const ownerId = projectRow?.user_id ?? ctx.userId;

    const { error } = await supabase
      .from('edge_functions')
      .delete()
      .eq('project_id', ctx.projectId)
      .eq('name', name);
    if (error) return `ERROR deleting edge function "${name}": ${error.message}`;

    // Same partial-failure classes as confirm_edge_function_deploy.ts's
    // create/update path -- but unlike that path, this used to swallow the
    // outcome into a log line and unconditionally report "Deleted". The DB
    // row (and UI, and local mirror) would show the function gone while the
    // actual code kept running, invocable, on VPS5 -- a deleted function a
    // real end user could still hit, with the agent confidently telling the
    // user it was removed. Track and surface it honestly instead.
    let syncStatus: 'deactivated' | 'skipped_no_secret' | 'failed' | 'not_applicable' = 'not_applicable';
    try {
      const creds = await databaseService.getCredentials(ownerId, ctx.projectId);
      const internalSecret = process.env.FUNCTIONS_INTERNAL_SECRET;
      if (creds && internalSecret) {
        const syncRes = await fetch(`${creds.api_url}/functions/_sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret },
          body: JSON.stringify({ name, code: '', is_active: false, project_id: ctx.projectId, user_id: ownerId }),
        });
        syncStatus = syncRes.ok ? 'deactivated' : 'failed';
        if (!syncRes.ok) {
          logger.warn(`[delete_edge_function] VPS5 deactivate sync failed for ${name}: ${syncRes.status} ${await syncRes.text()}`);
        }
      } else if (creds && !internalSecret) {
        syncStatus = 'skipped_no_secret';
      }
    } catch (syncErr) {
      syncStatus = 'failed';
      logger.warn(`[delete_edge_function] VPS5 deactivate sync failed for ${name}`, syncErr);
    }

    try {
      const mirrorFullPath = safeJoin(ctx.appPath, `${EDGE_FUNCTIONS_DIR}/${name}.js`);
      if (fs.existsSync(mirrorFullPath)) fs.unlinkSync(mirrorFullPath);
      ctx.pendingPreviewFiles?.delete(`${EDGE_FUNCTIONS_DIR}/${name}.js`);
    } catch (mirrorErr) {
      logger.warn(`[delete_edge_function] mirror cleanup failed for ${name}`, mirrorErr);
    }

    ctx.onXmlComplete?.(`<ecomgear-delete path="${EDGE_FUNCTIONS_DIR}/${name}.js"></ecomgear-delete>`);

    const syncWarning = syncStatus === 'failed'
      ? `\n⚠️ SYNC FAILED: the DB row was removed, but the code was NOT deactivated on the execution host. ` +
        `It may still be invocable on VPS5 until this is retried. Tell the user this deletion is incomplete.`
      : syncStatus === 'skipped_no_secret'
      ? `\n⚠️ SYNC SKIPPED: this server is not configured to push deactivations to the execution host ` +
        `(FUNCTIONS_INTERNAL_SECRET unset). The function may still be invocable on VPS5. Tell the user this ` +
        `deletion needs a server-side configuration fix to fully take effect.`
      : '';

    return `Deleted edge function "${name}". Remove any frontend code that still calls it, or it will fail with "Function not found".${syncWarning}`;
  },
};
