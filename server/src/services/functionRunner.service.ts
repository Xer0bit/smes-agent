import vm from 'node:vm';
import { logger } from '../utils/logger.js';

export interface FunctionContext {
  apiUrl: string;
  schema: string;
  anonKey: string;
  serviceKey: string;
}

export interface EcgContext {
  portalToken: string;
  portalApiUrl: string;
  llmApiKey?: string;
  llmModel?: string;
  llmProvider?: string;
}

export interface InvokeResult {
  result: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

const TIMEOUT_MS = 5_000;

// No database provisioned for this project — db.* stays callable but errors
// only if the function code actually tries to use it, so functions that
// don't touch a database work fine without one.
function buildNoDbHelper() {
  const fail = () => { throw new Error('No database provisioned for this project — provision one in Database settings to use db.*'); };
  return { select: fail, insert: fail, update: fail, delete: fail, rpc: fail };
}

// Minimal PostgREST helper exposed to function code as `db`
// ctx.apiUrl already carries the tenant schema as a URL path segment
// (https://cloud.ecomgear.app/tenant_xxxx — see database.service.ts), so this
// just adds the standard /rest/v1 suffix. Accept-Profile/Content-Profile are
// still sent for defense in depth, but VPS5's nginx derives the real schema
// from the URL path itself and overrides these headers regardless — the path
// is the source of truth, not the header.
function buildDbHelper(ctx: FunctionContext) {
  const base = `${ctx.apiUrl}/rest/v1`;
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
      const res = await fetch(`${base}/rpc/${fn}`, {
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

// ECG portal helper injected as `ecg` in edge functions.
// Uses real fetch (server-side) with the stored portal token — user code never sees the token.
function buildEcgHelper(ctx: EcgContext) {
  const base = `${ctx.portalApiUrl}/v1/ecg`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.portalToken}` };

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(r => r.json());

  const ecg: Record<string, unknown> = {
    get:    (path: string)                  => call('GET',    path),
    post:   (path: string, body: unknown)   => call('POST',   path, body),
    patch:  (path: string, body: unknown)   => call('PATCH',  path, body),
    delete: (path: string)                  => call('DELETE', path),
  };

  // LLM helper — server-side call, API key never exposed to edge function code
  if (ctx.llmApiKey) {
    ecg.llm = async (messages: unknown[], systemPrompt?: string) => {
      const provider = ctx.llmProvider || 'openai';
      const model = ctx.llmModel || 'gpt-4o';
      if (provider === 'anthropic') {
        return fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.llmApiKey!, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages }),
        }).then(r => r.json());
      }
      const base2 = provider === 'google'
        ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ctx.llmApiKey}`
        : 'https://api.openai.com/v1/chat/completions';
      return fetch(base2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.llmApiKey}` },
        body: JSON.stringify({ model, messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages }),
      }).then(r => r.json());
    };
  }

  return ecg;
}

export async function runEdgeFunction(
  code: string,
  params: unknown,
  dbCtx?: FunctionContext,
  ecgCtx?: EcgContext,
  secrets?: Record<string, string>,
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
    db:  dbCtx ? buildDbHelper(dbCtx) : buildNoDbHelper(),
    ecg: ecgCtx ? buildEcgHelper(ecgCtx) : null,
    secrets: Object.freeze({ ...(secrets ?? {}) }),
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
(async function __fn__(params, db, ecg, fetch, console) {
${code}
})(params, db, ecg, fetch, console)
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
