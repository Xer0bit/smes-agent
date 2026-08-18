// Type-only import -- erased at compile time, so it never triggers loading
// the actual native module. isolated-vm is an optionalDependency (see
// package.json): SERVICE_ROLE=gen hosts (VPS3) never mount /api/v1/functions
// at all (see app.ts's servesApi/servesGen split) and may run a Node version
// this native addon doesn't have a build for yet (confirmed live: no
// isolated-vm release currently targets Node 24 -- 6.x tops out around
// Node 22/23's V8, 7.0.0 requires Node >=26). A static top-level `import`
// would crash server startup entirely on such a host the moment the module
// failed to install; runEdgeFunction() below dynamically imports it only
// when a function is actually invoked, which structurally never happens on
// a host that doesn't serve this route.
import type ivm from 'isolated-vm';
import { logger } from '../utils/logger.js';
import { validateEdgeFunctionCode } from './edgeFunctionValidator.js';

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
  // This function's own project id -- needed for ecg.portal()'s internal
  // bridge call below, distinct from portalToken (the Agent Portal's org
  // API key, a different credential for a different host).
  projectId?: string;
}

export interface InvokeResult {
  result: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
  status?: number;
}

const TIMEOUT_MS = 5_000;
// The isolate-level timeout (ISOLATE_TIMEOUT_MS below) only interrupts GUEST
// code running inside the isolate -- it does NOT cancel a host-side fetch()
// call these bridge functions make (db.*/ecg.*/fetch all run as plain Node
// async functions outside the isolate). Without its own timeout, a hung
// downstream call keeps running on the host process after the isolate's
// timeout error has already been returned to the caller. Kept comfortably
// under TIMEOUT_MS so a slow downstream call surfaces as a normal error
// before the outer isolate timeout would otherwise fire.
const DOWNSTREAM_TIMEOUT_MS = 4_000;
// LLM completions routinely take longer than a typical REST call and often
// already exceed the whole function's nominal 5s budget in practice (an
// existing, accepted product constraint, not something to "fix" by cutting
// the timeout tighter). This bound exists only to guarantee the underlying
// host-side fetch eventually terminates instead of hanging indefinitely in
// the background after the outer isolate timeout has already returned an
// error to the caller -- not to make the common "LLM is a bit slow" case
// fail faster than it already effectively does today.
const LLM_TIMEOUT_MS = 30_000;
// isolated-vm enforces this at the V8 level (real interrupt, not a
// non-cancelling Promise.race) -- a synchronous `while(true){}` inside a
// function is actually terminated at this deadline, not just abandoned
// while it keeps burning CPU in the background. Small headroom over
// TIMEOUT_MS so we return "Function timed out" (our message) rather than
// isolated-vm's generic "Script execution timed out." in the common case.
const ISOLATE_TIMEOUT_MS = TIMEOUT_MS + 250;
const MEMORY_LIMIT_MB = 128;

// ── Host-side implementations of everything exposed to guest code ───────────
// These are IDENTICAL in behavior to the pre-migration vm.createContext
// helpers -- only how they're wired into the sandbox changed. All args/
// results here are plain JSON-serializable data (verified: every one of
// these is a thin PostgREST/HTTP JSON wrapper), which is what makes bridging
// them across the isolate boundary via a single JSON-string channel safe and
// simple, instead of needing per-method Reference plumbing.

type FilterArg = string | Record<string, unknown> | undefined;

function normalizeFilterString(str: string): string {
  const trimmed = str.trim();
  const compound = trimmed.match(/^(or|and)\((.*)\)$/s);
  if (compound) return `${compound[1]}=(${compound[2]})`;
  return trimmed.split(/,(?=[A-Za-z_][A-Za-z0-9_.]*=)/).join('&');
}

function buildOrderParam(filters: Record<string, unknown>): string {
  if (typeof filters.orderBy === 'string') return `order=${encodeURIComponent(filters.orderBy)}`;
  if (typeof filters.order === 'string') {
    const [col, dir] = filters.order.split(',');
    return `order=${encodeURIComponent(col)}.${encodeURIComponent(dir || 'asc')}`;
  }
  return '';
}

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

function buildNoDbHelper(): Record<string, (...a: unknown[]) => never> {
  const fail = () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); };
  return { select: fail, insert: fail, update: fail, delete: fail, count: fail, rpc: fail, query: fail };
}

// ── Chainable query builder support ──────────────────────────────────────
// Generated code overwhelmingly reaches for Supabase's real chainable syntax
// (`db.select('t').eq('id', x).order('name').single()`) regardless of what
// the prompt documents as the flat contract -- confirmed live 2026-08-18: 21
// active functions across 3 tenants used this pattern against a runtime that
// only ever exposed flat `select(table, columns?, filter?, extra?)`, so every
// one of them threw `TypeError: ... .eq is not a function` on first call.
// Rather than rewrite 21 functions' worth of call sites (and every future
// one the model writes the same way), the runtime now understands the
// query-descriptor shape the guest-side builder in GUEST_BOOTSTRAP produces.
// The old flat select/insert/update/delete above are UNCHANGED and still the
// only path taken when guest code never chains -- this is purely additive.
export interface QueryFilter {
  col: string;
  op: string;
  val: unknown;
  negate?: boolean;
}

export interface QuerySpec {
  action: 'select' | 'insert' | 'update' | 'delete';
  table: string;
  columns?: string;
  filters?: QueryFilter[];
  order?: { col: string; ascending: boolean }[];
  limit?: number;
  rangeFrom?: number;
  rangeTo?: number;
  single?: boolean;
  maybeSingle?: boolean;
  data?: unknown;
}

function encodeFilterValue(op: string, val: unknown): string {
  if (op === 'is') {
    if (val === null || val === undefined) return 'null';
    return String(val);
  }
  if (op === 'in') {
    const arr = Array.isArray(val) ? val : [val];
    return `(${arr.map((v) => String(v)).join(',')})`;
  }
  if (op === 'contains') {
    const arr = Array.isArray(val) ? val : [val];
    return `{${arr.map((v) => String(v)).join(',')}}`;
  }
  return encodeURIComponent(String(val));
}

const OP_TOKEN: Record<string, string> = { contains: 'cs' };

function buildFilterParam(f: QueryFilter): string {
  const token = OP_TOKEN[f.op] ?? f.op;
  const prefix = f.negate ? 'not.' : '';
  return `${encodeURIComponent(f.col)}=${prefix}${token}.${encodeFilterValue(f.op, f.val)}`;
}

function buildQuerySpecUrl(base: string, spec: QuerySpec): string {
  const parts: string[] = [];
  if (spec.columns) parts.push(`select=${encodeURIComponent(spec.columns)}`);
  for (const f of spec.filters ?? []) parts.push(buildFilterParam(f));
  if (spec.order?.length) {
    parts.push(`order=${spec.order.map((o) => `${o.col}.${o.ascending ? 'asc' : 'desc'}`).join(',')}`);
  }
  if (typeof spec.limit === 'number') parts.push(`limit=${spec.limit}`);
  const qs = parts.join('&');
  return `${base}/${spec.table}${qs ? `?${qs}` : ''}`;
}

// Exported for direct unit testing of the db.* PostgREST bridge -- the actual
// call site (runEdgeFunction, below) drives it from inside an isolated-vm
// sandbox, which isn't worth spinning up just to test a fetch wrapper.
export function buildDbHelper(ctx: FunctionContext) {
  const base = `${ctx.apiUrl}/rest/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ctx.serviceKey,
    'Authorization': `Bearer ${ctx.serviceKey}`,
    'Accept-Profile': ctx.schema,
    'Content-Profile': ctx.schema,
  };

  return {
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
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
      return await res.json();
    },
    async insert(table: string, data: unknown) {
      const res = await fetch(`${base}/${table}`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`db.insert failed: ${res.status} ${await res.text()}`);
      return await res.json();
    },
    async update(table: string, data: unknown, query: FilterArg) {
      const qs = toQueryString(query);
      const res = await fetch(`${base}/${table}?${qs}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`db.update failed: ${res.status} ${await res.text()}`);
      return await res.json();
    },
    async delete(table: string, query: FilterArg) {
      const qs = toQueryString(query);
      // Without return=representation, PostgREST answers a successful DELETE
      // with 204 and an empty body -- res.json() on that throws "Unexpected
      // end of JSON input", masking every successful delete as a generic
      // failure. Confirmed live 2026-08-18. insert/update already set this;
      // delete never did, despite the prompt docs promising it "returns the
      // deleted row(s)" the same way.
      const res = await fetch(`${base}/${table}?${qs}`, {
        method: 'DELETE',
        headers: { ...headers, 'Prefer': 'return=representation' },
        signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`db.delete failed: ${res.status} ${await res.text()}`);
      return await res.json();
    },
    async count(table: string, query: FilterArg) {
      const qs = toQueryString(query);
      const url = `${base}/${table}${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' }, signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`db.count failed: ${res.status} ${await res.text()}`);
      const range = res.headers.get('content-range');
      const count = range ? parseInt(range.split('/')[1] ?? '0', 10) : 0;
      return { count, error: null };
    },
    async rpc(fn: string, args: unknown = {}) {
      const res = await fetch(`${base}/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS) });
      if (!res.ok) {
        // Resolve a PostgREST-shaped { data: null, error } instead of throwing.
        // Real generated code (e.g. pm-auth.js's register/login actions) always
        // destructures `const { data, error } = await db.rpc(...)` and branches
        // on `error.message` for specific cases (duplicate email, bad
        // credentials). Throwing here made that branch unreachable -- the
        // reject skipped straight past it to the function's own outer catch,
        // which only had a generic "unexpected error" message to fall back on.
        // Kept in sync with the identical fix in
        // apps/tenant-functions-runner/runEdgeFunction.js (the file this one
        // is ported to; see that file's own header comment).
        const bodyText = await res.text();
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(bodyText); } catch { parsed = { message: bodyText }; }
        return { data: null, error: { ...parsed, status: res.status } };
      }
      // SUCCESS path must match the SAME { data, error } shape the failure
      // path above deliberately adopted (see that comment) -- returning the
      // raw PostgREST body here instead left every `const { data, error } =
      // await db.rpc(...)` destructure with `data` undefined on a genuine
      // success (PostgREST's success body for a RETURNS TABLE function is a
      // bare JSON array, which has no .data/.error properties). Confirmed
      // live 2026-08-18: pm-auth.js's login always hit its own "!loginData"
      // 401 branch, so login could never succeed for ANY tenant regardless
      // of correct credentials -- the underlying RPC call was succeeding the
      // whole time, only the wrapper's success shape was wrong.
      return { data: await res.json(), error: null };
    },
    // Backing call for the guest-side chainable builder (GUEST_BOOTSTRAP's
    // `db.select(...).eq(...).order(...)` etc.) -- only reached when guest
    // code actually chains; a bare `await db.select(table, ...)` never
    // builds a QuerySpec and keeps using the flat `select` above.
    async query(spec: QuerySpec) {
      if (spec.action === 'select') {
        const url = buildQuerySpecUrl(base, spec);
        const reqHeaders = spec.single ? { ...headers, Accept: 'application/vnd.pgrst.object+json' } : headers;
        const res = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
        const body = await res.json();
        if (spec.maybeSingle) return Array.isArray(body) ? (body[0] ?? null) : body;
        return body;
      }

      const method = spec.action === 'insert' ? 'POST' : spec.action === 'update' ? 'PATCH' : 'DELETE';
      const filterParts = (spec.filters ?? []).map(buildFilterParam);
      const selectPart = spec.columns ? `select=${encodeURIComponent(spec.columns)}` : '';
      const qs = [...filterParts, selectPart].filter(Boolean).join('&');
      const url = `${base}/${spec.table}${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, {
        method,
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: spec.action === 'delete' ? undefined : JSON.stringify(spec.data),
        signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`db.${spec.action} failed: ${res.status} ${await res.text()}`);
      const body = await res.json();
      if (spec.single) {
        if (!Array.isArray(body) || body.length !== 1) throw new Error(`db.${spec.action} failed: expected exactly one row, got ${Array.isArray(body) ? body.length : 'non-array'}`);
        return body[0];
      }
      if (spec.maybeSingle) return Array.isArray(body) ? (body[0] ?? null) : body;
      return body;
    },
  };
}

// Secure fetch wrapper: HTTPS-only, no internal/cloud-metadata IPs. The
// 2026-08 audit found 169.254.169.254 (AWS/GCP/Azure instance metadata) was
// missing from this blocklist -- added the full link-local range, which
// covers it, plus explicit IPv6 loopback/link-local forms.
async function safeFetchCheck(href: string): Promise<void> {
  if (!href.startsWith('https://')) {
    throw new Error('fetch is restricted to HTTPS URLs inside edge functions');
  }
  const host = new URL(href).hostname;
  const blocked =
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) ||
    host === '::1' ||
    host.startsWith('fe80:') ||
    host === '0.0.0.0';
  if (blocked) {
    throw new Error(`fetch to internal/link-local host "${host}" is not allowed`);
  }
}

async function bridgedFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
  await safeFetchCheck(url);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS) });
  const bodyText = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    bodyText,
  };
}

function buildEcgDispatch(ctx: EcgContext) {
  const base = `${ctx.portalApiUrl}/v1/ecg`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.portalToken}` };

  // Previously: `return await res.json()` with no res.ok check -- a non-JSON
  // error page (5xx) threw an opaque JSON-parse error instead of a clean
  // message, and a JSON error BODY on a 4xx status was returned to guest
  // code as if it were a successful payload (nothing in the shape says
  // "this was actually an error"). Now mirrors db.*'s error handling.
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ecg.${method.toLowerCase()} failed: ${res.status} ${await res.text()}`);
    return await res.json();
  };

  const dispatch: Record<string, (...a: any[]) => Promise<unknown>> = {
    get: (path: string) => call('GET', path),
    post: (path: string, body: unknown) => call('POST', path, body),
    patch: (path: string, body: unknown) => call('PATCH', path, body),
    delete: (path: string) => call('DELETE', path),
  };

  // ecg.portal(): bridges to THIS gateway's own /api/v1/ecg-proxy (this
  // server's REST-to-MCP translation layer), not the Agent Portal directly
  // like get/post/patch/delete above. That layer supports actions the
  // Portal's own /v1/ecg surface deliberately doesn't (creating a Buffer
  // connector, creating a post) -- see ecg-proxy.routes.ts's mapToMcpTool.
  // Authenticated as a trusted internal caller via FUNCTIONS_INTERNAL_SECRET
  // (ecg-proxy.routes.ts's resolveAuth), not a user session -- this function
  // has already verified the real caller itself before reaching here.
  if (ctx.projectId && process.env.FUNCTIONS_INTERNAL_SECRET) {
    const gatewayBase = (process.env.ECOMGEAR_SERVER_URL || `http://localhost:${process.env.PORT || 5001}`).replace(/\/$/, '');
    const projectId = ctx.projectId;
    dispatch.portal = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${gatewayBase}/api/v1/ecg-proxy${path}?projectId=${encodeURIComponent(projectId)}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': process.env.FUNCTIONS_INTERNAL_SECRET!,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(`ecg.portal failed: ${res.status} ${parsed?.error ?? text}`);
      return parsed;
    };
  }

  if (ctx.llmApiKey) {
    dispatch.llm = async (messages: unknown[], systemPrompt?: string) => {
      const provider = ctx.llmProvider || 'openai';
      const model = ctx.llmModel || 'gpt-4o';
      if (provider === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.llmApiKey!, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages }),
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`ecg.llm failed: ${res.status} ${await res.text()}`);
        return await res.json();
      }
      const base2 = provider === 'google'
        ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ctx.llmApiKey}`
        : 'https://api.openai.com/v1/chat/completions';
      const res = await fetch(base2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.llmApiKey}` },
        body: JSON.stringify({ model, messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ecg.llm failed: ${res.status} ${await res.text()}`);
      return await res.json();
    };
  }

  return dispatch;
}

// ── Guest-side bootstrap ─────────────────────────────────────────────────────
// Runs INSIDE the isolate. Reconstructs the db/ecg/fetch/console API surface
// generated functions expect, entirely from calls back through the single
// `_hostCall` bridge -- no host object/function is ever handed directly into
// the isolate's realm (that direct handoff, via vm.createContext, was the
// actual escape vector: Object.constructor.constructor(...) reachable off
// any live host-realm object). Everything crossing the boundary here is a
// JSON string; the guest realm never touches a host-realm Object/Function/
// Promise/etc.
const GUEST_BOOTSTRAP = `
function __withDataError(json) {
  if (json && typeof json === 'object') {
    Object.defineProperty(json, 'data', { value: Array.isArray(json) ? [...json] : { ...json }, enumerable: false, configurable: true });
    Object.defineProperty(json, 'error', { value: null, enumerable: false, configurable: true });
  }
  return json;
}

async function __call(path, args) {
  const resultJson = await _hostCall.apply(undefined, [path, JSON.stringify(args)], { result: { promise: true } });
  const parsed = JSON.parse(resultJson);
  if (parsed && parsed.__error) throw new Error(parsed.__error);
  return parsed.value;
}

class Response {
  constructor(body, init) {
    this.body = body;
    this.status = (init && init.status) || 200;
    this.__isEdgeFunctionResponse = true;
  }
}

// Generated code overwhelmingly reaches for Supabase's real chainable syntax
// (db.select('t').eq('id',x).order('name').single()) regardless of what the
// prompt documents as the flat contract -- confirmed live 2026-08-18: 21
// active functions across 3 tenants used this pattern against a runtime that
// only ever exposed flat select(table, ...), so every one threw TypeError on
// first call. select/insert/update/delete now return a lazy, thenable
// builder: an unchained call still resolves via the exact old flat
// __call('db.select', ...) path (zero behavior change); chaining a
// filter/order/limit/single method defers execution and routes through the
// host's db.query bridge instead.
function __makeQueryBuilder(action, legacyArgs) {
  var spec = {
    action: action,
    table: legacyArgs[0],
    data: (action === 'insert' || action === 'update') ? legacyArgs[1] : undefined,
    filters: [],
    order: [],
  };
  var chained = false;
  var promise = null;

  function legacyRun() {
    return __call('db.' + action, legacyArgs).then(__withDataError);
  }
  function run() {
    if (!promise) promise = chained ? __call('db.query', [spec]).then(__withDataError) : legacyRun();
    return promise;
  }

  function addFilter(op) {
    return function (col, val) { chained = true; spec.filters.push({ col: col, op: op, val: val }); return builder; };
  }
  var builder = {
    eq: addFilter('eq'), neq: addFilter('neq'),
    gt: addFilter('gt'), gte: addFilter('gte'), lt: addFilter('lt'), lte: addFilter('lte'),
    like: addFilter('like'), ilike: addFilter('ilike'), is: addFilter('is'),
    in: addFilter('in'), contains: addFilter('contains'),
    not: function (col, op, val) { chained = true; spec.filters.push({ col: col, op: op, val: val, negate: true }); return builder; },
    match: function (obj) { chained = true; for (var k in obj) spec.filters.push({ col: k, op: 'eq', val: obj[k] }); return builder; },
    order: function (col, opts) { chained = true; spec.order.push({ col: col, ascending: !opts || opts.ascending !== false }); return builder; },
    limit: function (n) { chained = true; spec.limit = n; return builder; },
    range: function (from, to) { chained = true; spec.limit = to - from + 1; return builder; },
    single: function () { chained = true; spec.single = true; return builder; },
    maybeSingle: function () { chained = true; spec.maybeSingle = true; return builder; },
    select: function (cols) {
      chained = true;
      // Two idioms seen in real generated code: db.insert(t,data).select(cols)
      // narrows the returned columns; db.select(cols).from(table) is
      // Supabase's real .from().select() inverted -- select()'s original
      // first arg was columns, not a table (handled in from() below).
      if (typeof cols === 'string') spec.columns = cols;
      return builder;
    },
    from: function (t) {
      chained = true;
      if (action === 'select' && spec.columns === undefined && typeof legacyArgs[0] === 'string') {
        spec.columns = legacyArgs[0];
      }
      spec.table = t;
      return builder;
    },
    then: function (onFulfilled, onRejected) { return run().then(onFulfilled, onRejected); },
    catch: function (onRejected) { return run().catch(onRejected); },
    finally: function (onFinally) { return run().finally(onFinally); },
  };
  return builder;
}

const db = __hasDb ? {
  select: (...a) => __makeQueryBuilder('select', a),
  insert: (...a) => __makeQueryBuilder('insert', a),
  update: (...a) => __makeQueryBuilder('update', a),
  delete: (...a) => __makeQueryBuilder('delete', a),
  count:  (...a) => __call('db.count', a),
  // rpc's host success path already resolves { data, error: null } (matching
  // its failure path) -- __withDataError exists to SYNTHESIZE that shape on
  // a still-raw value, so applying it here would wrap the already-correct
  // { data, error } object a second time, leaving .data pointing at the
  // whole wrapper instead of the real payload. Pass through untouched.
  rpc:    (...a) => __call('db.rpc', a),
} : {
  select: () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); },
  insert: () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); },
  update: () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); },
  delete: () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); },
  count:  () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); },
  rpc:    () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); },
};

const ecg = __hasEcg ? {
  get:    (path) => __call('ecg.get', [path]),
  post:   (path, body) => __call('ecg.post', [path, body]),
  patch:  (path, body) => __call('ecg.patch', [path, body]),
  delete: (path) => __call('ecg.delete', [path]),
  ...(__hasEcgLlm ? { llm: (messages, systemPrompt) => __call('ecg.llm', [messages, systemPrompt]) } : {}),
  ...(__hasEcgPortal ? { portal: (method, path, body) => __call('ecg.portal', [method, path, body]) } : {}),
} : null;

async function fetch(url, init) {
  const res = await __call('fetch', [String(url), init ? { method: init.method, headers: init.headers, body: init.body } : undefined]);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
    json: async () => JSON.parse(res.bodyText),
    text: async () => res.bodyText,
  };
}

const console = {
  log:   (...a) => _consoleLog.applySync(undefined, ['log', a.map(String).join(' ')]),
  warn:  (...a) => _consoleLog.applySync(undefined, ['warn', a.map(String).join(' ')]),
  error: (...a) => _consoleLog.applySync(undefined, ['error', a.map(String).join(' ')]),
};

async function __run() {
  const __fn__ = async function(params, db, ecg, fetch, console, secrets) {
${'{{USER_CODE}}'}
  };
  const result = await __fn__(__params, db, ecg, fetch, console, __secrets);
  if (result && typeof result === 'object' && result.__isEdgeFunctionResponse) {
    return JSON.stringify({ __response: true, body: result.body, status: result.status });
  }
  return JSON.stringify({ __response: false, value: result === undefined ? null : result });
}
__run()
`;

export async function runEdgeFunction(
  code: string,
  params: unknown,
  dbCtx?: FunctionContext,
  ecgCtx?: EcgContext,
  secrets?: Record<string, string>,
): Promise<InvokeResult> {
  const logs: string[] = [];
  const start = Date.now();

  // Defense-in-depth: re-validate at run time too, not just at write_edge_function
  // save time -- catches a DB row tampered with directly, bypassing the tool.
  const issues = validateEdgeFunctionCode(code);
  if (issues.length > 0) {
    return {
      result: null,
      logs,
      durationMs: Date.now() - start,
      error: `Blocked by sandbox validation: ${issues.map(i => i.message).join('; ')}`,
    };
  }

  let isolate: ivm.Isolate | undefined;
  try {
    let ivmRuntime: typeof ivm;
    try {
      ivmRuntime = (await import('isolated-vm')).default;
    } catch (loadErr) {
      logger.error('[EdgeFunction] isolated-vm unavailable on this host', loadErr);
      return {
        result: null,
        logs,
        durationMs: Date.now() - start,
        error: 'Function execution is unavailable on this server instance.',
      };
    }

    isolate = new ivmRuntime.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());

    const dbDispatch = dbCtx ? buildDbHelper(dbCtx) : buildNoDbHelper();
    const ecgDispatch = ecgCtx ? buildEcgDispatch(ecgCtx) : null;

    // Single bridge: every db.*/ecg.*/fetch call from the guest funnels
    // through here as (path, jsonArgs) -> jsonResult. No host function or
    // object is ever exposed to the guest realm directly.
    const hostCallRef = new ivmRuntime.Reference(async (path: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson);
        let value: unknown;
        if (path === 'fetch') {
          value = await bridgedFetch(args[0], args[1]);
        } else if (path.startsWith('db.')) {
          const method = path.slice(3) as keyof typeof dbDispatch;
          value = await (dbDispatch[method] as (...a: unknown[]) => Promise<unknown>)(...args);
        } else if (path.startsWith('ecg.') && ecgDispatch) {
          const method = path.slice(4);
          value = await ecgDispatch[method](...args);
        } else {
          throw new Error(`Unknown bridged call: ${path}`);
        }
        return JSON.stringify({ value });
      } catch (err) {
        return JSON.stringify({ __error: (err as Error).message ?? String(err) });
      }
    });
    await jail.set('_hostCall', hostCallRef);

    const consoleLogRef = new ivmRuntime.Reference((level: string, message: string) => {
      logs.push(level === 'log' ? message : `[${level}] ${message}`);
    });
    await jail.set('_consoleLog', consoleLogRef);

    await jail.set('__hasDb', Boolean(dbCtx));
    await jail.set('__hasEcg', Boolean(ecgCtx));
    await jail.set('__hasEcgLlm', Boolean(ecgCtx?.llmApiKey));
    await jail.set('__hasEcgPortal', Boolean(ecgCtx?.projectId && process.env.FUNCTIONS_INTERNAL_SECRET));
    await jail.set('__params', new ivmRuntime.ExternalCopy(params ?? null).copyInto());
    await jail.set('__secrets', new ivmRuntime.ExternalCopy(Object.freeze({ ...(secrets ?? {}) })).copyInto());

    const script = await isolate.compileScript(
      GUEST_BOOTSTRAP.replace('{{USER_CODE}}', code),
      { filename: 'edge-function.js' }
    );

    const resultJson = await script.run(context, { timeout: ISOLATE_TIMEOUT_MS, promise: true }) as string;
    const parsed = JSON.parse(resultJson) as { __response: boolean; value?: unknown; body?: unknown; status?: number };

    if (parsed.__response) {
      let body: unknown = parsed.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { /* leave as raw string */ }
      }
      const status = parsed.status ?? 200;
      if (status >= 400) {
        const message = (body && typeof body === 'object' && 'error' in body) ? String((body as Record<string, unknown>).error) : 'Request failed';
        return { result: null, logs, durationMs: Date.now() - start, error: message, status };
      }
      return { result: body, logs, durationMs: Date.now() - start, status };
    }

    return { result: parsed.value ?? null, logs, durationMs: Date.now() - start };
  } catch (err) {
    const raw = (err as Error).message ?? String(err);
    // isolated-vm's own timeout error text differs from our documented message;
    // normalize so callers/UI see the same "timed out after Ns" copy as before.
    const msg = /timed out|Script execution timed out/i.test(raw)
      ? `Function timed out after ${TIMEOUT_MS / 1000}s`
      : raw;
    logger.warn('[EdgeFunction] runtime error', { error: msg });
    return { result: null, logs, durationMs: Date.now() - start, error: msg };
  } finally {
    isolate?.dispose();
  }
}
