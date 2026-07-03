/**
 * search_org_knowledge tool — lets the dev agent ground UI copy/content in
 * the org's real business knowledge (from the eCG Agents Portal knowledge
 * base) instead of inventing generic placeholder text. Only available for
 * projects with MCP enabled at Dashboard Creator launch time (ctx.ecgMcp).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';

const schema = z.object({
  query: z.string().describe('What to search for in the organization\'s knowledge base'),
});

export const searchOrgKnowledgeTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'search_org_knowledge',
  description:
    'Search the organization\'s knowledge base (brand voice, docs, business context) via the eCG Agents Portal MCP server. Use this to ground generated UI copy and content in real information instead of inventing placeholder text.',
  inputSchema: schema,
  getConsentPreview: (args) => `Search org knowledge: "${args.query}"`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.ecgMcp) return 'Error: this project has no eCG Agents Portal knowledge base connected.';

    const resp = await fetch(ctx.ecgMcp.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.ecgMcp.token ? { Authorization: `Bearer ${ctx.ecgMcp.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_knowledge', arguments: { query: args.query } },
      }),
    }).catch(() => null);

    if (!resp || !resp.ok) return 'Error: could not reach the knowledge base MCP server.';

    const data = await resp.json().catch(() => null) as { result?: { content?: { text?: string }[] }; error?: { message?: string } } | null;
    if (data?.error) return `Error: ${data.error.message ?? 'knowledge search failed'}`;
    const text = data?.result?.content?.map(c => c.text).filter(Boolean).join('\n') ?? '';
    return text || 'No matching knowledge found.';
  },
};
