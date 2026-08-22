/**
 * test_edge_function tool -- actually INVOKE a deployed edge function and show
 * the agent the real response envelope.
 *
 * Gap this closes (2026-08-22): the agent could write_edge_function and
 * confirm_edge_function_deploy, but had no way to ever RUN one.
 * test_database_function covers SQL functions only. So every edge function
 * shipped unverified, and nothing in the loop could notice when one was wrong.
 *
 * That is not hypothetical. CardPro's `auth-login-v2` shipped to production
 * returning `{ message: 'Login successful', user: {} }` for a nonexistent email
 * with a deliberately wrong password -- it never checked credentials at all. A
 * single invocation would have caught it; nothing ever invoked it.
 *
 * The second thing this fixes is envelope blindness. The runner always wraps a
 * return value as `{ result, logs, durationMs }` (plus a top-level `error` when
 * the function throws). Generated frontends kept reading `data.user` instead of
 * `data.result.user`, or POSTing `{ action }` instead of `{ params: { action } }`
 * -- both silently "succeed" with HTTP 200 and then fail as
 * "x.map is not a function" or "Invalid response from server" far from the
 * cause. Showing the agent the verbatim envelope is what makes that mismatch
 * self-evident.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { supabase } from '../config/database.js';
import { databaseService } from '../services/database.service.js';

const schema = z.object({
  name: z.string().describe('Name of the deployed edge function to invoke (see list_edge_functions).'),
  params: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'The params object to send. It is wrapped as {"params": <this>} on the wire, which is the ' +
      'envelope the runner reads -- pass the INNER object only (e.g. {"action":"login","email":"..."}).',
    ),
});

const INVOKE_TIMEOUT_MS = 30_000;

export const testEdgeFunctionTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'test_edge_function',
  description:
    'Invoke a deployed edge function for real and return its exact response envelope (result, logs, ' +
    'durationMs, error). Use this after confirm_edge_function_deploy to VERIFY the function actually ' +
    'works before telling the user it is done, and to check the precise response shape your frontend ' +
    'code must unwrap. WARNING: this really executes against the live tenant database -- it is NOT ' +
    'rolled back (unlike test_database_function). For an auth function, prefer a deliberately invalid ' +
    'credential to confirm it REJECTS correctly; never invoke a destructive action to "see what happens".',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Invoke edge function ${args.name} to test it`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';
    if (!ctx.projectId) return 'ERROR: no project context available.';

    // Same owner resolution as confirm_edge_function_deploy: on an org project
    // ctx.userId is often a collaborator, and credentials live under the owner.
    const { data: projectRow } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', ctx.projectId)
      .maybeSingle();
    const ownerId = projectRow?.user_id ?? ctx.userId;

    const creds = await databaseService.getCredentials(ownerId, ctx.projectId);
    if (!creds) {
      return (
        'ERROR: no hosted database is provisioned for this project, so its edge functions are not ' +
        'invocable yet (invocation authenticates with the tenant anon key that provisioning creates). ' +
        'Call provision_database first.'
      );
    }

    const url = `${creds.api_url}/functions/${args.name}/invoke`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: creds.anon_key },
        body: JSON.stringify({ params: args.params ?? {} }),
        signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
      });
    } catch (err) {
      return `ERROR: could not reach the function host at ${url}: ${(err as Error).message}`;
    }

    const text = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `HTTP ${res.status}. Response was not JSON:\n${text.slice(0, 2000)}`;
    }

    const envelope = parsed as { result?: unknown; error?: unknown; logs?: unknown[]; durationMs?: number };
    const lines: string[] = [`HTTP ${res.status} from POST ${url}`];

    if (envelope.error !== undefined && envelope.error !== null) {
      // The function threw. This is the runner-level error field, and it is the
      // one a frontend should read as `error` -- NOT the same as a `{ error }`
      // value the function itself chose to return, which lands inside `result`.
      lines.push(`THREW: ${String(envelope.error)}`);
    }

    const result = envelope.result;
    lines.push(`result: ${JSON.stringify(result, null, 2)?.slice(0, 4000) ?? 'undefined'}`);

    // The exact mistake that broke CardPro and the Pokemon project. Say it
    // explicitly rather than hoping the agent infers it from the JSON above.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const keys = Object.keys(result as Record<string, unknown>);
      lines.push(
        `\nFRONTEND UNWRAP: the value above is nested under "result". Your frontend must read ` +
        `\`(await res.json()).result\` -- e.g. ${keys.slice(0, 3).map((k) => `result.${k}`).join(', ')}` +
        `${keys.length ? '' : ' (empty object -- the function returned no fields)'}. ` +
        `Reading \`data.${keys[0] ?? 'x'}\` directly off the parsed body gets undefined.`,
      );
      if ((result as Record<string, unknown>).error !== undefined) {
        lines.push(
          `NOTE: the function returned its own "error" field INSIDE result, and the HTTP status is ` +
          `${res.status}. A frontend that only checks the top-level \`error\` will treat this as ` +
          `success and then fail on the shape. Check \`result.error\` too.`,
        );
      }
    }

    if (Array.isArray(envelope.logs) && envelope.logs.length > 0) {
      lines.push(`\nconsole output:\n${envelope.logs.map((l) => `  ${String(l)}`).join('\n').slice(0, 2000)}`);
    }
    if (typeof envelope.durationMs === 'number') lines.push(`\nran in ${envelope.durationMs}ms`);

    return lines.join('\n');
  },
};
