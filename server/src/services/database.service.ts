import { createHmac } from 'crypto';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Config   all from env vars
// ---------------------------------------------------------------------------
function cfg() {
  const host     = process.env.TENANT_DB_HOST;
  const port     = parseInt(process.env.TENANT_DB_PORT || '5432', 10);
  const user     = process.env.TENANT_DB_SUPERUSER     || 'ecg_provisioner';
  const password = process.env.TENANT_DB_SUPERUSER_PASSWORD;
  const database = process.env.TENANT_DB_NAME          || 'ecg_tenants';
  const jwtSecret = process.env.TENANT_DB_JWT_SECRET;
  const apiUrl   = process.env.TENANT_DB_API_URL       || 'https://cloud.ecomgear.app';

  if (!host || !password || !jwtSecret) {
    throw new Error('Missing TENANT_DB_HOST, TENANT_DB_SUPERUSER_PASSWORD or TENANT_DB_JWT_SECRET env vars');
  }
  return { host, port, user, password, database, jwtSecret, apiUrl };
}

// ---------------------------------------------------------------------------
// Lazy PG pool
// ---------------------------------------------------------------------------
let _pool: import('pg').Pool | null = null;

async function pool(): Promise<import('pg').Pool> {
  if (_pool) return _pool;
  const c = cfg();
  const { Pool } = await import('pg');
  _pool = new Pool({
    host: c.host, port: c.port, user: c.user,
    password: c.password, database: c.database,
    ssl: process.env.TENANT_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 10,
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// JWT helpers   HS256, no external dep
// ---------------------------------------------------------------------------
function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload: object, secret: string, expiresInDays = 365): string {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInDays * 86400 }));
  const sig     = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64')
                    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

function tenantJwts(schemaId: string): { anon_key: string; service_key: string } {
  const { jwtSecret } = cfg();
  return {
    anon_key:    signJwt({ role: `${schemaId}_anon`    }, jwtSecret),
    service_key: signJwt({ role: `${schemaId}_service` }, jwtSecret),
  };
}

/**
 * Verify a tenant JWT (VITE_DB_ANON_KEY / VITE_DB_SERVICE_KEY) signed by signJwt().
 * Returns the decoded { role, exp } payload if the signature and expiry are
 * valid, or null otherwise. Used to authenticate public/anonymous requests
 * (e.g. edge-function invocation from a generated app's own end users) without
 * requiring an EcomGear platform login.
 */
export function verifyTenantJwt(token: string): { role: string; exp: number } | null {
  try {
    const { jwtSecret } = cfg();
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const expectedSig = createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.role !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/** Resolve a tenant schema's owning user_id + project_id from its registered schema_name. */
export async function getOwnerBySchema(schemaName: string): Promise<{ user_id: string; project_id: string | null } | null> {
  const { data } = await supabase
    .from('tenant_databases')
    .select('user_id, project_id')
    .eq('schema_name', schemaName)
    .eq('status', 'active')
    .maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Schema ID: short, stable, postgres-safe from projectId.
// Uses 16 hex chars (64 bits of UUID entropy) to make collisions negligible.
// ---------------------------------------------------------------------------
function schemaId(projectId: string): string {
  return 'tenant_' + projectId.replace(/-/g, '').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TenantDb {
  id: string;
  user_id: string;
  project_id: string | null;
  organization_id: string | null;
  schema_name: string;
  status: 'provisioning' | 'active' | 'error' | 'deprovisioned';
  error_message: string | null;
  created_at: string;
}

export interface TenantCredentials {
  api_url: string;
  schema: string;
  anon_key: string;
  service_key: string;
  db_url: string;
}

export interface TenantTable {
  name: string;
  columns: { name: string; type: string; nullable: boolean; default: string | null }[];
  row_count: number | null;
}

// ---------------------------------------------------------------------------
// SQL literal formatting   used by dumpDatabase for INSERT statements
// ---------------------------------------------------------------------------
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Splits a multi-statement SQL script on top-level semicolons only, ignoring
 * semicolons inside single-quoted string literals and $$/$tag$ dollar-quoted
 * bodies (Postgres function/procedure definitions). The regex this replaced
 * (`;\s*\n|;\s*$|;(?=\s*[A-Za-z])`) had no concept of dollar-quoting, so any
 * CREATE FUNCTION ... AS $$ ... END; $$ body had its internal `stmt;\n`
 * sequences treated as statement boundaries, shattering the function into
 * invalid fragments. Confirmed live: an agent run burned 3 retries
 * reformatting a syntactically-valid function body to dodge this splitter
 * before landing on a shape it happened not to break.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let inSingleQuote = false;
  let dollarTag: string | null = null;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { current += "'"; i += 2; continue; } // escaped '' inside literal
        inSingleQuote = false;
      }
      i++;
      continue;
    }

    if (ch === "'") { inSingleQuote = true; current += ch; i++; continue; }

    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { dollarTag = m[0]; current += m[0]; i += m[0].length; continue; }
    }

    if (ch === ';') {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last) statements.push(last);
  return statements;
}

// ---------------------------------------------------------------------------
// Platform auth secrets   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are the
// EcomGear platform's OWN Supabase instance (used for user sign-up/login in
// generated apps), NOT the per-project hosted database. Nothing else in the
// codebase ever wrote these into project_secrets, so every generated app's
// `createClient(import.meta.env.VITE_SUPABASE_URL, ...)` call got `undefined`
// and threw "supabaseUrl is required"   the system prompt told the agent to
// use these env vars, but they never actually existed anywhere. Every project
// gets these regardless of plan tier or hosted-database status (auth works
// even on free/no-DB projects).
// ---------------------------------------------------------------------------
export async function syncPlatformAuthSecrets(projectId: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) {
    logger.warn('[databaseService] SUPABASE_URL/SUPABASE_ANON_KEY not set on server   cannot sync platform auth secrets');
    return;
  }
  const { error } = await supabase.from('project_secrets').upsert(
    [
      { project_id: projectId, key_name: 'VITE_SUPABASE_URL', key_value: url },
      { project_id: projectId, key_name: 'VITE_SUPABASE_ANON_KEY', key_value: anonKey },
    ],
    { onConflict: 'project_id,key_name' }
  );
  if (error) logger.warn('[databaseService] failed to sync platform auth secrets', error);
}

export interface ProjectSecret {
  key_name: string;
  key_value: string;
}

// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for every env var injected into the agent's prompt
// context. Previously ai.routes.ts independently re-derived VITE_FUNCTIONS_API_URL
// / VITE_DB_* with its own fallback logic and disagreed with this file (used
// gen.ecomgear.dev   the wrong server   as a fallback, and injected the
// full-privilege service_key under a VITE_ name). Every caller that needs "what
// env vars does this project have" MUST go through this function instead of
// recomputing anything locally   that's how the two diverged last time.
// ---------------------------------------------------------------------------
export async function buildProjectEnvSecrets(userId: string, projectId: string): Promise<ProjectSecret[]> {
  const { data: userRows } = await supabase
    .from('project_secrets')
    .select('key_name, key_value')
    .eq('project_id', projectId);
  const userSecrets: ProjectSecret[] = (userRows ?? []) as ProjectSecret[];
  const userKeys = new Set(userSecrets.map(s => s.key_name));

  const derived: ProjectSecret[] = [];

  // Platform auth   every project gets this, regardless of plan tier or
  // hosted-database status (also persisted via syncPlatformAuthSecrets, fired
  // below, so it self-heals in project_secrets for the NEXT run too).
  const authUrl = process.env.SUPABASE_URL;
  const authAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (authUrl && authAnonKey) {
    derived.push({ key_name: 'VITE_SUPABASE_URL', key_value: authUrl });
    derived.push({ key_name: 'VITE_SUPABASE_ANON_KEY', key_value: authAnonKey });
  }
  syncPlatformAuthSecrets(projectId).catch(() => {});

  // Hosted DB   getCredentials() is a no-op (returns null) without an active
  // database, and already upserts these same rows into project_secrets.
  const dbCreds = await databaseService.getCredentials(userId, projectId);
  if (dbCreds) {
    // Edge functions execute on VPS5, next to the tenant database   never on
    // api.ecomgear.dev, which is reserved for EcomGear's own platform API.
    // dbCreds.api_url already carries the tenant schema segment
    // (https://cloud.ecomgear.app/tenant_xxxx), so /functions lands on the
    // same nginx-routed path the function-runner (vps5-functions-runner/) serves.
    const functionsApiUrl = `${dbCreds.api_url}/functions`;
    derived.push({ key_name: 'VITE_DB_API_URL', key_value: dbCreds.api_url });
    derived.push({ key_name: 'VITE_DB_ANON_KEY', key_value: dbCreds.anon_key });
    derived.push({ key_name: 'VITE_DB_SCHEMA', key_value: dbCreds.schema });
    derived.push({ key_name: 'VITE_FUNCTIONS_API_URL', key_value: functionsApiUrl });
    // service_key is deliberately NOT included   a full-privilege credential must
    // never carry a VITE_ prefix (Vite would bundle it straight into the browser).
    // Edge functions already get privileged db.* access server-side; nothing
    // needs the raw key in agent-visible context.
  }

  // User-defined secrets win on any key collision.
  return [...derived.filter(s => !userKeys.has(s.key_name)), ...userSecrets];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export const databaseService = {

  // ── Status ──────────────────────────────────────────────────────────────
  // Look up by project_id first (new rows), fall back to user_id (legacy rows
  // provisioned before the project_id migration   those have project_id = NULL).
  async getStatus(userId: string, projectId?: string): Promise<TenantDb | null> {
    if (projectId) {
      const { data } = await supabase
        .from('tenant_databases')
        .select('*')
        .eq('project_id', projectId)
        .not('status', 'eq', 'deprovisioned')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) return data as TenantDb;
    }

    // Fallback: legacy rows only (project_id IS NULL)   provisioned before the
    // project_id migration. Must NOT match on user_id alone: a user with
    // multiple projects each provisioned under their own project_id would
    // otherwise get a DIFFERENT project's schema/credentials returned here
    // whenever the projectId given has no row of its own yet.
    if (projectId) return null;

    const { data, error } = await supabase
      .from('tenant_databases')
      .select('*')
      .eq('user_id', userId)
      .is('project_id', null)
      .not('status', 'eq', 'deprovisioned')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as TenantDb | null;
  },

  // ── Credentials (regenerated on-demand, never stored) ───────────────────
  // db_url intentionally omitted: direct Postgres connections bypass SET ROLE
  // and search_path isolation. Use the PostgREST API URL with these JWT keys.
  async getCredentials(userId: string, projectId?: string): Promise<TenantCredentials | null> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return null;
    const c = cfg();
    const { anon_key, service_key } = tenantJwts(record.schema_name);
    // api_url carries the tenant's schema AS PART OF THE PATH
    // (https://cloud.ecomgear.app/tenant_xxxx), not just the bare shared host.
    // Old convention required every caller to remember a separate
    // Accept-Profile/Content-Profile header naming the schema   forget it (as
    // generated frontend code repeatedly did) and PostgREST 404s/406s silently
    // routing to the wrong schema. VPS5's nginx now reads the tenant segment
    // out of the URL itself and sets those headers server-side, so a caller
    // that only ever uses this URL cannot get the schema wrong.
    const creds: TenantCredentials = {
      api_url:     `${c.apiUrl}/${record.schema_name}`,
      schema:      record.schema_name,
      anon_key,
      service_key,
      db_url: `postgresql://${record.schema_name}_owner@${c.host}:${c.port}/${c.database}?search_path=${record.schema_name}`,
    };

    // Keep VITE_DB_API_URL/VITE_DB_ANON_KEY/VITE_DB_SCHEMA in sync so generated
    // frontend code (import.meta.env.VITE_DB_*) always resolves to this one
    // hosted DB instead of the agent falling back to inventing a separate one.
    if (projectId) {
      // VITE_FUNCTIONS_API_URL: edge functions execute on VPS5 (the
      // function-runner in vps5-functions-runner/), reached through the same
      // tenant-scoped cloud.ecomgear.app path as the DB   never api.ecomgear.dev,
      // which stays reserved for EcomGear's own platform API. Synced here so
      // the env var the system prompt tells the agent to use actually exists.
      const functionsApiUrl = `${creds.api_url}/functions`;
      supabase.from('project_secrets').upsert(
        [
          { project_id: projectId, key_name: 'VITE_DB_API_URL', key_value: creds.api_url },
          { project_id: projectId, key_name: 'VITE_DB_ANON_KEY', key_value: creds.anon_key },
          { project_id: projectId, key_name: 'VITE_DB_SCHEMA', key_value: creds.schema },
          { project_id: projectId, key_name: 'VITE_FUNCTIONS_API_URL', key_value: functionsApiUrl },
        ],
        { onConflict: 'project_id,key_name' }
      ).then(({ error }) => {
        if (error) logger.warn('[databaseService] failed to sync VITE_DB_* project secrets', error);
      });
    }

    return creds;
  },

  // ── Provision ────────────────────────────────────────────────────────────
  async provision(userId: string, organizationId: string | null, projectId?: string): Promise<TenantDb> {
    const existing = await this.getStatus(userId, projectId);
    if (existing && existing.status === 'active') {
      throw new Error('already_provisioned');
    }

    // Schema name derived from projectId (isolated per project) or userId (legacy).
    const schema = schemaId(projectId ?? userId);
    const anonRole    = `${schema}_anon`;
    const serviceRole = `${schema}_service`;
    const ownerRole   = `${schema}_owner`;
    const ownerPass   = Buffer.from((projectId ?? userId) + process.env.TENANT_DB_JWT_SECRET!).toString('base64').slice(0, 24);
    const { user: superuser } = cfg();

    // Upsert tracking record   reuses an existing deprovisioned row with the same
    // schema_name instead of inserting a duplicate (which would violate the unique constraint).
    const { data: row, error: insertErr } = await supabase
      .from('tenant_databases')
      .upsert(
        { user_id: userId, project_id: projectId ?? null, organization_id: organizationId, schema_name: schema, status: 'provisioning', error_message: null },
        { onConflict: 'schema_name' }
      )
      .select().single();
    if (insertErr) throw new Error(insertErr.message);
    const record = row as TenantDb;

    try {
      const pg = await pool();
      const c  = await pg.connect();
      try {
        // 1. Schema
        await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        // 2. Roles (safe: check first)
        for (const [role, opts] of [
          [anonRole,    'NOLOGIN'],
          [serviceRole, 'NOLOGIN'],
          [ownerRole,   `LOGIN ENCRYPTED PASSWORD '${ownerPass.replace(/'/g, "''")}'`],
        ] as [string, string][]) {
          const exists = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
          if (!exists.rows.length) await c.query(`CREATE ROLE "${role}" ${opts}`);
        }

        // 2b. Grant SET privilege to the provisioner role itself. PostgreSQL 16+
        // auto-grants CREATEROLE creators ADMIN on roles they create, but NOT
        // INHERIT/SET   without this, both `SET ROLE` (used by runQuery()) and
        // `ALTER DEFAULT PRIVILEGES FOR ROLE` (used below) fail with
        // "permission denied".
        await c.query(`GRANT "${anonRole}"    TO "${superuser}" WITH INHERIT TRUE, SET TRUE`);
        await c.query(`GRANT "${serviceRole}" TO "${superuser}" WITH INHERIT TRUE, SET TRUE`);
        await c.query(`GRANT "${ownerRole}"   TO "${superuser}" WITH INHERIT TRUE, SET TRUE`);

        // 3. Permissions   anon + service: no public schema access so neither role
        // can enumerate ecg_tenant_registry or read other tenants' objects.
        await c.query(`REVOKE ALL ON SCHEMA public FROM "${anonRole}"`);
        await c.query(`REVOKE ALL ON SCHEMA public FROM "${serviceRole}"`);
        await c.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${anonRole}"`);

        // 4. Permissions   service: full on their own schema only
        await c.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${serviceRole}"`);

        // 5. Permissions   owner: full + login
        await c.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${ownerRole}"`);

        // 5a. Every generated app's login/signup function is told (app-builder
        // prompt) to hash passwords via pgcrypto's extensions.crypt/gen_salt.
        // Without USAGE on the shared `extensions` schema, that call fails with
        // "permission denied for schema extensions"   this was missing from
        // provisioning entirely, so every tenant hit it the first time anyone
        // logged in. `extensions` belongs to whichever tenant happened to
        // CREATE EXTENSION pgcrypto first (a pre-existing quirk of this shared
        // instance, not something to fix here), but "${superuser}" already
        // holds USAGE WITH GRANT OPTION on it, so it can re-grant regardless of
        // who owns it.
        await c.query(`GRANT USAGE ON SCHEMA extensions TO "${anonRole}", "${serviceRole}", "${ownerRole}"`);

        // 5b. Default privileges, scoped to the roles that actually CREATE tables
        // (serviceRole   used by the agent's query_database tool   and ownerRole  
        // used by direct postgres:// connections). `ALTER DEFAULT PRIVILEGES` with
        // no `FOR ROLE` only applies to objects the EXECUTING role (the provisioner)
        // creates, which never happens in practice   without `FOR ROLE` here, anon
        // and the other roles get NO access to tables created later by service/owner,
        // and PostgREST returns "permission denied" on every table.
        for (const creator of [serviceRole, ownerRole]) {
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT SELECT ON TABLES TO "${anonRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT SELECT ON SEQUENCES TO "${anonRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${serviceRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT ALL ON SEQUENCES TO "${serviceRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT ALL ON FUNCTIONS TO "${serviceRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${ownerRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT ALL ON SEQUENCES TO "${ownerRole}"`);
          await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${creator}" IN SCHEMA "${schema}" GRANT ALL ON FUNCTIONS TO "${ownerRole}"`);
        }

        // 6. Set search_path so roles always land in their schema
        await c.query(`ALTER ROLE "${anonRole}"    SET search_path TO "${schema}"`);
        await c.query(`ALTER ROLE "${serviceRole}" SET search_path TO "${schema}"`);
        await c.query(`ALTER ROLE "${ownerRole}"   SET search_path TO "${schema}"`);

        // 7. Grant roles to authenticator so PostgREST can impersonate them
        await c.query(`GRANT "${anonRole}"    TO authenticator`);
        await c.query(`GRANT "${serviceRole}" TO authenticator`);

        // 8. Register schema in the tenant registry (updates PostgREST config).
        // `id` MUST be unique per schema, not per user   a user provisioning a
        // SECOND project previously reused `id = userId`, which collided with
        // their first project's row under `ON CONFLICT (id) DO NOTHING` and
        // silently skipped the insert. The new schema never entered the
        // registry, so it was never added to PostgREST's exposed schema list  
        // every table request against that project's DB permanently 404'd
        // with PGRST106 "Invalid schema", even though tenant_databases showed
        // status 'active'. schema_name already has its own unique constraint;
        // use that as the conflict target instead.
        await c.query(
          `INSERT INTO public.ecg_tenant_registry (id, schema_name, anon_role, service_role)
           VALUES ($1, $2, $3, $4) ON CONFLICT (schema_name) DO NOTHING`,
          [schema, schema, anonRole, serviceRole]
        );
      } finally {
        c.release();
      }

      // 9. Reload PostgREST so it picks up the new schema
      await this._reloadPostgREST();

      // 10. Mark active
      await supabase.from('tenant_databases').update({ status: 'active' }).eq('id', record.id);
      record.status = 'active';
      logger.info('Tenant DB provisioned', { userId, schema });
      return record;

    } catch (err) {
      const msg = (err as Error).message;
      await supabase.from('tenant_databases').update({ status: 'error', error_message: msg }).eq('id', record.id);
      throw new Error(`Provisioning failed: ${msg}`);
    }
  },

  // ── Permission preflight for a newly-written edge function ────────────────
  // Real incident this closes: an edge function's own code was always
  // syntax-checked before saving (write_edge_function.ts), but never
  // permission-checked   `db.select('users', ...)` or `db.rpc('rpc_hash_password', ...)`
  // only ever failed with "permission denied" the first time a REAL USER hit
  // it in production, days after the function was written and reported
  // working. This runs read-only privilege checks against the tables/RPCs the
  // code actually references and grants whatever's missing   the same grants
  // provision() already gives every OTHER table, just applied retroactively
  // for tables/functions that didn't exist yet at provisioning time. Never
  // touches data, never blocks the write; best-effort, logs and returns a
  // summary so write_edge_function can tell the agent what it did.
  async ensureFunctionDbAccess(userId: string, projectId: string, code: string): Promise<string[]> {
    const notes: string[] = [];
    try {
      const status = await this.getStatus(userId, projectId);
      if (!status || status.status !== 'active') return notes;
      const schema = status.schema_name;
      const anonRole = `${schema}_anon`;
      const serviceRole = `${schema}_service`;

      // Static scan: table names from db.select/insert/update/delete/count,
      // function names from db.rpc. Regex, not a real parser   this only
      // grants what it's confident about; anything it misses just falls back
      // to today's behavior (fails loudly at real invoke time).
      const tableNames = new Set<string>();
      for (const m of code.matchAll(/\bdb\.(?:select|insert|update|delete|count)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
        tableNames.add(m[1]);
      }
      const rpcNames = new Set<string>();
      for (const m of code.matchAll(/\bdb\.rpc\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
        rpcNames.add(m[1]);
      }
      if (tableNames.size === 0 && rpcNames.size === 0) return notes;

      const pg = await pool();
      const c = await pg.connect();
      try {
        // Any RPC call at all: pgcrypto-backed helpers (password hashing, etc.)
        // are the single most common cause of this failure class, and USAGE on
        // a schema is safe to grant unconditionally   it doesn't expose any
        // table, just makes the schema's already-EXECUTE-granted functions
        // resolvable by name.
        if (rpcNames.size > 0) {
          const { rows } = await c.query<{ ok: boolean }>(
            `SELECT has_schema_privilege($1, 'extensions', 'USAGE') AS ok`,
            [serviceRole]
          );
          if (!rows[0]?.ok) {
            await c.query(`GRANT USAGE ON SCHEMA extensions TO "${anonRole}", "${serviceRole}"`);
            notes.push('Granted USAGE ON SCHEMA extensions (needed for pgcrypto-backed db.rpc calls)');
          }
        }

        for (const table of tableNames) {
          const exists = await c.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
            [schema, table]
          );
          if (!exists.rows.length) continue; // typo'd/not-yet-created table   not this function's problem

          const { rows } = await c.query<{ ok: boolean }>(
            `SELECT has_table_privilege($1, format('%I.%I', $2::text, $3::text), 'SELECT') AS ok`,
            [serviceRole, schema, table]
          );
          if (!rows[0]?.ok) {
            await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${table}" TO "${serviceRole}"`);
            await c.query(`GRANT SELECT ON "${schema}"."${table}" TO "${anonRole}"`);
            notes.push(`Granted table access on "${table}" (existed but was never granted to this project's DB roles)`);
          }
        }

        for (const fn of rpcNames) {
          const { rows } = await c.query<{ oid: string }>(
            `SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`,
            [schema, fn]
          );
          if (!rows.length) continue;
          const { rows: execRows } = await c.query<{ ok: boolean }>(
            `SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`,
            [serviceRole, rows[0].oid]
          );
          if (!execRows[0]?.ok) {
            await c.query(`GRANT EXECUTE ON FUNCTION "${schema}"."${fn}" TO "${anonRole}", "${serviceRole}"`);
            notes.push(`Granted EXECUTE on function "${fn}"`);
          }
        }
      } finally {
        c.release();
      }
    } catch (err) {
      logger.warn('[databaseService] ensureFunctionDbAccess preflight failed (non-fatal)', err);
    }
    return notes;
  },

  // ── Deprovision ──────────────────────────────────────────────────────────
  async deprovision(userId: string, projectId?: string): Promise<void> {
    const record = await this.getStatus(userId, projectId);
    if (!record) throw new Error('No active database found');

    await supabase.from('tenant_databases').update({ status: 'deprovisioning' }).eq('id', record.id);
    const schema = record.schema_name;

    try {
      const pg = await pool();
      const c  = await pg.connect();
      try {
        // Remove from registry first
        await c.query(`DELETE FROM public.ecg_tenant_registry WHERE schema_name = $1`, [schema]);

        // Drop schema and all its objects
        await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

        // Drop roles
        for (const role of [`${schema}_anon`, `${schema}_service`, `${schema}_owner`]) {
          await c.query(`DROP ROLE IF EXISTS "${role}"`);
        }
      } finally {
        c.release();
      }

      await this._reloadPostgREST();
      await supabase.from('tenant_databases').update({ status: 'deprovisioned' }).eq('id', record.id);
      if (projectId) {
        await supabase.from('project_secrets').delete()
          .eq('project_id', projectId)
          .in('key_name', ['VITE_DB_API_URL', 'VITE_DB_ANON_KEY', 'VITE_DB_SCHEMA']);
      }
      logger.info('Tenant DB deprovisioned', { userId, projectId, schema });

    } catch (err) {
      const msg = (err as Error).message;
      await supabase.from('tenant_databases').update({ status: 'error', error_message: msg }).eq('id', record.id);
      throw new Error(`Deprovision failed: ${msg}`);
    }
  },

  // ── List tables in tenant schema ─────────────────────────────────────────
  async listTables(userId: string, projectId?: string): Promise<TenantTable[]> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return [];

    const pg = await pool();
    const { rows } = await pg.query<{
      table_name: string; column_name: string; data_type: string;
      is_nullable: string; column_default: string | null;
    }>(
      `SELECT t.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
       FROM information_schema.tables t
       JOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name, c.ordinal_position`,
      [record.schema_name]
    );

    // Group by table
    const tableMap = new Map<string, TenantTable>();
    for (const row of rows) {
      if (!tableMap.has(row.table_name)) {
        tableMap.set(row.table_name, { name: row.table_name, columns: [], row_count: null });
      }
      tableMap.get(row.table_name)!.columns.push({
        name: row.column_name, type: row.data_type,
        nullable: row.is_nullable === 'YES', default: row.column_default,
      });
    }

    // Get row counts
    const tables = [...tableMap.values()];
    for (const t of tables) {
      try {
        const res = await pg.query(`SELECT COUNT(*)::int FROM "${record.schema_name}"."${t.name}"`);
        t.row_count = res.rows[0].count;
      } catch { /* skip */ }
    }

    return tables;
  },

  // ── Query rows from a table ──────────────────────────────────────────────
  async queryTable(userId: string, tableName: string, limit = 50, offset = 0, projectId?: string): Promise<{ rows: object[]; total: number }> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') throw new Error('No active database');

    // Validate table exists in their schema
    const tables = await this.listTables(userId, projectId);
    if (!tables.find(t => t.name === tableName)) throw new Error('Table not found');

    const pg = await pool();
    const safe = `"${record.schema_name}"."${tableName}"`;
    const [dataRes, countRes] = await Promise.all([
      pg.query(`SELECT * FROM ${safe} LIMIT $1 OFFSET $2`, [limit, offset]),
      pg.query(`SELECT COUNT(*)::int as count FROM ${safe}`),
    ]);
    return { rows: dataRes.rows, total: countRes.rows[0].count };
  },

  // ── Connection check   live ping, separate from the stored provisioning status ──
  async testConnection(userId: string, projectId?: string): Promise<{ connected: boolean; latencyMs?: number; error?: string }> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return { connected: false, error: 'No active database' };

    const start = Date.now();
    try {
      const pg = await pool();
      await pg.query('SELECT 1');
      return { connected: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { connected: false, error: (err as Error).message };
    }
  },

  // ── Full SQL dump (schema + data) of the tenant's schema ──────────────────
  // Capped at DUMP_ROW_LIMIT rows per table to prevent DoS via huge responses.
  async dumpDatabase(userId: string, projectId?: string): Promise<{ sql: string; schema: string; truncated: boolean }> {
    const DUMP_ROW_LIMIT = 10_000;
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') throw new Error('No active database');

    const tables = await this.listTables(userId, projectId);
    const pg = await pool();
    let truncated = false;
    const lines: string[] = [
      `-- EcomGear hosted database dump`,
      `-- schema: ${record.schema_name}`,
      `-- generated: ${new Date().toISOString()}`,
      `-- row limit per table: ${DUMP_ROW_LIMIT}`,
      '',
    ];

    for (const t of tables) {
      const colDefs = t.columns.map((c) => {
        let def = `"${c.name}" ${c.type}`;
        if (!c.nullable) def += ' NOT NULL';
        if (c.default) def += ` DEFAULT ${c.default}`;
        return def;
      });
      lines.push(`CREATE TABLE IF NOT EXISTS "${t.name}" (`);
      lines.push('  ' + colDefs.join(',\n  '));
      lines.push(');');
      lines.push('');

      const { rows } = await pg.query(
        `SELECT * FROM "${record.schema_name}"."${t.name}" LIMIT $1`,
        [DUMP_ROW_LIMIT + 1]
      );
      const capped = rows.length > DUMP_ROW_LIMIT;
      if (capped) { rows.pop(); truncated = true; }

      if (rows.length > 0) {
        if (capped) lines.push(`-- WARNING: table "${t.name}" truncated to ${DUMP_ROW_LIMIT} rows`);
        const cols = Object.keys(rows[0]);
        const colList = cols.map((c) => `"${c}"`).join(', ');
        const valueRows = rows.map((row) => '(' + cols.map((c) => sqlLiteral((row as any)[c])).join(', ') + ')');
        lines.push(`INSERT INTO "${t.name}" (${colList}) VALUES`);
        lines.push(valueRows.join(',\n') + ';');
        lines.push('');
      }
    }

    return { sql: lines.join('\n'), schema: record.schema_name, truncated };
  },

  // ── Safe SQL execution (SELECT only for users, full for agent) ───────────
  async runQuery(userId: string, sql: string, role: 'anon' | 'service' = 'anon', projectId?: string): Promise<{ rows: object[]; fields: string[]; statementsRun?: number }> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') throw new Error('No active database');

    const trimmed = sql.trim();

    if (role === 'anon') {
      // Block multi-statement SQL: a semicolon after the SELECT lets the next
      // statement escape the role sandbox.
      if (/;/.test(trimmed)) throw new Error('Only a single SELECT statement is allowed');

      // Block SET commands (search_path override, role change, etc.)
      if (/^\s*(set|reset|do|call|copy|listen|notify|load|vacuum|analyze|cluster|reindex|checkpoint|show)\s/i.test(trimmed)) {
        throw new Error('Statement type not allowed');
      }

      // Block CTEs with DML (WITH x AS (INSERT/UPDATE/DELETE ...) SELECT ...)
      if (/\binsert\b|\bupdate\b|\bdelete\b|\btruncate\b|\bdrop\b|\bcreate\b|\balter\b/i.test(trimmed)) {
        throw new Error('Only SELECT queries are allowed');
      }

      if (!/^select\s/i.test(trimmed)) throw new Error('Only SELECT queries are allowed');
    }

    const pg = await pool();
    const schemaRole = role === 'service' ? `${record.schema_name}_service` : `${record.schema_name}_anon`;

    // Timeout: anon (user SQL editor) 10s, service (agent) 30s.
    const timeoutMs = role === 'service' ? 30_000 : 10_000;

    // For service role, split on semicolons so the agent can pass full migration
    // scripts (multiple DDL/DML statements) in one call. Each statement runs inside
    // the same transaction   if any fails the whole batch rolls back.
    const statements = role === 'service'
      ? splitSqlStatements(trimmed)
      : [trimmed];

    const c = await pg.connect();
    try {
      await c.query(`SET ROLE "${schemaRole}"`);
      await c.query('BEGIN');
      await c.query(`SET LOCAL search_path TO "${record.schema_name}"`);
      await c.query(`SET LOCAL statement_timeout TO ${timeoutMs}`);

      let lastResult: any = { rows: [], fields: [] };
      for (const stmt of statements) {
        lastResult = await c.query(stmt);
      }

      await c.query('COMMIT');

      // DDL run through here (agent's query_database tool creating/altering
      // tables) changes the schema but PostgREST caches its schema at startup  
      // without a reload, the new table 404s with PGRST205 "not in schema
      // cache" on every REST call until something unrelated (a provision/
      // deprovision elsewhere) happens to trigger a reload. Only provision()/
      // deprovision() called this before; ad-hoc DDL from the agent never did.
      // Awaited (not fire-and-forget): the agent's very next step often reads
      // the table it just created via the REST API, so the reload needs to
      // land before this tool call returns, not sometime after.
      const ranDdl = statements.some(s => /^\s*(create|alter|drop)\s/i.test(s));
      if (ranDdl) {
        try {
          await this._reloadPostgREST();
        } catch (err) {
          console.warn(`[DatabaseService] Schema-cache reload after DDL failed (non-fatal, will self-heal on next provision event): ${(err as Error).message}`);
        }
      }

      return {
        rows: lastResult.rows ?? [],
        fields: lastResult.fields?.map((f: any) => f.name) ?? [],
        statementsRun: statements.length,
      };
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      try { await c.query('RESET ROLE'); } catch { /* ignore */ }
      c.release();
    }
  },

  // ── Reload PostgREST schemas via SSH-less mechanism ──────────────────────
  // This was previously fire-and-forget: one attempt, no response-status check,
  // any failure silently swallowed. A transient network blip between VPS1 and
  // VPS5 meant the schema got registered in ecg_tenant_registry correctly but
  // PostgREST never actually picked it up   the project showed "active" and
  // every request against it 404'd with PGRST106 "Invalid schema" until someone
  // noticed and ran the reload manually. Retries 3x with backoff and throws on
  // total failure so provision() can surface it instead of reporting success.
  async _reloadPostgREST(): Promise<void> {
    const reloadUrl = process.env.TENANT_DB_RELOAD_URL;
    if (!reloadUrl) return;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(reloadUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.TENANT_DB_RELOAD_SECRET}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`reload endpoint returned ${res.status}`);
        return;
      } catch (err) {
        lastErr = err;
        logger.warn(`PostgREST reload attempt ${attempt}/3 failed`, err);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
    throw new Error(`PostgREST reload failed after 3 attempts: ${(lastErr as Error)?.message ?? lastErr}`);
  },
};
