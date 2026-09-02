#!/usr/bin/env node
/**
 * Local stand-in for cloud.ecomgear.app: the tenant API in front of the local
 * PostgREST, plus the reload hook provisioning calls after it creates a schema.
 *
 *   /<schema>/rest/v1/*    -> http://127.0.0.1:3010/*   with Accept-/Content-Profile: <schema>
 *   /<schema>/functions/*  -> http://localhost:5001/api/v1/functions/*   (edge-function invoke)
 *   POST /reload           -> expose every tenant schema to PostgREST and reload it
 *   GET  /health
 *
 * CORS is wide open: the preview iframe and the published app call this from
 * a browser. Started by scripts/local-tenant-db.sh; no dependencies.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.TENANT_API_PORT || 54330);
const POSTGREST = process.env.TENANT_POSTGREST_URL || 'http://127.0.0.1:3010';
const FUNCTIONS = process.env.TENANT_FUNCTIONS_URL || 'http://localhost:5001/api/v1/functions';
const RELOAD_SECRET = process.env.TENANT_DB_RELOAD_SECRET || '';
const DB_CONTAINER = process.env.TENANT_DB_CONTAINER || '';
const SCHEMA_RE = /^[a-z][a-z0-9_]{1,62}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-client-info',
  'Access-Control-Expose-Headers': 'content-range, range-unit, location',
  'Access-Control-Max-Age': '86400',
};

function psql(sql, db = 'ecg_tenants') {
  return execFileSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${process.env.SUPABASE_DB_PASSWORD || 'postgres'}`, DB_CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', db, '-tA', '-c', sql], { encoding: 'utf8' }).trim();
}

/** Every user-created schema in ecg_tenants is a tenant; expose them all. */
function reloadPostgrest() {
  const rows = psql(`select nspname from pg_namespace where nspname not in ('public','extensions','information_schema','pg_catalog','pg_toast') and nspname not like 'pg_%' order by 1`);
  const schemas = ['public', ...rows.split('\n').filter((s) => SCHEMA_RE.test(s))];
  psql(`alter role ecg_provisioner set pgrst.db_schemas = '${schemas.join(',')}'`);
  psql(`notify pgrst, 'reload config'`);
  psql(`notify pgrst, 'reload schema'`);
  return schemas;
}

async function forward(req, res, target, extraHeaders = {}) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { ...req.headers, ...extraHeaders };
  delete headers.host; delete headers.connection; delete headers['content-length'];
  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: `upstream unreachable: ${err.message}`, target }));
    return;
  }
  const out = { ...CORS };
  upstream.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify({ ok: true, postgrest: POSTGREST, functions: FUNCTIONS })); return; }

  if (url.pathname === '/reload' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    if (RELOAD_SECRET && auth !== `Bearer ${RELOAD_SECRET}`) { res.writeHead(401, CORS); res.end('bad reload secret'); return; }
    try {
      const schemas = reloadPostgrest();
      console.log(`[tenant-api] reload: ${schemas.join(', ')}`);
      res.writeHead(200, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify({ ok: true, schemas }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  const m = url.pathname.match(/^\/([^/]+)\/(rest\/v1|functions)(\/.*)?$/);
  if (!m || !SCHEMA_RE.test(m[1])) { res.writeHead(404, CORS); res.end('not a tenant path'); return; }
  const [, schema, kind, rest = ''] = m;
  if (kind === 'rest/v1') {
    await forward(req, res, `${POSTGREST}${rest || '/'}${url.search}`, { 'accept-profile': schema, 'content-profile': schema });
  } else {
    await forward(req, res, `${FUNCTIONS}${rest}${url.search}`);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[tenant-api] listening on http://127.0.0.1:${PORT}  postgrest=${POSTGREST}  functions=${FUNCTIONS}`));
