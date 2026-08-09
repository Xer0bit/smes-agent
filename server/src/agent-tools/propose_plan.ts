/**
 * propose_plan tool   the ONLY tool available in plan mode (see
 * agentLoopService.ts's toolSet construction). Turns plan mode's output from
 * throwaway chat text into a persisted, structured artifact that a later
 * build run actually reads and executes against.
 *
 * Writes only to agent_plans   never touches project files, matching plan
 * mode's existing "never mutate the project" invariant. A new plan
 * supersedes any prior unexecuted one for the same project rather than
 * blocking (mirrors the snapshot-prune philosophy already used elsewhere).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

const schema = z.object({
  summary: z.string().min(1).max(500).describe(
    'One or two sentences describing what this plan will build, in plain language for the user.'
  ),
  steps: z.array(z.string().min(1).max(300)).min(1).max(30).describe(
    'Ordered, concrete implementation steps (e.g. "Create ProductCard.tsx with image, title, price", ' +
    '"Add products table with RLS read policy", "Wire ProductGrid into src/App.tsx"). ' +
    'These become a checklist injected into the build run once the user confirms   write them as ' +
    'actions to take, not vague goals.'
  ),
});

export const proposePlanTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'propose_plan',
  description:
    'Persist the plan you have discussed with the user as a structured, ordered list of implementation steps. ' +
    'Call this ONCE, near the end of a planning discussion, after the user has enough detail to react to. ' +
    'This does NOT touch any project files   it only saves the plan so that when the user says "build it" ' +
    '(or similar), the build run picks up these exact steps instead of starting cold. ' +
    'If the user asks for a different plan later, calling this again supersedes the previous one automatically.',
  inputSchema: schema,
  getConsentPreview: (args) => `Save plan: ${args.summary}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';
    if (!supabase) return 'ERROR: database not configured.';

    try {
      // Supersede any prior draft/approved plan for this project before
      // inserting the new one -- newest plan wins, silently, same as
      // checkpoints already behave (no blocking on an unexecuted prior plan).
      await supabase
        .from('agent_plans')
        .update({ status: 'superseded' })
        .eq('project_id', ctx.projectId)
        .in('status', ['draft', 'approved']);

      const { error } = await supabase.from('agent_plans').insert({
        project_id: ctx.projectId,
        user_id: ctx.userId,
        status: 'draft',
        summary: args.summary,
        steps: args.steps,
      });

      if (error) {
        logger.error(`[propose_plan] insert failed project=${ctx.projectId}: ${error.message}`, error);
        return `ERROR saving plan: ${error.message}`;
      }

      return (
        `Plan saved (${args.steps.length} step${args.steps.length === 1 ? '' : 's'}). ` +
        `Tell the user their plan is ready and ask them to say "build it" (or similar) when they want to start.`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[propose_plan] unexpected error project=${ctx.projectId}: ${message}`, err);
      return `ERROR saving plan: ${message}`;
    }
  },
};
