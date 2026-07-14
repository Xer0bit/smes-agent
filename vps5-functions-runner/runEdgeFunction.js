// Ported verbatim from server/src/services/functionRunner.service.ts — same
// sandbox shape, same helpers, so relocating execution here changes nothing
// about what a function can/can't do. Keep this file in sync with the source
// if that one changes.
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const TIMEOUT_MS = 5_000;

function buildNoDbHelper() {
  const fail = () => { throw new Error('No database provisioned for this project — provision one in Database settings to use db.*'); };
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

function buildDbHelper(ctx) {
  const base = `${ctx.apiUrl}/rest/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ctx.serviceKey,
    'Authorization': `Bearer ${ctx.serviceKey}`,
    'Accept-Profile': ctx.schema,
    'Content-Profile': ctx.schema,
  };

  return {
    async select(table, query = '') {
      const qs = toQueryString(query);
      const url = `${base}/${table}${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`db.select failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async insert(table, data) {
      const res = await fetch(`${base}/${table}`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`db.insert failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async update(table, data, query) {
      const qs = toQueryString(query);
      const res = await fetch(`${base}/${table}?${qs}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`db.update failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async delete(table, query) {
      const qs = toQueryString(query);
      const res = await fetch(`${base}/${table}?${qs}`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error(`db.delete failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async rpc(fn, args = {}) {
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

  const consoleMock = {
    log:   (...a) => { logs.push(a.map(String).join(' ')); },
    warn:  (...a) => { logs.push('[warn] ' + a.map(String).join(' ')); },
    error: (...a) => { logs.push('[error] ' + a.map(String).join(' ')); },
  };

  const context = vm.createContext({
    params,
    db:  dbCtx ? buildDbHelper(dbCtx) : buildNoDbHelper(),
    ecg: ecgCtx ? buildEcgHelper(ecgCtx) : null,
    secrets: Object.freeze({ ...(secrets ?? {}) }),
    fetch: safeFetch,
    console: consoleMock,
    JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, btoa, atob,
    // Hashing (password hashing, UUIDs) is near-universal in generated auth
    // functions — without these, `new TextEncoder()` / `crypto.subtle.digest`
    // crashed with "TextEncoder is not defined" (vm.createContext only
    // includes ECMAScript intrinsics, not Node's WHATWG globals).
    TextEncoder, TextDecoder, crypto: webcrypto,
  });

  const wrapped = `
(async function __fn__(params, db, ecg, fetch, console) {
${code}
})(params, db, ecg, fetch, console)
`;

  try {
    const script = new vm.Script(wrapped, { filename: 'edge-function.js' });
    const result = await Promise.race([
      script.runInContext(context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Function timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
      ),
    ]);
    return { result: result ?? null, logs, durationMs: Date.now() - start };
  } catch (err) {
    const msg = err?.message ?? String(err);
    return { result: null, logs, durationMs: Date.now() - start, error: msg };
  }
}
