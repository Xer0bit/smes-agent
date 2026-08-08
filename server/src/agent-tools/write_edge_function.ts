/**
 * write_edge_function tool   validates and STAGES an edge function for
 * deploy. Does NOT write the live DB row or sync to the execution host by
 * itself   see confirm_edge_function_deploy.ts, which does the actual
 * create/replace this file's execute() used to do directly.
 *
 * This is the ONLY write path for edge functions. The HTTP POST/PATCH on
 * /api/v1/functions is locked to users; only the agent (running server-side)
 * can create or modify edge functions via this tool (+ its confirm step).
 *
 * Code is validated against the actual sandbox contract (AST-based static
 * check via edgeFunctionValidator.ts   the same validator functionRunner.ts
 * re-applies at invoke time) BEFORE staging, so the agent gets a precise
 * error and can iterate to a working function instead of deploying broken code.
 *
 * Confirmation gate (2026-08 core-loop audit): a write_edge_function call
 * used to go live (DB upsert + VPS5 sync) the instant the model called it
 * zero visibility into what was about to become invocable in production.
 * Now it only validates, diffs against any existing function of the same
 * name, and stages the deploy into ctx.pendingEdgeFunctionDeploys; the model
 * must make a SEPARATE confirm_edge_function_deploy call to actually deploy.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { validateEdgeFunctionCode } from '../services/edgeFunctionValidator.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

// Edge function code is mirrored into the project's own file tree here so the
// agent's normal read_file/list_files/grep tools see what functions already
// exist (before this, functions were invisible outside the DB   the direct
// cause of the agent creating duplicate/orphaned functions instead of finding
// and reusing one that already did the job). The DB row remains the actual
// invocation source of truth; this file is a read/write mirror of it.
export const EDGE_FUNCTIONS_DIR = '__edge_functions__';

// Exported so confirm_edge_function_deploy.ts (the tool that actually writes
// the live row) enforces the same cap without duplicating the constant.
export const MAX_FUNCTIONS_PER_PROJECT = 20;

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
    'Validate and STAGE a server-side edge function for this project   does NOT go live by itself. ' +
    'USE THIS whenever logic must not run in the browser: anything touching a secret API key ' +
    '(Stripe, email, third-party APIs), webhook handlers, payment/checkout logic, sending emails, ' +
    'server-side validation, or multi-step backend operations. NEVER put a secret key or ' +
    'security-critical check in frontend code   save the key with set_secret, then read it here ' +
    'as `secrets.KEY_NAME`. ' +
    'The code runs in a locked sandbox: plain statements inside an async function body, `return` ' +
    'the result; scope provides params, db, secrets, fetch (HTTPS-only), console, ecg. ' +
    'No import/export/require, no npm packages, no process.env, 5s timeout. ' +
    'This call validates the code and returns a PENDING CONFIRMATION with a confirmationId and a summary ' +
    'of what would change   it does NOT write the live DB row or sync to the execution host. You MUST ' +
    'call confirm_edge_function_deploy with that confirmationId as a separate tool call to actually deploy. ' +
    'To modify an existing function, resubmit its full corrected code under the same name.',
  inputSchema: schema,

  getConsentPreview: (args) =>
    `Stage edge function: ${args.name}${args.description ? `   ${args.description}` : ''}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';

    const name = args.name.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      return 'ERROR: function name must start with a letter and be alphanumeric with hyphens/underscores only (max 64 chars).';
    }

    // ── Validate BEFORE staging   never let the model even get to a confirm
    // step for code that can't run. Same AST check functionRunner.ts
    // re-applies at invoke time (defense-in-depth against a DB row tampered
    // with directly, bypassing this tool). ─────────────────────────────────
    const issues = validateEdgeFunctionCode(args.code);
    if (issues.length > 0) {
      return (
        `ERROR: edge function "${name}" was NOT staged   ${issues.map(i => i.message).join('; ')} ` +
        `Fix the code and call write_edge_function again.`
      );
    }

    let existingCode: string | null = null;
    try {
      const { data: existing } = await supabase
        .from('edge_functions')
        .select('code')
        .eq('project_id', ctx.projectId)
        .eq('name', name)
        .maybeSingle();
      existingCode = existing?.code ?? null;
    } catch (err) {
      // Read-only lookup for the diff summary   not fatal if it fails, the
      // confirm step re-checks everything for real before deploying.
      logger.warn(`[write_edge_function] existing-function lookup failed for ${name}`, err);
    }

    if (!ctx.pendingEdgeFunctionDeploys) ctx.pendingEdgeFunctionDeploys = new Map();
    const confirmationId = crypto.randomUUID();
    ctx.pendingEdgeFunctionDeploys.set(confirmationId, {
      name,
      code: args.code,
      description: args.description,
      requiresServiceRole: args.requiresServiceRole,
      isPublic: args.isPublic,
      createdAt: Date.now(),
    });

    const newLines = args.code.split('\n').length;
    const verb = existingCode === null ? 'CREATE new function' : 'REPLACE existing function';
    const sizeDiff = existingCode === null
      ? `${newLines} lines`
      : `${existingCode.split('\n').length} lines → ${newLines} lines`;
    const codePreview = args.code.length > 1500 ? `${args.code.slice(0, 1500)}\n… (truncated)` : args.code;

    return (
      `PENDING CONFIRMATION   nothing was deployed yet. This will ${verb} named "${name}" (${sizeDiff}), ` +
      `which changes what real users can invoke in production, so it requires one extra confirmation step.\n\n` +
      `New code:\n${codePreview}\n\n` +
      `To actually deploy it, call confirm_edge_function_deploy with confirmationId: "${confirmationId}". ` +
      `If you decide NOT to deploy it (e.g. after reconsidering), simply don't call confirm   nothing happens.`
    );
  },
};
