import vm from 'node:vm';
import { logger } from '../utils/logger.js';

export interface FunctionContext {
  apiUrl: string;
  schema: string;
  anonKey: string;
  serviceKey: string;
}

export interface InvokeResult {
  result: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

const TIMEOUT_MS = 5_000;

// Minimal PostgREST helper exposed to function code as `db`
function buildDbHelper(ctx: FunctionContext) {
  const base = `${ctx.apiUrl}/${ctx.schema}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ctx.serviceKey,
    'Authorization': `Bearer ${ctx.serviceKey}`,
    'Accept-Profile': ctx.schema,
    'Content-Profile': ctx.schema,
  };

  return {
    async select(table: string, query = '') {
      const url = `${base}/${table}${query ? `?${query}` : ''}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async insert(table: string, data: unknown) {
      const res = await fetch(`${base}/${table}`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`db.insert failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async update(table: string, data: unknown, query: string) {
      const res = await fetch(`${base}/${table}?${query}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`db.update failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async delete(table: string, query: string) {
      const res = await fetch(`${base}/${table}?${query}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) throw new Error(`db.delete failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async rpc(fn: string, args: unknown = {}) {
      const res = await fetch(`${ctx.apiUrl}/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`db.rpc failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
  };
}

// Secure fetch wrapper: HTTPS-only, no internal IPs
async function safeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const href = typeof url === 'string' ? url : url.href;
  if (!href.startsWith('https://')) {
    throw new Error('fetch is restricted to HTTPS URLs inside edge functions');
  }
  // Block internal/private IP ranges
  const host = new URL(href).hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new Error(`fetch to internal host "${host}" is not allowed`);
  }
  return fetch(url, init);
}

export async function runEdgeFunction(
  code: string,
  params: unknown,
  dbCtx: FunctionContext,
): Promise<InvokeResult> {
  const logs: string[] = [];
  const start = Date.now();

  const consoleMock = {
    log:   (...a: unknown[]) => { logs.push(a.map(String).join(' ')); },
    warn:  (...a: unknown[]) => { logs.push('[warn] ' + a.map(String).join(' ')); },
    error: (...a: unknown[]) => { logs.push('[error] ' + a.map(String).join(' ')); },
  };

  const context = vm.createContext({
    // user-facing API
    params,
    db: buildDbHelper(dbCtx),
    fetch: safeFetch,
    console: consoleMock,
    // safe globals only
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Map,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    btoa,
    atob,
  });

  // Wrap the user code so they can write top-level await
  const wrapped = `
(async function __fn__(params, db, fetch, console) {
${code}
})(params, db, fetch, console)
`;

  try {
    const script = new vm.Script(wrapped, { filename: 'edge-function.js' });
    const result = await Promise.race([
      script.runInContext(context) as Promise<unknown>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Function timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
      ),
    ]);
    return { result: result ?? null, logs, durationMs: Date.now() - start };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.warn('[EdgeFunction] runtime error', { error: msg });
    return { result: null, logs, durationMs: Date.now() - start, error: msg };
  }
}
