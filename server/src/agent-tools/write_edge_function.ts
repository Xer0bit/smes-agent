/**
 * write_edge_function tool   create or replace an edge function in the DB.
 *
 * This is the ONLY write path for edge functions. The HTTP POST/PATCH on
 * /api/v1/functions is locked to users; only the agent (running server-side)
 * can create or modify edge functions via this tool.
 *
 * Code is validated against the actual sandbox contract (AST-based static
 * check via edgeFunctionValidator.ts   the same validator functionRunner.ts
 * re-applies at invoke time) BEFORE saving, so the agent gets a precise
 * error and can iterate to a working function instead of deploying broken code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';
import { validateEdgeFunctionCode } from '../services/edgeFunctionValidator.js';
import { supabase } from '../config/database.js';
import { databaseService } from '../services/database.service.js';
import { logger } from '../utils/logger.js';

// Edge function code is mirrored into the project's own file tree here so the
// agent's normal read_file/list_files/grep tools see what functions already
// exist (before this, functions were invisible outside the DB   the direct
// cause of the agent creating duplicate/orphaned functions instead of finding
// and reusing one that already did the job). The DB row remains the actual
// invocation source of truth; this file is a read/write mirror of it.
export const EDGE_FUNCTIONS_DIR = '__edge_functions__';

const MAX_FUNCTIONS_PER_PROJECT = 20;

const schema = z.object({
  name: z.string().describe(
    'Unique function name (alphanumeric, hyphens, underscores). ' +
    'Use the same name to overwrite an existing function. Before creating a NEW ' +
    'function, list_files or read_file the __edge_functions__/ directory first   ' +
    'every existing function for this project is mirrored there as __edge_functions__/' +
    '<name>.js. Extend an existing function instead of writing a near-duplicate one.'
  ),
  code: z.string().describe(
    'JavaScript source that runs INSIDE an async function body   write plain statements ' +
    'and `return` the JSON-serializable result at the end. NO import/export/require (they ' +
    'are syntax errors in this sandbox). Available in scope: `params` (caller input object), ' +
    '`db` (hosted-database helper: db.select/insert/update/delete/rpc), `secrets` (read-only ' +
    'map of the project\'s saved secrets, e.g. secrets.STRIPE_SECRET_KEY), `fetch` (HTTPS-only, ' +
    'no internal hosts), `console` (logs captured and shown to the owner), and `ecg` (portal ' +
    'helper, null unless portal-linked). Top-level await is fine. Hard limit: 5s execution.'
  ),
  description: z.string().optional().describe(
    'Short description of what the function does (shown in the UI and chat).'
  ),
  requiresServiceRole: z.boolean().optional().describe(
    'Defaults to true. Set to FALSE for functions that only need to READ data the anon role can ' +
    'already see (e.g. public listings) -- they run with the project\'s anon key instead of the ' +
    'RLS-bypassing service key, so a bug or injection in the function\'s own logic can\'t write or ' +
    'read outside what RLS already allows anonymous callers. Leave true (default) for anything ' +
    'that writes data, or reads something RLS would otherwise block (most functions).'
  ),
  isPublic: z.boolean().optional().describe(
    'Defaults to true (invocable with the project\'s public anon/service key, same as every other ' +
    'function). Set to FALSE for admin-only operations (e.g. deleting other users\' data, financial ' +
    'operations) that must only run for the project OWNER\'s own authenticated session -- an anon ' +
    'key holder (any visitor to the generated app) will be rejected.'
  ),
});

export const writeEdgeFunctionTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'write_edge_function',
  description:
    'Create or update a server-side edge function for this project. ' +
    'USE THIS whenever logic must not run in the browser: anything touching a secret API key ' +
    '(Stripe, email, third-party APIs), webhook handlers, payment/checkout logic, sending emails, ' +
    'server-side validation, or multi-step backend operations. NEVER put a secret key or ' +
    'security-critical check in frontend code   save the key with set_secret, then read it here ' +
    'as `secrets.KEY_NAME`. ' +
    'The code runs in a locked sandbox: plain statements inside an async function body, `return` ' +
    'the result; scope provides params, db, secrets, fetch (HTTPS-only), console, ecg. ' +
    'No import/export/require, no npm packages, no process.env, 5s timeout. ' +
    'Overwrites any existing function with the same name IN THIS PROJECT ONLY   to modify a ' +
    'function, resubmit its full corrected code under the same name. ' +
    'Works without a hosted database (db.* calls just error), but the generated app\'s frontend ' +
    'needs VITE_DB_ANON_KEY (provisioned with the hosted database) to invoke it   without a ' +
    'database only the project owner can invoke from Settings. ' +
    'After writing, tell the user in plain words what the function does, what inputs it expects, ' +
    'and where the frontend calls it.',
  inputSchema: schema,
  modifiesState: true,

  getConsentPreview: (args) =>
    `Write edge function: ${args.name}${args.description ? `   ${args.description}` : ''}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';

    const name = args.name.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      return 'ERROR: function name must start with a letter and be alphanumeric with hyphens/underscores only (max 64 chars).';
    }

    // ── Validate BEFORE saving   never deploy code that can't run. Same AST
    // check functionRunner.ts re-applies at invoke time (defense-in-depth
    // against a DB row tampered with directly, bypassing this tool). ────────
    const issues = validateEdgeFunctionCode(args.code);
    if (issues.length > 0) {
      return (
        `ERROR: edge function "${name}" was NOT saved   ${issues.map(i => i.message).join('; ')} ` +
        `Fix the code and call write_edge_function again.`
      );
    }

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
            description: args.description ?? null,
            code: args.code,
            is_active: true,
            requires_service_role: args.requiresServiceRole ?? true,
            is_public: args.isPublic ?? true,
          },
          { onConflict: 'project_id,name' }
        )
        .select('id, name, created_at, updated_at')
        .single();

      if (error) {
        logger.error(`[write_edge_function] upsert failed project=${ctx.projectId} name=${name}: ${error.message}`, error);
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
        fs.writeFileSync(mirrorFullPath, args.code, 'utf8');
        ctx.pendingPreviewFiles?.set(mirrorRelPath, args.code);
      } catch (mirrorErr) {
        // Non-fatal   the DB row (the actual invocation source) already
        // saved successfully above. Log and continue.
        logger.warn(`[write_edge_function] mirror write failed for ${mirrorRelPath}: ${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)}`);
      }

      const chipDesc = `${verb} edge function${args.description ? `: ${args.description}` : ''}`.replace(/"/g, '&quot;');
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
          const grants = await databaseService.ensureFunctionDbAccess(ownerId, ctx.projectId, args.code);
          if (grants.length > 0) {
            permissionNote = `\nSelf-healed database permissions before first use: ${grants.join('; ')}.`;
          }
        } catch (preflightErr) {
          logger.warn(`[write_edge_function] permission preflight error for ${name}`, preflightErr);
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
                  name, code: args.code, is_active: true,
                  project_id: ctx.projectId, user_id: ownerId,
                }),
              });
              if (syncRes.ok) {
                syncStatus = 'synced';
              } else {
                syncStatus = 'failed';
                logger.warn(`[write_edge_function] VPS5 sync failed for ${name}: ${syncRes.status} ${await syncRes.text()}`);
              }
            } else {
              syncStatus = 'skipped_no_secret';
              logger.warn('[write_edge_function] FUNCTIONS_INTERNAL_SECRET not set   skipped VPS5 sync.');
            }
          }
        } catch (syncErr) {
          syncStatus = 'failed';
          logger.warn(`[write_edge_function] VPS5 sync error for ${name}`, syncErr);
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
      // silently claiming success (this was previously a silent no-op --
      // 2026-08 stability review, Step 8).
      const syncWarning = syncStatus === 'failed'
        ? `\n⚠️ SYNC FAILED: the code saved here but did NOT reach the execution host. ` +
          `POST ${invokeUrl} will likely fail or run stale code until this is retried (call write_edge_function ` +
          `again to retry the sync, or tell the user this function is not yet live).`
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
      logger.error(`[write_edge_function] unexpected failure project=${ctx.projectId} name=${name}`, err);
      return `ERROR writing edge function: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
