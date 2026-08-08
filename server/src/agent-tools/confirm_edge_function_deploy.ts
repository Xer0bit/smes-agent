/**
 * confirm_edge_function_deploy tool   actually deploys an edge function
 * staged by write_edge_function: upserts the live DB row, mirrors the code
 * to disk, and syncs to the VPS5 execution host. Second half of the deploy
 * confirmation gate (2026-08 core-loop audit)   see write_edge_function.ts
 * for why this is split out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';
import { supabase } from '../config/database.js';
import { databaseService } from '../services/database.service.js';
import { logger } from '../utils/logger.js';
import { EDGE_FUNCTIONS_DIR, MAX_FUNCTIONS_PER_PROJECT } from './write_edge_function.js';

const schema = z.object({
  confirmationId: z.string().describe(
    'The confirmationId returned by a prior write_edge_function call.'
  ),
});

export const confirmEdgeFunctionDeployTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'confirm_edge_function_deploy',
  description:
    'Deploy an edge function that write_edge_function staged (it returns a PENDING CONFIRMATION ' +
    'message with a confirmationId and a summary of the code). Call this ONLY after you are confident ' +
    'the staged code is correct   this makes it live and invocable in production. Each confirmationId ' +
    'can be used once.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Confirm and deploy pending edge function ${args.confirmationId}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';

    const pending = ctx.pendingEdgeFunctionDeploys?.get(args.confirmationId);
    if (!pending) {
      return (
        `ERROR: no pending edge function deploy found for confirmationId "${args.confirmationId}". ` +
        `Either it was already confirmed, it expired with this run, or it was never staged   ` +
        `call write_edge_function first.`
      );
    }
    // One-shot: remove before deploying so a retried/duplicated confirm call
    // can't replay the same deploy twice.
    ctx.pendingEdgeFunctionDeploys!.delete(args.confirmationId);

    const { name, code, description, requiresServiceRole, isPublic } = pending;

    try {
      // Cap functions per project   prevents runaway generation loops.
      const { count } = await supabase
        .from('edge_functions')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', ctx.projectId);
      const { data: existing } = await supabase
        .from('edge_functions')
        .select('id')
        .eq('project_id', ctx.projectId)
        .eq('name', name)
        .maybeSingle();
      if (!existing && (count ?? 0) >= MAX_FUNCTIONS_PER_PROJECT) {
        return `ERROR: this project already has ${count} edge functions (limit ${MAX_FUNCTIONS_PER_PROJECT}). Consolidate related logic into one function or delete unused ones instead of adding more.`;
      }

      // The invoke endpoint (functions.routes.ts) looks up a function by
      // matching edge_functions.user_id against the PROJECT's owner
      // (projects.user_id), not the id of whoever is currently chatting. On
      // an org project, ctx.userId is often a collaborator, not the owner
      // saving under ctx.userId silently makes the function permanently
      // uninvokable (404 "Function not found") even though it saved fine and
      // the code is correct. Always save under the actual project owner.
      const { data: projectRow } = await supabase
        .from('projects')
        .select('user_id')
        .eq('id', ctx.projectId)
        .maybeSingle();
      const ownerId = projectRow?.user_id ?? ctx.userId;

      const { data, error } = await supabase
        .from('edge_functions')
        .upsert(
          {
            user_id: ownerId,
            project_id: ctx.projectId,
            name,
            description: description ?? null,
            code,
            is_active: true,
            requires_service_role: requiresServiceRole ?? true,
            is_public: isPublic ?? true,
          },
          { onConflict: 'project_id,name' }
        )
        .select('id, name, created_at, updated_at')
        .single();

      if (error) {
        logger.error(`[confirm_edge_function_deploy] upsert failed project=${ctx.projectId} name=${name}: ${error.message}`, error);
        return `ERROR writing edge function: ${error.message}`;
      }

      const verb = existing ? 'Updated' : 'Created';

      // Mirror to __edge_functions__/<name>.js   same write pattern as
      // write_file.ts (disk write + pendingPreviewFiles), so this shows up in
      // the file tree, the code viewer, and the run's preview push exactly
      // like any other file. NEVER served to the browser   preview-service
      // excludes this directory from the Vite build (see server.js).
      const mirrorRelPath = `${EDGE_FUNCTIONS_DIR}/${name}.js`;
      try {
        const mirrorFullPath = safeJoin(ctx.appPath, mirrorRelPath);
        fs.mkdirSync(path.dirname(mirrorFullPath), { recursive: true });
        fs.writeFileSync(mirrorFullPath, code, 'utf8');
        ctx.pendingPreviewFiles?.set(mirrorRelPath, code);
      } catch (mirrorErr) {
        // Non-fatal   the DB row (the actual invocation source) already
        // saved successfully above. Log and continue.
        logger.warn(`[confirm_edge_function_deploy] mirror write failed for ${mirrorRelPath}: ${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)}`);
      }

      const chipDesc = `${verb} edge function${description ? `: ${description}` : ''}`.replace(/"/g, '&quot;');
      ctx.onXmlComplete?.(`<ecomgear-write path="${mirrorRelPath}" description="${chipDesc}" />`);

      // Functions execute on VPS5, next to the tenant database   never on the
      // platform API. Sync the code there now so it's invocable immediately;
      // this is the ONLY write path for that copy, same as the DB row above.
      const dbStatus = await databaseService.getStatus(ctx.userId, ctx.projectId);
      let invokeUrl = '(provision a database first   invocation needs a tenant schema)';
      let permissionNote = '';
      // 'synced' | 'skipped_no_secret' | 'failed' | 'not_applicable' (no DB provisioned yet)
      let syncStatus: 'synced' | 'skipped_no_secret' | 'failed' | 'not_applicable' = 'not_applicable';
      if (dbStatus?.status === 'active') {
        // Permission preflight: a function that syntax-checks fine can still
        // 403 the first time a real user hits it, if it touches a table/RPC
        // that was never granted to this project's DB roles (e.g. pgcrypto
        // via extensions.crypt). Check and self-heal now instead of finding
        // out from a user's crash report later.
        try {
          const grants = await databaseService.ensureFunctionDbAccess(ownerId, ctx.projectId, code);
          if (grants.length > 0) {
            permissionNote = `\nSelf-healed database permissions before first use: ${grants.join('; ')}.`;
          }
        } catch (preflightErr) {
          logger.warn(`[confirm_edge_function_deploy] permission preflight error for ${name}`, preflightErr);
        }
        try {
          const creds = await databaseService.getCredentials(ownerId, ctx.projectId);
          if (creds) {
            invokeUrl = `${creds.api_url}/functions/${name}/invoke`;
            const internalSecret = process.env.FUNCTIONS_INTERNAL_SECRET;
            if (internalSecret) {
              const syncRes = await fetch(`${creds.api_url}/functions/_sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret },
                body: JSON.stringify({
                  name, code, is_active: true,
                  project_id: ctx.projectId, user_id: ownerId,
                }),
              });
              if (syncRes.ok) {
                syncStatus = 'synced';
              } else {
                syncStatus = 'failed';
                logger.warn(`[confirm_edge_function_deploy] VPS5 sync failed for ${name}: ${syncRes.status} ${await syncRes.text()}`);
              }
            } else {
              syncStatus = 'skipped_no_secret';
              logger.warn('[confirm_edge_function_deploy] FUNCTIONS_INTERNAL_SECRET not set   skipped VPS5 sync.');
            }
          }
        } catch (syncErr) {
          syncStatus = 'failed';
          logger.warn(`[confirm_edge_function_deploy] VPS5 sync error for ${name}`, syncErr);
        }
      }
      const noDbNote = (!dbStatus || dbStatus.status !== 'active')
        ? '\nNOTE: no hosted database is provisioned   db.* calls inside this function will error, and the ' +
          'app\'s frontend cannot invoke it yet (invocation authenticates with VITE_DB_ANON_KEY, which comes ' +
          'with the hosted database). The owner can still test it from Settings → Edge Functions. ' +
          'Mention this to the user if the function is meant to be called from the app.'
        : '';

      // The URL handed back is the VPS5-hosted invoke path (used by the
      // generated app's real frontend/end users). That path only works once
      // the code has actually reached VPS5 -- if the sync above didn't
      // succeed, saying "it is active and invocable" is false: the DB row and
      // local mirror are fine, but a real end user hitting invokeUrl will get
      // a 404/stale-code response until this resyncs. Surface that instead of
      // silently claiming success.
      const syncWarning = syncStatus === 'failed'
        ? `\n⚠️ SYNC FAILED: the code saved here but did NOT reach the execution host. ` +
          `POST ${invokeUrl} will likely fail or run stale code until this is retried (call write_edge_function ` +
          `and confirm again to retry the sync, or tell the user this function is not yet live).`
        : syncStatus === 'skipped_no_secret'
        ? `\n⚠️ SYNC SKIPPED: this server is not configured to push functions to the execution host ` +
          `(FUNCTIONS_INTERNAL_SECRET unset). The code is saved but NOT yet invocable at POST ${invokeUrl}. ` +
          `Tell the user this function needs a server-side configuration fix before it will work.`
        : '';

      const statusVerb = syncWarning ? 'saved (NOT yet synced to the execution host)' : 'active and invocable';

      return (
        `${verb} edge function "${name}" (id: ${data.id}). It is ${statusVerb} via ` +
        `POST ${invokeUrl}.${noDbNote}${permissionNote}${syncWarning}\n` +
        `Now tell the user, in plain words: what this function does, what params it expects, and which part ` +
        `of the app calls it. Never show secret values   refer to them by name only.`
      );
    } catch (err: unknown) {
      logger.error(`[confirm_edge_function_deploy] unexpected failure project=${ctx.projectId} name=${name}`, err);
      return `ERROR writing edge function: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
