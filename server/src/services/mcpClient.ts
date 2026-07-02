// Connects to an org-configured MCP server so the eCG dashboard chat can call
// its tools alongside the built-in portal tools (list_agents, approve_post, etc).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../utils/logger.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolset {
  tools: McpTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

// ponytail: per-request MCP connection, add a projectId-keyed cache if
// listTools latency becomes measurable — one remote MCP server per chat
// request is negligible next to the LLM round-trips already in this loop.
export async function getMcpTools(mcpUrl: string, mcpToken?: string): Promise<McpToolset | null> {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: mcpToken ? { headers: { Authorization: `Bearer ${mcpToken}` } } : undefined,
    });
    const client = new Client({ name: 'ecg-dashboard', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();

    return {
      tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })),
      callTool: async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        return result.content ?? result;
      },
    };
  } catch (err) {
    logger.warn('MCP server unreachable', { mcpUrl, error: err instanceof Error ? err.message : err });
    return null;
  }
}
