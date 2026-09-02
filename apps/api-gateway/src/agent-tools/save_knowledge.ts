/**
 * save_knowledge tool: the agent decides what future runs must remember.
 *
 * Recording every exchange verbatim (the first cut of project knowledge)
 * produced a row per run, most of them noise. What is worth carrying forward
 * is a small set of durable facts: a decision the owner made, a constraint,
 * how the data model or an integration is shaped, a gotcha discovered the
 * hard way. The model is the one that knows which of those just happened,
 * so it names them explicitly here.
 *
 * Keyed by a slug of the heading: saving "Payment provider" twice updates one
 * row instead of stacking versions. The owner sees, archives and deletes
 * these in Settings → Knowledge like any other chunk.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { recordKnowledge, knowledgeSlug } from '../services/knowledge.service.js';

const schema = z.object({
  heading: z.string().min(3).max(120).describe(
    'Short label for the fact, e.g. "Currency and locale", "Auth flow", "Do not rebuild the header". ' +
    'Saving the same heading again replaces the earlier fact.'
  ),
  content: z.string().min(10).max(2000).describe(
    'The fact itself, 1-6 sentences. Durable things only: owner decisions, constraints, how the data ' +
    'model / integrations / auth are shaped, a mistake that must not be repeated. Never code, never ' +
    'what any file already says, never a summary of this conversation.'
  ),
});

export const saveKnowledgeTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'save_knowledge',
  description:
    'Remember something for future runs on this project. Call it when the owner states a decision or ' +
    'constraint ("always HKD", "keep the old checkout"), when you learn how an integration or the data ' +
    'model really works, or when you hit a gotcha the next run would otherwise repeat. Do NOT save code, ' +
    'file contents, or a recap of this conversation. At most a couple of calls per run; most runs need none. ' +
    'The owner can see, archive and delete everything you save.',
  inputSchema: schema,

  execute: async (args, ctx: AgentContext) => {
    await recordKnowledge(ctx.projectId, [{
      source: 'agent',
      source_ref: `agent:${knowledgeSlug(args.heading)}`,
      heading: args.heading.trim(),
      content: args.content.trim(),
    }]);
    return `Saved "${args.heading.trim()}" to project knowledge. It will be offered to future runs when relevant; the owner can archive or delete it.`;
  },
};
