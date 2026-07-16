/**
 * find_symbol_usages tool — function/component-level call graph lookup.
 *
 * Answers "what calls this" / "what would break if I change this" without a
 * grep sweep across the whole project. Reuses the symbol graph already built
 * and kept up to date on every file write (server/src/knowledgebase/symbolGraph.ts)
 * — this just exposes the existing getBlastRadius() query as an agent tool;
 * nothing new is indexed here.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { getBlastRadius } from '../knowledgebase/index.js';

const schema = z.object({
  symbol_name: z.string().describe('The exact function/component/hook name to look up, e.g. "CartTotal" or "useAuth"'),
});

export const findSymbolUsagesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'find_symbol_usages',
  description:
    'Find where a function/component/hook is defined and everywhere it is called or rendered — use this before renaming, changing a signature, or deleting a symbol, to see the blast radius instead of grepping the whole project.',
  inputSchema: schema,
  getConsentPreview: (args) => `Find usages of "${args.symbol_name}"`,

  execute: async (args, ctx: AgentContext) => {
    const { target, callers, calleeNames } = await getBlastRadius(ctx.projectId, args.symbol_name);

    if (target.length === 0 && callers.length === 0) {
      return `No symbol named "${args.symbol_name}" found in the indexed graph. It may be new, not yet indexed, or misspelled — fall back to grep.`;
    }

    const lines: string[] = [];
    if (target.length > 0) {
      lines.push('Defined at:');
      for (const t of target) lines.push(`  ${t.file_path} (${t.kind})`);
    }
    if (calleeNames.length > 0) {
      lines.push(`Calls/renders: ${calleeNames.join(', ')}`);
    }
    if (callers.length > 0) {
      lines.push(`Called/rendered by (${callers.length}):`);
      for (const c of callers) lines.push(`  ${c.symbol_name} in ${c.file_path}`);
    } else {
      lines.push('No callers found in the indexed graph — likely unused, or only called from a file not yet indexed.');
    }
    return lines.join('\n');
  },
};
