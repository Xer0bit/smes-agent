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
  return { select: fail, insert: fail, update: fail, delete: fail, count: fail, rpc: fail };
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
      const res = await fetch(`${base}/${table}?${qs}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS) });
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
      return await res.json();
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

const db = __hasDb ? {
  select: (...a) => __call('db.select', a).then(__withDataError),
  insert: (...a) => __call('db.insert', a).then(__withDataError),
  update: (...a) => __call('db.update', a).then(__withDataError),
  delete: (...a) => __call('db.delete', a).then(__withDataError),
  count:  (...a) => __call('db.count', a),
  rpc:    (...a) => __call('db.rpc', a).then(__withDataError),
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
