/**
 * eCG Agents MCP client   speaks the legacy MCP "HTTP+SSE" transport this
 * server actually uses (confirmed by the official connect script: `claude mcp
 * add --transport sse ecg-agents https://mcp.ecomgear.ai/sse`), NOT the newer
 * Streamable-HTTP transport (a single POST endpoint returning `mcp-session-id`)
 * that src/base-example's own mcp-proxy edge function assumes for a generic
 * MCP server. POSTing directly to /sse 404s on this server   confirmed live.
 *
 * The real handshake:
 *   1. GET /sse with Authorization header, keep the connection open.
 *   2. Server's first SSE event is `event: endpoint`, whose data is the actual
 *      URL to POST JSON-RPC requests to for this session (session id baked
 *      into the URL as a query param).
 *   3. POST each JSON-RPC request to that endpoint URL (the POST response
 *      itself is just an ack, e.g. 202).
 *   4. The real result arrives asynchronously as a `event: message` on the
 *      SAME still-open GET stream from step 1, correlated by the request's
 *      `id`.
 */
import { logger } from '../utils/logger.js';

const MCP_SSE_URL = process.env.ECG_MCP_URL || 'https://mcp.ecomgear.ai/sse';
const SESSION_TIMEOUT_MS = 20_000;

interface SseEvent {
  event: string;
  data: string;
}

/** Parses complete "event: X\ndata: Y\n\n" blocks out of a growing text buffer. */
function extractEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: SseEvent[] = [];
  for (const chunk of parts) {
    const lines = chunk.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

class McpSseSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private pumpError: Error | null = null;
  private pumping: Promise<void>;

  constructor(private postUrl: string, reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
    this.pumping = this.pump();
  }

  static async open(apiKey: string): Promise<McpSseSession> {
    const res = await fetch(MCP_SSE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`eCG Agents MCP server returned HTTP ${res.status} opening session${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + SESSION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) throw new Error('eCG Agents MCP stream closed before session was established');
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = extractEvents(buffer);
      buffer = rest;
      for (const ev of events) {
        if (ev.event === 'endpoint') {
          const postUrl = new URL(ev.data, MCP_SSE_URL).toString();
          const session = new McpSseSession(postUrl, reader);
          session.buffer = buffer; // carry over anything already read past the endpoint event
          session.decoder = decoder;
          return session;
        }
      }
    }
    throw new Error('eCG Agents MCP server never sent a session endpoint (timed out)');
  }

  /** Reads from the open GET stream forever, resolving pending calls as their responses arrive. */
  private async pump(): Promise<void> {
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        const { events, rest } = extractEvents(this.buffer);
        this.buffer = rest;
        for (const ev of events) {
          if (ev.event !== 'message') continue;
          let payload: any;
          try { payload = JSON.parse(ev.data); } catch { continue; }
          const id = payload?.id;
          const waiter = id !== undefined ? this.pending.get(id) : undefined;
          if (waiter) {
            this.pending.delete(id);
            if (payload.error) waiter.reject(new Error(payload.error.message || 'MCP error'));
            else waiter.resolve(payload.result);
          }
        }
      }
    } catch (err) {
      this.pumpError = err instanceof Error ? err : new Error(String(err));
    } finally {
      for (const [, waiter] of this.pending) {
        waiter.reject(this.pumpError ?? new Error('eCG Agents MCP stream ended'));
      }
      this.pending.clear();
    }
  }

  async call(method: string, rpcParams: Record<string, unknown>, apiKey: string, expectResponse = true): Promise<any> {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params: rpcParams };
    if (expectResponse) body.id = id;

    const resultPromise: Promise<any> | null = expectResponse
      ? new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(new Error(`eCG Agents MCP call "${method}" timed out`));
            }
          }, SESSION_TIMEOUT_MS);
        })
      : null;

    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (resultPromise) this.pending.delete(id);
      throw new Error(`eCG Agents MCP call "${method}" returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    return resultPromise ? resultPromise : undefined;
  }

  close(): void {
    this.reader.cancel().catch(() => {});
  }
}

async function callTool(session: McpSseSession, apiKey: string, toolName: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await session.call('tools/call', { name: toolName, arguments: args }, apiKey);
  const textBlock = result?.content?.find?.((c: any) => c.type === 'text')?.text;
  if (typeof textBlock === 'string') {
    try { return JSON.parse(textBlock); } catch { return textBlock; }
  }
  return result;
}

export interface EcgDiscovery {
  agents: any[];
  connectors: any[];
  platforms: any[];
}

/**
 * One API key -> one MCP SSE session -> discover everything connected to this org.
 * Used both to verify a pasted key is valid and to decide what to seed into a
 * new project (which agent/connector types showed up).
 */
export async function discoverEcgOrg(apiKey: string): Promise<EcgDiscovery> {
  const session = await McpSseSession.open(apiKey);
  try {
    await session.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'EcomGear Dev-Agent', version: '1.0.0' },
    }, apiKey);
    await session.call('notifications/initialized', {}, apiKey, /* expectResponse */ false);

    const [agents, connectors, platforms] = await Promise.all([
      callTool(session, apiKey, 'list_agents').catch((err) => { logger.warn('[ecg-mcp] list_agents failed', err); return []; }),
      callTool(session, apiKey, 'list_connectors').catch((err) => { logger.warn('[ecg-mcp] list_connectors failed', err); return []; }),
      callTool(session, apiKey, 'list_platforms').catch((err) => { logger.warn('[ecg-mcp] list_platforms failed', err); return []; }),
    ]);

    return {
      agents: Array.isArray(agents) ? agents : [],
      connectors: Array.isArray(connectors) ? connectors : [],
      platforms: Array.isArray(platforms) ? platforms : [],
    };
  } finally {
    session.close();
  }
}

/**
 * One-off MCP tool call   opens a session, initializes, calls exactly one
 * tool, closes. Used by ecg-proxy.routes.ts to bridge the generated
 * dashboard's REST-shaped calls to real MCP tools for MCP-key-connected
 * projects (no portal JWT exists for those; see ecg-proxy.routes.ts's
 * MCP_TOOL_MAP for the endpoint -> tool mapping).
 */
export async function callEcgTool(apiKey: string, toolName: string, args: Record<string, unknown> = {}): Promise<any> {
  const session = await McpSseSession.open(apiKey);
  try {
    await session.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'EcomGear Dev-Agent', version: '1.0.0' },
    }, apiKey);
    await session.call('notifications/initialized', {}, apiKey, /* expectResponse */ false);
    return await callTool(session, apiKey, toolName, args);
  } finally {
    session.close();
  }
}
