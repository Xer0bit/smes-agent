#!/usr/bin/env node
/**
 * ecg-cloud-check: exercise the eCG Cloud features against a LOCAL dev stack.
 *
 *   node scripts/ecg-cloud-check.mjs                 # everything read-only
 *   node scripts/ecg-cloud-check.mjs --with-function # also create/invoke/delete a test edge function
 *   node scripts/ecg-cloud-check.mjs --with-preview  # also push a two-file app to the preview and check it
 *   node scripts/ecg-cloud-check.mjs --provision     # provision a hosted DB for the project (hits TENANT_DB_HOST!)
 *   node scripts/ecg-cloud-check.mjs --project <id>  # use an existing project instead of creating one
 *   node scripts/ecg-cloud-check.mjs --keep          # keep the project it created
 *
 * Reads, in order: flags, environment, then apps/api-gateway/.env and .env.local
 * for the pieces it needs (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * PREVIEW_SERVICE_URL, PREVIEW_UPDATE_SECRET, TENANT_DB_HOST). Sign-in needs
 * ECG_EMAIL and ECG_PASSWORD for a user that exists on the LOCAL Supabase.
 *
 * Every step prints PASS / FAIL / SKIP with the reason and the time it took,
 * and the exit code is the number of failures. Nothing here reads tenant data
 * rows: the database steps are schema-shape and `select 1` only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

function loadEnvFile(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch { return {}; }
}
const root = resolve(new URL('..', import.meta.url).pathname);
const fileEnv = { ...loadEnvFile(resolve(root, '.env.local')), ...loadEnvFile(resolve(root, 'apps/api-gateway/.env')) };
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const CFG = {
  api: opt('--api') ?? env('ECG_API_URL', 'http://localhost:5001'),
  supabase: opt('--supabase') ?? env('SUPABASE_URL', 'http://127.0.0.1:54321'),
  anonKey: env('VITE_SUPABASE_ANON_KEY') ?? env('SUPABASE_ANON_KEY'),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  preview: opt('--preview') ?? env('PREVIEW_SERVICE_URL', 'http://localhost:3001'),
  previewSecret: env('PREVIEW_UPDATE_SECRET', ''),
  tenantHost: env('TENANT_DB_HOST', ''),
  email: env('ECG_EMAIL'),
  password: env('ECG_PASSWORD'),
  projectId: opt('--project'),
};

// ─── Reporting ────────────────────────────────────────────────────────────────

const results = [];
const colour = { PASS: '\x1b[32m', FAIL: '\x1b[31m', SKIP: '\x1b[33m', reset: '\x1b[0m' };
function report(status, name, detail = '', ms = 0) {
  results.push({ status, name, detail });
  const t = ms ? ` ${String(Math.round(ms)).padStart(5)}ms` : '        ';
  console.log(`${colour[status]}${status.padEnd(4)}${colour.reset} ${name.padEnd(34)}${t}  ${detail}`);
}
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    if (detail === SKIP || (typeof detail === 'object' && detail?.skip)) report('SKIP', name, detail.skip ?? '', performance.now() - t0);
    else report('PASS', name, typeof detail === 'string' ? detail : '', performance.now() - t0);
  } catch (err) {
    report('FAIL', name, err instanceof Error ? err.message : String(err), performance.now() - t0);
  }
}
const SKIP = { skip: '' };
const skip = (why) => ({ skip: why });

// ─── HTTP ─────────────────────────────────────────────────────────────────────

let token = '';
async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${CFG.api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (raw) return { res, json, text };
  if (!res.ok) {
    const e = new Error(`${method} ${path} -> ${res.status} ${json?.error ?? json?.message ?? text.slice(0, 120)}`);
    e.status = res.status; e.json = json; throw e;
  }
  return json;
}
async function admin(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${CFG.supabase}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: CFG.serviceKey, Authorization: `Bearer ${CFG.serviceKey}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} rest/v1/${path} -> ${res.status} ${text.slice(0, 120)}`);
  return text ? JSON.parse(text) : null;
}
const paidGate = (err) => (err.status === 402 || err.status === 403) && /plan|upgrade|paid/i.test(err.message);

// ─── Steps ────────────────────────────────────────────────────────────────────

let projectId = CFG.projectId;
let createdProject = false;
let userId = '';
let orgId;
let createdOrg = false;
let dbProvisioned = false;
let dbSchema = '';

async function main() {
  console.log(`\neCG Cloud check  api=${CFG.api}  supabase=${CFG.supabase}  preview=${CFG.preview}\n`);

  await step('API health', async () => {
    const { res, json } = await api('/health', { raw: true });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return `role=${json?.serviceRole ?? '?'} routes=${json?.mountedRoutes?.length ?? '?'}`;
  });

  await step('Sign in (local Supabase)', async () => {
    if (!CFG.email || !CFG.password) throw new Error('set ECG_EMAIL and ECG_PASSWORD for a user on the local Supabase');
    if (!CFG.anonKey) throw new Error('no VITE_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY found');
    const res = await fetch(`${CFG.supabase}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CFG.email, password: CFG.password }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${json.error_description ?? json.msg ?? json.error}`);
    token = json.access_token; userId = json.user?.id ?? '';
    return `user ${userId.slice(0, 8)}…`;
  });
  if (!token) return finish();

  await step('Project', async () => {
    if (projectId) {
      await api(`/api/v1/projects/${projectId}`);
      return `using ${projectId.slice(0, 8)}…`;
    }
    const json = await api('/api/v1/projects', { method: 'POST', body: { name: `cloud-check-${Date.now().toString(36)}`, description: 'ecg-cloud-check' } });
    projectId = json.project?.id ?? json.id;
    if (!projectId) throw new Error('create returned no id');
    createdProject = true;
    return `created ${projectId.slice(0, 8)}…`;
  });
  if (!projectId) return finish();
  const q = `?project_id=${encodeURIComponent(projectId)}`;

  // ── Hosted database ────────────────────────────────────────────────────────
  let dbActive = false;
  await step('Database status', async () => {
    const json = await api(`/api/v1/database/status${q}`);
    const db = json.database;
    dbActive = Boolean(db && (db.status === 'active' || db.is_active));
    dbSchema = db?.schema_name ?? db?.schema ?? '';
    return db ? `status=${db.status ?? (db.is_active ? 'active' : 'inactive')} schema=${dbSchema || '-'}` : 'no database';
  });

  if (!dbActive && flag('--provision')) {
    // Hosted databases need a paid organization. On a LOCAL Supabase the
    // service key can hand the test user one; production never gets here.
    await step('Paid organization for the test user', async () => {
      if (!CFG.serviceKey) return skip('SUPABASE_SERVICE_ROLE_KEY needed to create a paid org');
      if (!/127\.0\.0\.1|localhost/.test(CFG.supabase)) return skip('only on a local Supabase');
      // Leftovers from an interrupted run, then a fresh paid org. Creating an
      // organization already enrols its creator (a trigger), so the member row
      // is inserted only if it is missing.
      const stale = await admin(`organizations?created_by=eq.${userId}&name=eq.cloud-check&select=id`);
      for (const o of stale) { await admin(`org_members?org_id=eq.${o.id}`, { method: 'DELETE' }); await admin(`organizations?id=eq.${o.id}`, { method: 'DELETE' }); }
      const slug = `cloud-check-${Date.now().toString(36)}`;
      const [org] = await admin('organizations', { method: 'POST', prefer: 'return=representation',
        body: [{ name: 'cloud-check', slug, status: 'active', plan_tier: 'professional', created_by: userId }] });
      orgId = org.id; createdOrg = true;
      const members = await admin(`org_members?org_id=eq.${orgId}&user_id=eq.${userId}&select=id`);
      if (members.length === 0) await admin('org_members', { method: 'POST', body: [{ org_id: orgId, user_id: userId, role: 'admin' }] });
      return `created ${orgId.slice(0, 8)}… (professional)`;
    });
    await step('Database provision', async () => {
      console.log(`      ! provisioning against TENANT_DB_HOST=${CFG.tenantHost || '(unset)'}`);
      try {
        await api(`/api/v1/database/provision${q}`, { method: 'POST', body: { project_id: projectId, organization_id: orgId ?? undefined } });
      } catch (err) {
        if (err.status === 429) return skip('provision rate limit hit (several runs in a row); try again later');
        throw err;
      }
      const json = await api(`/api/v1/database/status${q}`);
      dbActive = Boolean(json.database && (json.database.status === 'active' || json.database.is_active));
      if (!dbActive) throw new Error('provision returned but status is not active');
      dbSchema = json.database.schema_name ?? '';
      dbProvisioned = true;
      return 'active';
    });
  } else if (!dbActive) {
    report('SKIP', 'Database provision', 'no hosted DB; pass --provision to create one (hits TENANT_DB_HOST)');
  }

  // ── Plan (unit pricing) ────────────────────────────────────────────────────
  if (!orgId) {
    const memberships = await admin(`org_members?user_id=eq.${userId}&select=org_id&limit=1`).catch(() => []);
    orgId = memberships?.[0]?.org_id;
  }
  let planBase = 0;
  await step('Plan snapshot (base SINGLE)', async () => {
    if (!orgId) return skip('user belongs to no organization');
    const plan = await api(`/api/v1/plan?org_id=${orgId}`);
    planBase = plan.estimate.total_cents;
    if (!plan.catalog?.base_price_cents || !plan.usage || !plan.entitlements) throw new Error('snapshot missing catalog/usage/entitlements');
    return `${plan.catalog.name} $${plan.estimate.total_cents / 100}/mo, usage apps=${plan.usage.apps} users=${plan.usage.users} agents=${plan.usage.agents} db=${plan.usage.databases}`;
  });
  await step('Plan add one app then remove it', async () => {
    if (!orgId) return skip('no organization');
    const before = await api(`/api/v1/plan?org_id=${orgId}`);
    const up = await api('/api/v1/plan', { method: 'PATCH', body: { org_id: orgId, apps: before.entitlements.apps + 1 } });
    if (up.estimate.total_cents !== planBase + before.catalog.app_price_cents) throw new Error(`expected +$${before.catalog.app_price_cents / 100}, got $${up.estimate.total_cents / 100}`);
    const down = await api('/api/v1/plan', { method: 'PATCH', body: { org_id: orgId, apps: before.entitlements.apps } });
    if (down.estimate.total_cents !== planBase) throw new Error('did not return to the previous total');
    return `+$${before.catalog.app_price_cents / 100} then back to $${planBase / 100}`;
  });
  await step('Plan refuses quantity below use or included', async () => {
    if (!orgId) return skip('no organization');
    const { res } = await api('/api/v1/plan', { method: 'PATCH', body: { org_id: orgId, users: 0 }, raw: true });
    if (res.status !== 422) throw new Error(`expected 422, got ${res.status}`);
    return '422';
  });

  await step('Database ping', async () => {
    if (!dbActive) return skip('no hosted DB');
    const json = await api(`/api/v1/database/ping${q}`);
    return json.ok === false ? Promise.reject(new Error(JSON.stringify(json))) : `ok`;
  });

  await step('Database schema (tables)', async () => {
    if (!dbActive) return skip('no hosted DB');
    try {
      const json = await api(`/api/v1/database/tables${q}`);
      const n = Array.isArray(json.tables) ? json.tables.length : 0;
      return `${n} table${n === 1 ? '' : 's'}`;
    } catch (err) { if (paidGate(err)) return skip('paid plan required'); throw err; }
  });

  await step('Database query (select 1)', async () => {
    if (!dbActive) return skip('no hosted DB');
    try {
      const json = await api(`/api/v1/database/query${q}`, { method: 'POST', body: { sql: 'select 1 as one', role: 'anon' } });
      const rows = json.rows ?? json.data ?? json;
      return `rows=${Array.isArray(rows) ? rows.length : '?'}`;
    } catch (err) { if (paidGate(err)) return skip('paid plan required'); throw err; }
  });

  // ── Staged admin SQL: ordered, atomic, failure pinned to its statement ─────
  await step('Staged SQL batch runs in order', async () => {
    if (!dbActive) return skip('no hosted DB');
    if (!CFG.serviceKey) return skip('SUPABASE_SERVICE_ROLE_KEY needed to stage rows');
    const batch = `cloud-check-${Date.now().toString(36)}`;
    // Staged in dependency order: the table, then the row that needs it.
    await admin('admin_sql_pending_changes', { method: 'POST', body: [
      { project_id: projectId, staged_by_user_id: userId, batch_id: batch, sql_text: 'CREATE TABLE cc_items (id serial primary key, name text not null)' },
    ] });
    await new Promise((r) => setTimeout(r, 20)); // distinct created_at
    await admin('admin_sql_pending_changes', { method: 'POST', body: [
      { project_id: projectId, staged_by_user_id: userId, batch_id: batch, sql_text: "INSERT INTO cc_items (name) VALUES ('first')" },
    ] });
    const res = await api(`/api/v1/database/admin-sql/run-all${q}`, { method: 'POST', body: { project_id: projectId, batch_id: batch } });
    if (!res.success || res.executed.length !== 2) throw new Error(`expected 2 executed, got ${JSON.stringify(res).slice(0, 120)}`);
    // New tables are RLS deny-all, so a row count through the tenant roles is
    // always 0; the table's existence is the observable result of the commit.
    const tables = await api(`/api/v1/database/tables${q}`);
    const names = (tables.tables ?? []).map((t) => (typeof t === 'string' ? t : t.name ?? t.table_name));
    if (!names.includes('cc_items')) throw new Error(`cc_items missing after the batch (tables: ${names.join(', ') || 'none'})`);
    return '2 statements, one transaction, table created';
  });

  await step('Staged SQL batch failure is pinned and nothing runs', async () => {
    if (!dbActive) return skip('no hosted DB');
    if (!CFG.serviceKey) return skip('SUPABASE_SERVICE_ROLE_KEY needed to stage rows');
    const batch = `cloud-check-bad-${Date.now().toString(36)}`;
    await admin('admin_sql_pending_changes', { method: 'POST', body: [
      { project_id: projectId, staged_by_user_id: userId, batch_id: batch, sql_text: 'CREATE TABLE cc_leak (id serial primary key)' },
    ] });
    await new Promise((r) => setTimeout(r, 20));
    const [bad] = await admin('admin_sql_pending_changes', { method: 'POST', prefer: 'return=representation', body: [
      { project_id: projectId, staged_by_user_id: userId, batch_id: batch, sql_text: "INSERT INTO cc_missing (name) VALUES ('x')" },
    ] });
    const { res, json } = await api(`/api/v1/database/admin-sql/run-all${q}`, { method: 'POST', body: { project_id: projectId, batch_id: batch }, raw: true });
    if (res.status !== 422) throw new Error(`expected 422, got ${res.status} ${JSON.stringify(json).slice(0, 100)}`);
    if (json.failedId !== bad.id) throw new Error(`failure pinned to ${json.failedId}, expected the bad row`);
    if (!/cc_missing/.test(json.error ?? '')) throw new Error(`error does not name the table: ${json.error}`);
    const tables = await api(`/api/v1/database/tables${q}`);
    const names = (tables.tables ?? []).map((t) => (typeof t === 'string' ? t : t.name ?? t.table_name));
    if (names.includes('cc_leak')) throw new Error('statement 1 leaked through the failed batch: cc_leak exists');
    const [stored] = await admin(`admin_sql_pending_changes?id=eq.${bad.id}&select=status,error_message`);
    if (stored.status !== 'pending' || !stored.error_message) throw new Error('failed row should stay pending with the error recorded');
    await admin(`admin_sql_pending_changes?batch_id=eq.${batch}`, { method: 'DELETE' });
    return `rolled back; error pinned to statement 2: ${(json.error ?? '').slice(0, 50)}`;
  });

  await step('Secrets sync to preview', async () => {
    const { res, json, text } = await api(`/api/v1/database/sync-secrets${q}`, { method: 'POST', body: { project_id: projectId }, raw: true });
    if (!res.ok) throw new Error(`${res.status} ${json?.error ?? text.slice(0, 100)}`);
    return `synced=${json?.synced ?? '?'} restarted=${json?.restarted ?? '?'}`;
  });

  // ── Edge functions ─────────────────────────────────────────────────────────
  await step('Edge functions list', async () => {
    const json = await api(`/api/v1/functions${q}`);
    const fns = json.functions ?? [];
    const withInputs = fns.every((f) => Array.isArray(f.inputs));
    if (!withInputs) throw new Error('list rows lack `inputs` (server-side input names)');
    if (fns.some((f) => 'code' in f)) throw new Error('list leaks function code to the client');
    return `${fns.length} function${fns.length === 1 ? '' : 's'}, no code in payload`;
  });

  await step('Edge functions are agent-only (POST locked)', async () => {
    const { res } = await api(`/api/v1/functions${q}`, { method: 'POST', body: { name: 'x', code: 'return 1' }, raw: true });
    if (res.ok) throw new Error('direct create was accepted; it must be locked to the agent');
    return `HTTP ${res.status}`;
  });

  const FN = 'ecg_check_ping';
  if (flag('--with-function')) {
    if (!CFG.serviceKey) report('SKIP', 'Edge function round-trip', 'SUPABASE_SERVICE_ROLE_KEY needed to seed a test function');
    else {
      let fnId;
      await step('Edge function seed (direct row)', async () => {
        await admin(`edge_functions?project_id=eq.${projectId}&name=eq.${FN}`, { method: 'DELETE' });
        const rows = await admin('edge_functions', {
          method: 'POST', prefer: 'return=representation',
          body: [{ user_id: userId, project_id: projectId, name: FN, description: 'ecg-cloud-check ping',
                   code: 'const { x } = params;\nreturn { ok: true, echo: x, at: new Date().toISOString() };',
                   requires_service_role: false, is_public: true }],
        });
        fnId = rows?.[0]?.id; if (!fnId) throw new Error('insert returned no row');
        return `id ${fnId.slice(0, 8)}…`;
      });
      await step('Edge function inputs derived', async () => {
        const json = await api(`/api/v1/functions${q}`);
        const fn = (json.functions ?? []).find((f) => f.name === FN);
        if (!fn) throw new Error('seeded function not in list');
        if (!fn.inputs.includes('x')) throw new Error(`inputs=${JSON.stringify(fn.inputs)}, expected ["x"]`);
        return `inputs=${JSON.stringify(fn.inputs)}`;
      });
      await step('Edge function invoke', async () => {
        const json = await api(`/api/v1/functions/${FN}/invoke${q}`, { method: 'POST', body: { params: { x: 42 } } });
        if (json.error) throw new Error(json.error);
        if (json.result?.echo !== 42) throw new Error(`unexpected result ${JSON.stringify(json.result).slice(0, 80)}`);
        return `echo=42 in ${json.durationMs}ms`;
      });
      await step('Edge function logs', async () => {
        const json = await api(`/api/v1/functions/${FN}/logs${q}`);
        const n = (json.logs ?? []).length;
        if (n === 0) throw new Error('no log rows after invoke');
        return `${n} log row${n === 1 ? '' : 's'}`;
      });
      await step('Edge function cleanup', async () => {
        await admin(`edge_functions?project_id=eq.${projectId}&name=eq.${FN}`, { method: 'DELETE' });
        return 'removed';
      });
    }
  } else {
    report('SKIP', 'Edge function round-trip', 'pass --with-function to seed, invoke, read logs, delete');
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  let noteId;
  await step('Knowledge add note', async () => {
    try {
      await api(`/api/v1/knowledge${q}`, { method: 'POST', body: { project_id: projectId, heading: 'cloud-check note', content: 'Written by ecg-cloud-check; safe to delete.' } });
      const json = await api(`/api/v1/knowledge${q}`);
      const note = (json.chunks ?? []).find((c) => c.heading === 'cloud-check note');
      if (!note) throw new Error('note not listed after POST');
      noteId = note.id;
      return `id ${noteId.slice(0, 8)}… tokens=${note.tokens}`;
    } catch (err) { if (err.status === 404) return skip('knowledge routes not mounted on this API build'); throw err; }
  });
  await step('Knowledge archive / restore', async () => {
    if (!noteId) return skip('no note');
    await api(`/api/v1/knowledge/${noteId}${q}`, { method: 'PATCH', body: { project_id: projectId, archived: true } });
    let json = await api(`/api/v1/knowledge${q}`);
    if (!(json.chunks ?? []).find((c) => c.id === noteId)?.archived) throw new Error('archive did not stick');
    await api(`/api/v1/knowledge/${noteId}${q}`, { method: 'PATCH', body: { project_id: projectId, archived: false } });
    json = await api(`/api/v1/knowledge${q}`);
    if ((json.chunks ?? []).find((c) => c.id === noteId)?.archived) throw new Error('restore did not stick');
    return 'ok';
  });
  await step('Knowledge delete', async () => {
    if (!noteId) return skip('no note');
    await api(`/api/v1/knowledge/${noteId}${q}`, { method: 'DELETE' });
    const json = await api(`/api/v1/knowledge${q}`);
    if ((json.chunks ?? []).some((c) => c.id === noteId)) throw new Error('note still listed after DELETE');
    return 'ok';
  });

  // ── Preview ────────────────────────────────────────────────────────────────
  await step('Preview service health', async () => {
    const res = await fetch(`${CFG.preview}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return 'ok';
  });
  if (flag('--with-preview')) {
    await step('Preview push + status', async () => {
      // A local preview-service usually has no PREVIEW_UPDATE_SECRET; send the
      // header only when one is configured and let the service decide.
      const files = [
        { path: 'src/App.tsx', content: 'export default function App() { return <main style={{ padding: 32, fontFamily: "system-ui" }}><h1>ecg-cloud-check</h1><p>preview push works</p></main>; }' },
        { path: 'src/main.tsx', content: "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);" },
      ];
      const res = await fetch(`${CFG.preview}/preview/${projectId}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(CFG.previewSecret ? { 'x-update-secret': CFG.previewSecret } : {}) },
        body: JSON.stringify({ files, fullSync: true, baseSeq: new Date().toISOString() }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) return skip(`preview-service requires PREVIEW_UPDATE_SECRET (${res.status})`);
      if (!res.ok) throw new Error(`update ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
      if (json.rolledBack) throw new Error(`push rolled back: ${JSON.stringify(json.errors ?? json).slice(0, 160)}`);
      const st = await (await fetch(`${CFG.preview}/preview/${projectId}/status`)).json();
      if (st.healthy === false) throw new Error(`status unhealthy: ${(st.errors ?? []).slice(0, 2).join(' | ')}`);
      return `healthy=${st.healthy} live=${st.live}`;
    });
  } else {
    report('SKIP', 'Preview push + status', 'pass --with-preview to push a two-file app and check /status');
  }

  await finish();
}

async function finish() {
  if (createdProject && projectId && dbProvisioned && !flag('--keep')) {
    await step('Deprovision database', async () => {
      // The route demands the schema name back as confirmation; that is the point of it.
      await api(`/api/v1/database/deprovision?project_id=${encodeURIComponent(projectId)}`, { method: 'DELETE', body: { project_id: projectId, confirm: dbSchema } });
      return `${dbSchema} dropped`;
    });
  }
  if (createdOrg && orgId && !flag('--keep')) {
    await step('Cleanup organization', async () => {
      await admin(`org_members?org_id=eq.${orgId}`, { method: 'DELETE' });
      await admin(`organizations?id=eq.${orgId}`, { method: 'DELETE' });
      return 'deleted';
    });
  }
  if (createdProject && projectId && !flag('--keep')) {
    await step('Cleanup project', async () => {
      await api(`/api/v1/projects/${projectId}`, { method: 'DELETE' });
      return 'deleted';
    });
  }
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const passes = results.filter((r) => r.status === 'PASS').length;
  const skips = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped\n`);
  process.exit(fails);
}

main().catch((err) => { console.error(err); process.exit(1); });
