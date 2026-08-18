// Ported verbatim from server/src/services/functionRunner.service.ts   same
// sandbox shape, same helpers, so relocating execution here changes nothing
// about what a function can/can't do. Keep this file in sync with the source
// if that one changes.
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { validateEdgeFunction } from './validateEdgeFunction.js';

const TIMEOUT_MS = 5_000;

function buildNoDbHelper() {
  const fail = () => { throw new Error('No database provisioned for this project   provision one in Database settings to use db.*'); };
  return { select: fail, insert: fail, update: fail, delete: fail, rpc: fail };
}

// Accepts either a raw PostgREST query string or a plain filter object
// ({ email: 'x' } -> "email=eq.x"). Generated functions consistently call
// db.select('table', { email }) expecting simple equality filtering; without
// this, an object silently coerced to "[object Object]" in the URL, PostgREST
// ignored the garbage filter, and select() returned every row in the table.
function toQueryString(query) {
  if (typeof query === 'string') return query;
  if (!query || typeof query !== 'object') return '';
  return Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=eq.${encodeURIComponent(String(value))}`)
    .join('&');
}

// ── Chainable query builder support ──────────────────────────────────────
// Generated code overwhelmingly reaches for Supabase's real chainable syntax
// (`db.select('t').eq('id', x).order('name').single()`) regardless of what
// the prompt documents as the flat contract -- confirmed live 2026-08-18: 21
// active functions across 3 tenants used this pattern against a runtime that
// only ever exposed flat `select(table, query?)`, so every one of them threw
// `TypeError: ... .eq is not a function` on first call, on THIS file (the
// one actually deployed to VPS5 and serving real tenant invoke traffic --
// functionRunner.service.ts's isolated-vm path is kill-switched off by
// default, see functions.routes.ts's invokeKillSwitch). select/insert/
// update/delete below now return a lazy, thenable builder: `await
// db.select(table)` alone still resolves immediately via the exact old flat
// path (zero behavior change for every function that never chains);
// chaining a filter/order/limit/single method defers execution and routes
// through runQuery() instead. Since this file runs guest code in the SAME
// realm (vm.createContext, not a separate isolate), the builder is a real JS
// object -- no JSON-bridge serialization needed, unlike functionRunner.
// service.ts's isolated-vm equivalent.
function encodeFilterValue(op, val) {
  if (op === 'is') return val === null || val === undefined ? 'null' : String(val);
  if (op === 'in') { const arr = Array.isArray(val) ? val : [val]; return `(${arr.map((v) => encodeURIComponent(String(v))).join(',')})`; }
  if (op === 'contains') { const arr = Array.isArray(val) ? val : [val]; return `{${arr.map((v) => encodeURIComponent(String(v))).join(',')}}`; }
  return encodeURIComponent(String(val));
}
const OP_TOKEN = { contains: 'cs' };
function buildFilterParam(f) {
  const token = OP_TOKEN[f.op] || f.op;
  const prefix = f.negate ? 'not.' : '';
  return `${encodeURIComponent(f.col)}=${prefix}${token}.${encodeFilterValue(f.op, f.val)}`;
}

// Exported for direct unit testing of the db.* PostgREST bridge (see
// query-builder.selfcheck.mjs) -- mirrors functionRunner.service.ts's same
// export for the same reason.
export function buildDbHelper(ctx) {
  const base = `${ctx.apiUrl}/rest/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ctx.serviceKey,
    'Authorization': `Bearer ${ctx.serviceKey}`,
    'Accept-Profile': ctx.schema,
    'Content-Profile': ctx.schema,
  };

  async function selectFlat(table, query = '') {
    const qs = toQueryString(query);
    const url = `${base}/${table}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function insertFlat(table, data) {
    const res = await fetch(`${base}/${table}`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`db.insert failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function updateFlat(table, data, query) {
    const qs = toQueryString(query);
    const res = await fetch(`${base}/${table}?${qs}`, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`db.update failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function deleteFlat(table, query) {
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
    });
    if (!res.ok) throw new Error(`db.delete failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function runQuery(spec) {
    if (spec.action === 'select') {
      const parts = [];
      if (spec.columns) parts.push(`select=${encodeURIComponent(spec.columns)}`);
      if (spec.legacyQs) parts.push(spec.legacyQs);
      for (const f of spec.filters) parts.push(buildFilterParam(f));
      if (spec.order.length) parts.push(`order=${spec.order.map(o => `${o.col}.${o.ascending ? 'asc' : 'desc'}`).join(',')}`);
      if (typeof spec.limit === 'number') parts.push(`limit=${spec.limit}`);
      if (typeof spec.offset === 'number') parts.push(`offset=${spec.offset}`);
      const qs = parts.join('&');
      const url = `${base}/${spec.table}${qs ? `?${qs}` : ''}`;
      const reqHeaders = spec.single ? { ...headers, Accept: 'application/vnd.pgrst.object+json' } : headers;
      const res = await fetch(url, { headers: reqHeaders });
      if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
      const body = await res.json();
      return spec.maybeSingle ? (Array.isArray(body) ? (body[0] ?? null) : body) : body;
    }

    const method = spec.action === 'insert' ? 'POST' : spec.action === 'update' ? 'PATCH' : 'DELETE';
    const filterParts = spec.legacyQs ? [spec.legacyQs, ...spec.filters.map(buildFilterParam)] : spec.filters.map(buildFilterParam);
    const selectPart = spec.columns ? `select=${encodeURIComponent(spec.columns)}` : '';
    const qs = [...filterParts, selectPart].filter(Boolean).join('&');
    const url = `${base}/${spec.table}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: spec.action === 'delete' ? undefined : JSON.stringify(spec.data),
    });
    if (!res.ok) throw new Error(`db.${spec.action} failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (spec.single) {
      if (!Array.isArray(body) || body.length !== 1) throw new Error(`db.${spec.action} failed: expected exactly one row, got ${Array.isArray(body) ? body.length : 'non-array'}`);
      return body[0];
    }
    return spec.maybeSingle ? (Array.isArray(body) ? (body[0] ?? null) : body) : body;
  }

  function makeQueryBuilder(action, legacyArgs) {
    const spec = {
      action,
      table: legacyArgs[0],
      data: (action === 'insert' || action === 'update') ? legacyArgs[1] : undefined,
      filters: [],
      order: [],
    };
    // Preserve whatever the legacy flat call (table, query?) already
    // conveyed: chaining a method that isn't itself a filter (e.g.
    // db.update(t, data, {id}).select('id')) reroutes execution through
    // runQuery(spec) instead of the flat *Flat() functions above, which is
    // the only place this positional filter arg was previously read --
    // without this an update/delete silently loses its WHERE clause.
    const legacyFilterArg = action === 'update' ? legacyArgs[2] : action !== 'insert' ? legacyArgs[1] : undefined;
    spec.legacyQs = toQueryString(legacyFilterArg);
    let chained = false;
    let promise = null;

    function legacyRun() {
      if (action === 'select') return selectFlat(...legacyArgs);
      if (action === 'insert') return insertFlat(...legacyArgs);
      if (action === 'update') return updateFlat(...legacyArgs);
      return deleteFlat(...legacyArgs);
    }
    function run() {
      if (!promise) promise = chained ? runQuery(spec) : legacyRun();
      return promise;
    }

    const addFilter = (op) => (col, val) => { chained = true; spec.filters.push({ col, op, val }); return builder; };
    const builder = {
      eq: addFilter('eq'), neq: addFilter('neq'),
      gt: addFilter('gt'), gte: addFilter('gte'), lt: addFilter('lt'), lte: addFilter('lte'),
      like: addFilter('like'), ilike: addFilter('ilike'), is: addFilter('is'),
      in: addFilter('in'), contains: addFilter('contains'),
      not(col, op, val) { chained = true; spec.filters.push({ col, op, val, negate: true }); return builder; },
      match(obj) { chained = true; for (const k in obj) spec.filters.push({ col: k, op: 'eq', val: obj[k] }); return builder; },
      order(col, opts) { chained = true; spec.order.push({ col, ascending: !opts || opts.ascending !== false }); return builder; },
      limit(n) { chained = true; spec.limit = n; return builder; },
      range(from, to) { chained = true; spec.limit = to - from + 1; spec.offset = from; return builder; },
      single() { chained = true; spec.single = true; return builder; },
      maybeSingle() { chained = true; spec.maybeSingle = true; return builder; },
      select(cols) {
        chained = true;
        // Two idioms seen in real generated code: `db.insert(t,data).select(cols)`
        // narrows the returned columns; `db.select(cols).from(table)` is
        // Supabase's real .from().select() inverted -- this runtime's
        // db.select(table, ...) takes table first, so when .from() shows up
        // later it means select()'s original first arg was columns, not a
        // table (handled in from() below).
        if (typeof cols === 'string') spec.columns = cols;
        return builder;
      },
      from(t) {
        chained = true;
        if (action === 'select' && spec.columns === undefined && typeof legacyArgs[0] === 'string') {
          spec.columns = legacyArgs[0];
        }
        spec.table = t;
        return builder;
      },
      then(onFulfilled, onRejected) { return run().then(onFulfilled, onRejected); },
      catch(onRejected) { return run().catch(onRejected); },
      finally(onFinally) { return run().finally(onFinally); },
    };
    return builder;
  }

  return {
    select: (...a) => makeQueryBuilder('select', a),
    insert: (...a) => makeQueryBuilder('insert', a),
    update: (...a) => makeQueryBuilder('update', a),
    delete: (...a) => makeQueryBuilder('delete', a),
    async rpc(fn, args = {}) {
      const res = await fetch(`${base}/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        // Resolve a PostgREST-shaped { data: null, error } instead of throwing.
        // Real generated code (e.g. pm-auth.js's register/login actions) always
        // destructures `const { data, error } = await db.rpc(...)` and branches
        // on `error.message` for specific cases (duplicate email, bad
        // credentials). Throwing here made that branch unreachable -- the
        // reject skipped straight past it to the function's own outer catch,
        // which only had a generic "unexpected error" message to fall back on.
        // Live incident: a 23505 duplicate-email conflict on register_and_login
        // surfaced as "An unexpected server error occurred" instead of the
        // function's own "An account with this email already exists." branch.
        const bodyText = await res.text();
        let parsed;
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
  };
}

async function safeFetch(url, init) {
  const href = typeof url === 'string' ? url : url.href;
  if (!href.startsWith('https://')) {
    throw new Error('fetch is restricted to HTTPS URLs inside edge functions');
  }
  const host = new URL(href).hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new Error(`fetch to internal host "${host}" is not allowed`);
  }
  return fetch(url, init);
}

function buildEcgHelper(ctx) {
  const base = `${ctx.portalApiUrl}/v1/ecg`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.portalToken}` };

  const call = (method, path, body) =>
    fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(r => r.json());

  const ecg = {
    get:    (path) => call('GET', path),
    post:   (path, body) => call('POST', path, body),
    patch:  (path, body) => call('PATCH', path, body),
    delete: (path) => call('DELETE', path),
  };

  if (ctx.llmApiKey) {
    ecg.llm = async (messages, systemPrompt) => {
      const provider = ctx.llmProvider || 'openai';
      const model = ctx.llmModel || 'gpt-4o';
      if (provider === 'anthropic') {
        return fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.llmApiKey, 'anthropic-version': '2023-06-01' },
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

export async function runEdgeFunction(code, params, dbCtx, ecgCtx, secrets) {
  const logs = [];
  const start = Date.now();

  // SANDBOX ESCAPE GUARD (defense-in-depth). vm.createContext is NOT a real
  // security boundary; the complete fix is isolated-vm (a separate V8 heap,
  // as functionRunner.service.ts uses), not installed on VPS5. Reject the
  // known escape primitives before execution so a tampered/malicious function
  // body -- e.g. `Object.constructor.constructor('return process')()` -- gets
  // a clear error instead of host-process RCE. Runs even though
  // write_edge_function validates upstream: this path is also reachable via a
  // direct _sync POST (server.js) and a tampered tenant_functions row.
  const escapeIssues = validateEdgeFunction(code);
  if (escapeIssues.length > 0) {
    return {
      result: null,
      logs,
      durationMs: Date.now() - start,
      error: `Rejected before execution (sandbox violation): ${escapeIssues.map((i) => i.message).join(' | ')}`,
    };
  }

  const consoleMock = {
    log:   (...a) => { logs.push(a.map(String).join(' ')); },
    warn:  (...a) => { logs.push('[warn] ' + a.map(String).join(' ')); },
    error: (...a) => { logs.push('[error] ' + a.map(String).join(' ')); },
  };

  // Minimal Response polyfill -- the documented write_edge_function contract
  // (app-builder.prompt.ts's "sandbox contract" section) explicitly promises
  // `Response` is in scope alongside params/db/secrets/fetch/console/ecg, and
  // its worked example uses `new Response(JSON.stringify(...), {status})` for
  // custom HTTP status codes. This sandbox never actually provided it --
  // confirmed live 2026-08-13, project dfe41091's pm-auth function (every
  // path returns via `new Response(...)`) threw ReferenceError on every
  // invocation. functionRunner.service.ts (the isolated-vm implementation
  // this file was ported from) defines the identical minimal polyfill; kept
  // in sync here rather than trying to construct a real WHATWG Response.
  class EdgeFunctionResponse {
    constructor(body, init) {
      this.body = body;
      this.status = (init && init.status) || 200;
      this.__isEdgeFunctionResponse = true;
    }
  }

  // Do NOT inject host ECMAScript intrinsics (Object, Array, Error, Promise,
  // Map, Set, Date, String, Number, Boolean, JSON, Math, parseInt, ...). A new
  // vm context already has its OWN copies of every ECMAScript global, so the
  // code still works -- but if we pass the HOST's Object here, then inside the
  // sandbox `Object.constructor` is the host Function constructor, and
  // `Object.constructor('return process')()` reaches the host process. Passing
  // the host intrinsics was the escape. Only genuinely non-ECMAScript host
  // capabilities are injected below (params/db/ecg/fetch/console/secrets plus
  // the WHATWG globals a vm context lacks), and the AST guard above rejects
  // `.constructor` access on those, closing the equivalent route through
  // fetch/crypto/console.
  const context = vm.createContext({
    params,
    db:  dbCtx ? buildDbHelper(dbCtx) : buildNoDbHelper(),
    ecg: ecgCtx ? buildEcgHelper(ecgCtx) : null,
    secrets: Object.freeze({ ...(secrets ?? {}) }),
    fetch: safeFetch,
    console: consoleMock,
    // WHATWG/Node globals a bare vm context does NOT provide (unlike the
    // ECMAScript intrinsics above, which it does). Hashing (password hashing,
    // UUIDs) is near-universal in generated auth functions -- without these,
    // `new TextEncoder()` / `crypto.subtle.digest` throw "not defined".
    TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    Response: EdgeFunctionResponse,
  });

  const wrapped = `
(async function __fn__(params, db, ecg, fetch, console) {
${code}
})(params, db, ecg, fetch, console)
`;

  try {
    const script = new vm.Script(wrapped, { filename: 'edge-function.js' });
    let result = await Promise.race([
      script.runInContext(context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Function timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
      ),
    ]);
    // Unwrap a `new Response(...)` return into the plain JSON value the
    // caller (server.js) and the generated frontend's `const { result, error
    // } = await res.json()` both expect -- without this, the client received
    // the polyfill's raw { body, status, __isEdgeFunctionResponse } shape
    // instead of the actual payload the function author wrote.
    if (result && typeof result === 'object' && result.__isEdgeFunctionResponse) {
      try { result = JSON.parse(result.body); } catch { result = result.body; }
    }
    return { result: result ?? null, logs, durationMs: Date.now() - start };
  } catch (err) {
    const msg = err?.message ?? String(err);
    return { result: null, logs, durationMs: Date.now() - start, error: msg };
  }
}
