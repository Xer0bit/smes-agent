/**
 * think tool   structured reasoning scratchpad for the agent.
 *
 * This tool does nothing mechanically   it simply returns "OK". Its purpose
 * is to give the model a dedicated space to reason, plan, and analyze before
 * taking action. Research (Anthropic, OpenAI, Google) shows that agents
 * perform dramatically better when they "think out loud" before acting.
 *
 * The model should use this tool:
 *  1. At the START of every task to plan the approach
 *  2. Before complex multi-file edits to coordinate changes
 *  3. When analyzing errors to reason about root cause vs. symptom
 *  4. When stuck   to re-evaluate the approach instead of retrying blindly
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';

// ~500 words at ~6 chars/word   generous over the stated 400-word budget below,
// but a real limit. A prose-only "keep it under 400 words" was ignored badly
// enough in production (one think call hit 4,661 tokens, ~9x over, on a step
// that produced zero code) that it needs mechanical enforcement, not just a
// description the model can drift past.
const THOUGHT_MAX_CHARS = 3000;

const schema = z.object({
  thought: z.string().max(THOUGHT_MAX_CHARS, 'Too long   keep reasoning under ~400 words, bullet points only, no prose.').describe(
    'Your internal reasoning. Use this to: (1) Plan which files to create/edit and in what order, ' +
    '(2) Analyze what the user actually wants vs. what they literally said, ' +
    '(3) Consider edge cases and potential build errors before writing code, ' +
    '(4) Reason about component architecture decisions, ' +
    '(5) Debug errors by thinking through root causes.'
  ),
});

export const thinkTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'think',
  description:
    'Use this tool to plan, reason, and analyze BEFORE taking action. ' +
    'Call this at the start of every task to create a plan, before multi-file edits to coordinate changes, ' +
    'and when debugging to identify root causes. This is your internal scratchpad   the user does not see it. ' +
    'TOKEN BUDGET: For small changes (color, text, one-line fixes) keep your thought under 60 words. ' +
    'For multi-file builds keep it under 400 words. No prose   use bullet points.',
  inputSchema: schema,

  execute: async (_args: z.infer<typeof schema>, _ctx: AgentContext) => {
    return 'OK   thought recorded. Now proceed with your plan.';
  },
};
