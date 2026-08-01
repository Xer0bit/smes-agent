import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
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
  status?: number;
}

const TIMEOUT_MS = 5_000;

// The documented sandbox contract says "return a JSON-serializable result" —
// no `Response` global was ever part of it. In practice, generated functions
// consistently return `new Response(JSON.stringify({error}), {status: 4xx})`
// for their error paths anyway (a natural pattern to reach for), which threw
// "Response is not defined" and made every non-200 branch in every generated
// function crash instead of returning the intended error. Providing a minimal
// Response and unwrapping it below (instead of rejecting the pattern) fixes
// every function that already uses it without requiring it to be rewritten.
class EdgeFunctionResponse {
  body: unknown;
  status: number;
  constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
    this.body = body;
    this.status = init?.status ?? 200;
  }
}

function unwrapResponse(value: unknown): { result: unknown; error?: string; status?: number } {
  if (!(value instanceof EdgeFunctionResponse)) return { result: value ?? null };
  let body: unknown = value.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* leave as raw string */ }
  }
  if (value.status >= 400) {
    const message = (body && typeof body === 'object' && 'error' in body) ? String((body as Record<string, unknown>).error) : 'Request failed';
    return { result: null, error: message, status: value.status };
  }
  return { result: body, status: value.status };
}

// No database provisioned for this project   db.* stays callable but errors
// only if the function code actually tries to use it, so functions that
// don't touch a database work fine without one.
function buildNoDbHelper() {
  const fail = () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); };
  return { select: fail, insert: fail, update: fail, delete: fail, rpc: fail };
}

// Minimal PostgREST helper exposed to function code as `db`
// ctx.apiUrl already carries the tenant schema as a URL path segment
// (https://cloud.ecomgear.app/tenant_xxxx   see database.service.ts), so this
// just adds the standard /rest/v1 suffix. Accept-Profile/Content-Profile are
// still sent for defense in depth, but VPS5's nginx derives the real schema
// from the URL path itself and overrides these headers regardless   the path
// is the source of truth, not the header.
// Accepts either a raw PostgREST query string ("email=eq.x&role=eq.buyer",
// passed through unchanged) or a plain filter object ({ email: 'x' }),
// converted to the equivalent eq-filter query string. Every generated
// function this session used the object form   db.select('table', { email })
//   expecting simple equality filtering, but the helper only ever accepted a
// raw string, so `${query}` on an object silently coerced to "[object Object]",
// PostgREST ignored the garbage filter, and select() returned EVERY row in
// the table. That produced two real bugs at once: signup always claimed
// "email already exists" (since existing.length was really "row count > 0"),
// and login compared against an arbitrary row instead of the actual user.
type FilterArg = string | Record<string, unknown> | undefined;

// A filter as generated functions actually call it: a raw PostgREST condition
// string ("id=eq.X"), a comma-joined multi-condition string ("id=eq.X,role=eq.Y"
// PostgREST wants those "&"-joined, not comma-joined), an "or(...)"/"and(...)"
// compound expression (PostgREST wants "or=(...)"), or a { filter, order/orderBy }
// wrapper mixing a raw filter with a sort. A comma inside a value (e.g.
// "id=in.(a,b,c)") isn't followed by "key=" so the split leaves it alone.
function normalizeFilterString(str: string): string {
  const trimmed = str.trim();
  const compound = trimmed.match(/^(or|and)\((.*)\)$/s);
  if (compound) return `${compound[1]}=(${compound[2]})`;
  return trimmed.split(/,(?=[A-Za-z_][A-Za-z0-9_.]*=)/).join('&');
}

function buildOrderParam(filters: Record<string, unknown>): string {
  if (typeof filters.orderBy === 'string') return `order=${encodeURIComponent(filters.orderBy)}`;
  if (typeof filters.order === 'string') {
    // "col,dir" (comma) -> PostgREST's "col.dir" (dot)
    const [col, dir] = filters.order.split(',');
    return `order=${encodeURIComponent(col)}.${encodeURIComponent(dir || 'asc')}`;
  }
  return '';
}

// Accepts a raw string, a { filter, order|orderBy } wrapper, or a plain
// equality-filter object ({ id: 'x' } -> "id=eq.x"). Every generated function
// this session used one of these three shapes interchangeably   the object
// form expecting simple equality filtering, but the helper only ever accepted
// a raw string, so `${query}` on an object silently coerced to "[object Object]",
// PostgREST ignored the garbage filter, and select() returned EVERY row in
// the table. That produced two real bugs at once: signup always claimed
// "email already exists" (since existing.length was really "row count > 0"),
// and login compared against an arbitrary row instead of the actual user.
function toQueryString(query: FilterArg): string {
  if (!query) return '';
  if (typeof query === 'string') return normalizeFilterString(query);
  if (typeof query !== 'object') return '';
  if ('filter' in query || 'order' in query || 'orderBy' in query) {
    const parts: string[] = [];
    if (typeof query.filter === 'string' && query.filter) parts.push(normalizeFilterString(query.filter));
    const orderParam = buildOrderParam(query);
    if (orderParam) parts.push(orderParam);
    return parts.join('&');
  }
  return Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=eq.${encodeURIComponent(String(value))}`)
    .join('&');
}

// The optional 3rd/4th select() arg: per-column range/inequality filters
// ({ expires_at: { operator: 'gte', value } }) or a sort ({ created_at: { ascending: false } }).
function buildExtraOpsQuery(extra: Record<string, unknown> | undefined): string {
  if (!extra || typeof extra !== 'object') return '';
  return Object.entries(extra)
    .map(([key, v]) => {
      if (!v || typeof v !== 'object') return '';
      const ops = v as Record<string, unknown>;
      if ('ascending' in ops) return `order=${encodeURIComponent(key)}.${ops.ascending ? 'asc' : 'desc'}`;
      if ('operator' in ops) return `${encodeURIComponent(key)}=${encodeURIComponent(String(ops.operator))}.${encodeURIComponent(String(ops.value))}`;
      return '';
    })
    .filter(Boolean)
    .join('&');
}

// Generated functions call db.* two ways: `const rows = await db.select(...)`
// (checking `rows`/`rows.length` directly) or Supabase-client style
// `const { data, error } = await db.select(...)`. The helper only ever
// returned the raw PostgREST JSON, so every destructuring call-site's `data`
// was silently `undefined`. Non-enumerable so it doesn't leak into
// `Object.keys`/spread/JSON.stringify of the returned value.
function withDataError<T>(json: T): T {
  if (json && typeof json === 'object') {
    Object.defineProperty(json, 'data', { value: Array.isArray(json) ? [...json] : { ...json }, enumerable: false, configurable: true });
    Object.defineProperty(json, 'error', { value: null, enumerable: false, configurable: true });
  }
  return json;
}

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
    // Generated functions call this three ways: select(table, filter), or
    // select(table, columns[], filter, extraOps) to also pick specific
    // columns and/or add a range filter or sort alongside the equality filter.
    async select(table: string, columnsOrFilter?: string[] | FilterArg, maybeFilter?: FilterArg, maybeExtra?: Record<string, unknown>) {
      const columns = Array.isArray(columnsOrFilter) ? columnsOrFilter : undefined;
      const filters = columns ? maybeFilter : (columnsOrFilter as FilterArg);
      const extra = columns ? maybeExtra : (maybeFilter as Record<string, unknown> | undefined);
      const parts: string[] = [];
      if (columns && columns.length) parts.push(`select=${columns.map(encodeURIComponent).join(',')}`);
      const filterQs = toQueryString(filters);
      if (filterQs) parts.push(filterQs);
      const extraQs = buildExtraOpsQuery(extra);
      if (extraQs) parts.push(extraQs);
      const qs = parts.join('&');
      const url = `${base}/${table}${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
      return withDataError(await res.json());
    },
    async insert(table: string, data: unknown) {
      const res = await fetch(`${base}/${table}`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`db.insert failed: ${res.status} ${await res.text()}`);
      return withDataError(await res.json());
    },
    async update(table: string, data: unknown, query: FilterArg) {
      const qs = toQueryString(query);
      const res = await fetch(`${base}/${table}?${qs}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`db.update failed: ${res.status} ${await res.text()}`);
      return withDataError(await res.json());
    },
    async delete(table: string, query: FilterArg) {
      const qs = toQueryString(query);
      const res = await fetch(`${base}/${table}?${qs}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) throw new Error(`db.delete failed: ${res.status} ${await res.text()}`);
      return withDataError(await res.json());
    },
    // pm-manage-users' UPDATE_STATUS action calls this (`db.count('users', {...})`)
    // to block deactivating the last active Super Admin — there was no such
    // method at all, so that call threw "db.count is not a function".
    async count(table: string, query: FilterArg) {
      const qs = toQueryString(query);
      const url = `${base}/${table}${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } });
      if (!res.ok) throw new Error(`db.count failed: ${res.status} ${await res.text()}`);
      const range = res.headers.get('content-range');
      const count = range ? parseInt(range.split('/')[1] ?? '0', 10) : 0;
      return { count, error: null };
    },
    async rpc(fn: string, args: unknown = {}) {
      const res = await fetch(`${base}/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`db.rpc failed: ${res.status} ${await res.text()}`);
      return withDataError(await res.json());
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
// Uses real fetch (server-side) with the stored portal token   user code never sees the token.
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

  // LLM helper   server-side call, API key never exposed to edge function code
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
    // Hashing (password hashing, UUIDs) is a near-universal need in generated
    // auth functions   without these, any function calling `new TextEncoder()`
    // or `crypto.subtle.digest(...)`/`crypto.randomUUID()` crashed with
    // "TextEncoder is not defined", since vm.createContext() only includes
    // ECMAScript intrinsics, not Node's WHATWG globals, unless explicitly injected.
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    Response: EdgeFunctionResponse,
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
    const unwrapped = unwrapResponse(result);
    return { ...unwrapped, logs, durationMs: Date.now() - start };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.warn('[EdgeFunction] runtime error', { error: msg });
    return { result: null, logs, durationMs: Date.now() - start, error: msg };
  }
}
