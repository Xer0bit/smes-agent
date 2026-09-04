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
  const apiUrl   = process.env.TENANT_DB_API_URL       || 'https://cloud.SMEsAgent.app';

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
 * requiring an SMEsAgent platform login.
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
// 2026-08 audit (Domain 5): this value is interpolated raw into DDL
// throughout this file (CREATE SCHEMA, GRANT, DROP SCHEMA ... CASCADE, etc.)
// -- Postgres can't parameterize identifiers, so raw interpolation is
// unavoidable there. Today's only caller path is safe (projectId/userId are
// system-generated UUIDs verified against a real DB row before reaching
// here, per requireProjectEdit in database.routes.ts), but that safety
// depended entirely on every future caller preserving that upstream
// contract, with no check at the point of actual use. Asserting the output
// shape here is real defense-in-depth: even a future caller that passes
// unvalidated input can only ever produce a schema name matching this exact
// pattern, never break out of the quoted identifier.
function schemaId(projectId: string): string {
  const id = 'tenant_' + projectId.replace(/-/g, '').slice(0, 16);
  if (!/^tenant_[a-zA-Z0-9]{1,16}$/.test(id)) {
    throw new Error(`Invalid derived schema identifier for projectId "${projectId}"`);
  }
  return id;
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

export interface TenantFunction {
  name: string;
  argTypes: string;
  returnType: string;
}

/** One foreign-key edge: `table.column -> refTable.refColumn`. */
export interface TenantRelationship {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

/** Live access-control state for one table. */
/** Supabase-style overview: health numbers plus the shape the ERD draws. */
export interface TenantOverview {
  schema: string;
  health: {
    connected: boolean;
    latency_ms: number | null;
    server_version: string | null;
    size_bytes: number;
    tables: number;
    views: number;
    functions: number;
    sequences: number;
    indexes: number;
    policies: number;
    triggers: number;
    rls_enabled_tables: number;
    tables_without_policies: string[];
    connections: number;
    roles: { anon: boolean; service: boolean; owner: boolean };
    api_exposed: boolean | null;
    dead_tuple_ratio: number | null;
    last_analyze: string | null;
  };
  tables: Array<{
    name: string;
    row_estimate: number;
    size_bytes: number;
    index_count: number;
    seq_scans: number;
    idx_scans: number;
    dead_tuples: number;
    rls_enabled: boolean;
    policy_count: number;
    columns: Array<{ name: string; type: string; nullable: boolean; default: string | null; primary_key: boolean; unique: boolean }>;
  }>;
  relationships: TenantRelationship[];
}

export interface TenantTableAccess {
  table: string;
  rlsEnabled: boolean;
  /** Policy summaries, e.g. `select(anon)`. Empty with rlsEnabled means deny-all. */
  policies: string[];
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

export interface ProjectSecret {
  key_name: string;
  key_value: string;
}

// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for every env var injected into the agent's prompt
// context. Previously ai.routes.ts independently re-derived VITE_FUNCTIONS_API_URL
// / VITE_DB_* with its own fallback logic and disagreed with this file (used
// gen.SMEsAgent.dev   the wrong server   as a fallback, and injected the
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

  const derived: ProjectSecret[] = [];

  // Nothing from the platform's own environment is ever derived here. Until
  // 2026-09-02 every project was handed SMEsAgent's own Supabase URL and anon
  // key as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (and they were upserted
  // into project_secrets, 46 projects' worth), so every generated app's users
  // signed up against the platform's auth database with the platform's key
  // in their bundle. A project's environment holds the project's own
  // credentials: its hosted database, its edge functions, and whatever the
  // owner saved with set_secret or in Settings. Auth is the app's own edge
  // functions against its own database.

  // Hosted DB   getCredentials() is a no-op (returns null) without an active
  // database, and already upserts these same rows into project_secrets.
  const dbCreds = await databaseService.getCredentials(userId, projectId);
  if (dbCreds) {
    // Edge functions execute on VPS5, next to the tenant database   never on
    // api.SMEsAgent.dev, which is reserved for SMEsAgent's own platform API.
    // dbCreds.api_url already carries the tenant schema segment
    // (https://cloud.SMEsAgent.app/tenant_xxxx), so /functions lands on the
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

  // User-defined secrets win on any key collision -- EXCEPT for the platform-
  // managed keys derived above. Those get upserted into project_secrets as a
  // side effect (syncPlatformAuthSecrets / getCredentials, both fire-and-
  // forget, not awaited), so `userSecrets` here is a snapshot fetched BEFORE
  // that upsert lands -- on every call, not just the first. Previously this
  // function's "user secrets win" rule applied to these keys too (they live
  // in the same table), which meant a stale/wrong stored row for e.g.
  // VITE_FUNCTIONS_API_URL would win over the freshly-computed correct value
  // FOREVER: the returned value on every call (including every Sync-button
  // click and every agent-turn injection) was the old snapshot, and the
  // "self-heal" upsert only ever wrote a value nothing then read back this
  // way. Confirmed live: this is why one production project's
  // VITE_FUNCTIONS_API_URL sat on a stale host for an extended period despite
  // Sync being clicked and the agent running turns against it repeatedly --
  // neither could actually correct it, only a direct backfill could.
  // 2026-08-05 stability review follow-up. Real user secrets (API keys saved
  // via set_secret) are unaffected -- only these six reserved names are now
  // always platform-authoritative.
  const platformManagedKeys = new Set(derived.map(s => s.key_name));
  const userOverrides = userSecrets.filter(s => !platformManagedKeys.has(s.key_name));
  return [...derived, ...userOverrides];
}

// ---------------------------------------------------------------------------
// RLS enforcement   deny-all by default on every new tenant table.
//
// 2026-08 security fix (Critical #1): every tenant table previously got a
// flat `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ... TO anon` (see step 5b
// in provision() below) with Row Level Security never enabled anywhere. The
// anon key is shipped client-side in every generated app's JS bundle BY
// DESIGN (public, like a Supabase anon key) and cloud.SMEsAgent.app/PostgREST
// enforces nothing beyond that JWT + these Postgres GRANTs   so anyone who
// pulled the anon key out of a generated app's bundle could SELECT any table
// in that tenant's schema directly. Confirmed live, internet-reachable.
//
// Fix: after every service-role DDL batch (the agent's query_database tool
// and executeTransactionalMigration()   the only two code paths that execute
// agent-authored SQL against a tenant schema, per the 2026-08 audit trace),
// scan pg_class for tables in this schema with relrowsecurity = false and
// ENABLE ROW LEVEL SECURITY on each, INSIDE the same transaction as the DDL
// that created them, before COMMIT. With RLS enabled and zero policies
// defined, the table is unreadable/unwritable via the anon (or service) role
// until a policy is explicitly added -- deny-all by default, per policy
// decision. The role that just CREATEd the table is its owner, and table
// owners bypass RLS by default, so the agent's own service-role session is
// unaffected; only non-owner roles (anon, and service on tables it doesn't
// own) are denied.
//
// Deliberately NOT a regex/string scan for "CREATE TABLE" in the agent's SQL
// text (fragile -- CREATE TABLE AS, SELECT INTO, quoted/schema-qualified
// names, etc. would slip through). This is catalog introspection instead:
// it does not care what DDL shape produced the table, only that a table
// without RLS now exists in this schema. It also does not require any
// elevated Postgres privilege beyond what the creating role already has
// (ALTER TABLE ... ENABLE ROW LEVEL SECURITY only needs table ownership) --
// unlike a `CREATE EVENT TRIGGER`, which needs superuser or the
// pg_create_event_trigger role and can't be confirmed available to
// TENANT_DB_SUPERUSER on this managed instance, and would fail this fix
// silently if it isn't.
//
// A pre-existing table from BEFORE this fix that isn't owned by the role
// running this batch would hit `insufficient_privilege` on the ALTER --
// caught and skipped (best-effort) so it can't roll back an unrelated
// migration; retroactive remediation of already-provisioned tenant tables is
// a separate, explicit backfill, out of scope here.
async function enableRlsOnNewTables(client: import('pg').PoolClient, schemaName: string): Promise<void> {
  // schemaName always comes from schemaId()'s validated output (see comment
  // there), never raw user input -- safe to interpolate into this literal.
  await client.query(`
    DO $ecg_rls$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schemaName}' AND c.relkind = 'r' AND NOT c.relrowsecurity
      LOOP
        BEGIN
          EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', '${schemaName}', r.relname);
        EXCEPTION WHEN insufficient_privilege THEN
          -- not owned by the role running this batch (pre-existing table);
          -- not this migration's table to fix, skip it.
          NULL;
        END;
      END LOOP;
    END
    $ecg_rls$;
  `);
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
        .select('id, user_id, project_id, organization_id, schema_name, status, error_message, created_at')
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
      .select('id, user_id, project_id, organization_id, schema_name, status, error_message, created_at')
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
    // (https://cloud.SMEsAgent.app/tenant_xxxx), not just the bare shared host.
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
      // tenant-scoped cloud.SMEsAgent.app path as the DB   never api.SMEsAgent.dev,
      // which stays reserved for SMEsAgent's own platform API. Synced here so
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
        // Steps 1-8 below were previously each auto-committed individually --
        // a failure partway through (e.g. a GRANT failing after roles were
        // already created) left permanently orphaned schema/role state with
        // no rollback, since Postgres has no implicit rollback across
        // separate statements. Wrapped in one transaction so a failure at any
        // point undoes everything back to nothing, matching CREATE SCHEMA IF
        // NOT EXISTS / role-exists-check's own idempotency (a retry after a
        // clean rollback is safe). 2026-08 stability review, Step 1.
        await c.query('BEGIN');

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

        await c.query('COMMIT');
      } catch (err) {
        try { await c.query('ROLLBACK'); } catch { /* connection may already be dead */ }
        throw err;
      } finally {
        c.release();
      }

      // 9. Reload PostgREST so it picks up the new schema. This is a
      // best-effort, retried, but SEPARATE step from the DDL transaction
      // above -- schema/roles/grants/registry-row are already fully and
      // correctly committed by this point. A reload failure here must NOT
      // be reported as a provisioning failure (that would be a false
      // negative: the tenant DB is actually live and correct, just not yet
      // visible to PostgREST's cache). Recorded as a non-blocking warning on
      // the 'active' row instead, so it's still surfaced without masking a
      // real success. 2026-08 stability review, Step 1.
      let reloadWarning: string | null = null;
      try {
        await this._reloadPostgREST();
      } catch (err) {
        reloadWarning = (err as Error).message;
        logger.warn('Tenant DB provisioned but PostgREST reload failed -- schema is live but may 404 until reloaded', { userId, schema, error: reloadWarning });
      }

      // 10. Mark active
      await supabase.from('tenant_databases').update({
        status: 'active',
        error_message: reloadWarning ? `Provisioned successfully; PostgREST reload failed and may need a retry: ${reloadWarning}` : null,
      }).eq('id', record.id);
      record.status = 'active';
      logger.info('Tenant DB provisioned', { userId, schema, reloadWarning });
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
        // Previously three separate auto-committed statements -- a crash or
        // connection drop between the registry DELETE and the schema DROP
        // left the registry saying "gone" while the schema and all its data
        // silently still existed (orphaned, invisible to PostgREST, but not
        // actually deleted -- worse than data loss, since the user believes
        // it's gone). Wrapped in a transaction so this is all-or-nothing.
        // 2026-08 stability review, Step 5.
        await c.query('BEGIN');

        // Remove from registry first
        await c.query(`DELETE FROM public.ecg_tenant_registry WHERE schema_name = $1`, [schema]);

        // Drop schema and all its objects
        await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

        // Drop roles
        for (const role of [`${schema}_anon`, `${schema}_service`, `${schema}_owner`]) {
          // provision() granted these roles USAGE ON SCHEMA extensions, and a
          // role that still holds a privilege cannot be dropped ("some objects
          // depend on it"). DROP OWNED revokes every privilege the role holds in
          // this database (the tenant schema itself is already gone above), so
          // the DROP ROLE that follows is unconditional. Found by the local
          // cloud check on 2026-09-02; production deprovision hit the same wall.
          await c.query(`DROP OWNED BY "${role}"`);
          await c.query(`DROP ROLE IF EXISTS "${role}"`);
        }

        await c.query('COMMIT');
      } catch (err) {
        try { await c.query('ROLLBACK'); } catch { /* connection may already be dead */ }
        throw err;
      } finally {
        c.release();
      }

      // Schema/roles/registry are already fully and correctly dropped by this
      // point -- a reload failure here doesn't change that the data is gone,
      // it only means PostgREST's cache may serve stale 404s/lookups for a
      // bit longer. Same non-blocking-warning treatment as provision().
      let reloadWarning: string | null = null;
      try {
        await this._reloadPostgREST();
      } catch (err) {
        reloadWarning = (err as Error).message;
        logger.warn('Tenant DB deprovisioned but PostgREST reload failed -- schema is gone but cache may be stale', { userId, projectId, schema, error: reloadWarning });
      }

      await supabase.from('tenant_databases').update({
        status: 'deprovisioned',
        error_message: reloadWarning ? `Deprovisioned successfully; PostgREST reload failed and may need a retry: ${reloadWarning}` : null,
      }).eq('id', record.id);
      if (projectId) {
        await supabase.from('project_secrets').delete()
          .eq('project_id', projectId)
          .in('key_name', ['VITE_DB_API_URL', 'VITE_DB_ANON_KEY', 'VITE_DB_SCHEMA']);
      }
      logger.info('Tenant DB deprovisioned', { userId, projectId, schema, reloadWarning });

    } catch (err) {
      const msg = (err as Error).message;
      await supabase.from('tenant_databases').update({ status: 'error', error_message: msg }).eq('id', record.id);
      throw new Error(`Deprovision failed: ${msg}`);
    }
  },

  // ── Archive (not drop) a tenant DB when its owning project is deleted ─────
  // deprovision() above is the right call for an EXPLICIT, single-purpose
  // "remove my database" action (Settings page, admin tool) -- immediate
  // DROP SCHEMA CASCADE is the correct behavior there. Project deletion is a
  // different risk profile: it's one step inside a larger, automated,
  // fire-and-forget cascade, where a wrong-project-id bug anywhere upstream
  // would otherwise permanently destroy a tenant's real data with no
  // recovery path (unlike the platform DB, which gets a 2-year archive on
  // delete). This renames the schema out of PostgREST's reach and revokes
  // its roles' access instead of dropping anything -- reversible by a
  // support action until a separate, deliberately-not-automated purge job
  // hard-deletes schemas past their retention window.
  async archiveForProjectDeletion(projectId: string): Promise<void> {
    const { data: record } = await supabase
      .from('tenant_databases')
      .select('id, schema_name, status')
      .eq('project_id', projectId)
      .not('status', 'eq', 'deprovisioned')
      .maybeSingle();
    if (!record) return; // most projects never provisioned a hosted DB -- not an error

    const schema = record.schema_name as string;
    const archivedSchema = `deleted_${schema}_${Date.now()}`;

    const pg = await pool();
    const c = await pg.connect();
    try {
      await c.query('BEGIN');
      // Belt-and-suspenders alongside the schema rename below: a deleted
      // project's edge functions must stop being invocable even if
      // PostgREST's schema cache is briefly stale after reload -- the
      // functions-runner (VPS5) checks is_active on every invoke, so this
      // closes the window immediately regardless of cache timing.
      await c.query(`UPDATE public.tenant_functions SET is_active = false WHERE schema_name = $1`, [schema]);
      await c.query(`ALTER SCHEMA "${schema}" RENAME TO "${archivedSchema}"`);
      for (const role of [`${schema}_anon`, `${schema}_service`, `${schema}_owner`]) {
        // REVOKE, not DROP ROLE -- the role's GRANTs inside the archived
        // schema must survive for a support-initiated restore (rename back +
        // re-grant) to actually work. Dropping the role here would silently
        // strip that on some Postgres versions.
        await c.query(`REVOKE ALL PRIVILEGES ON SCHEMA "${archivedSchema}" FROM "${role}"`).catch(() => {});
      }
      await c.query('COMMIT');
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch { /* connection may already be dead */ }
      throw err;
    } finally {
      c.release();
    }

    let reloadWarning: string | null = null;
    try {
      await this._reloadPostgREST();
    } catch (err) {
      reloadWarning = (err as Error).message;
      logger.warn('Tenant DB archived on project delete but PostgREST reload failed -- schema is renamed but cache may be stale', { projectId, schema, archivedSchema, error: reloadWarning });
    }

    await supabase.from('tenant_databases').update({
      status: 'deprovisioned',
      error_message: `Archived on project deletion as "${archivedSchema}" (not dropped -- recoverable via support). ${reloadWarning ? `PostgREST reload failed and may need a retry: ${reloadWarning}` : ''}`.trim(),
    }).eq('id', record.id);
    logger.info('Tenant DB archived for project deletion', { projectId, schema, archivedSchema, reloadWarning });
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

  // ── List Postgres functions/RPCs in the tenant schema ────────────────────
  // The agent's `db.rpc(fnName, args)` bridge (functionRunner.service.ts) can
  // call any function already granted EXECUTE in this schema, but until now
  // there was no way for the agent to discover what already exists there --
  // listTables() only ever covered tables, so the agent's only options were
  // to guess a name or run a raw pg_proc query itself via query_database. The
  // gap showed up as duplicate/near-duplicate RPC functions across runs, the
  // same failure mode write_edge_function's disk mirror was built to prevent
  // for edge functions. 2026-08-05 stability review follow-up.
  async listFunctions(userId: string, projectId?: string): Promise<TenantFunction[]> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return [];

    const pg = await pool();
    const { rows } = await pg.query<{ name: string; arg_types: string; return_type: string }>(
      `SELECT p.proname AS name,
              pg_catalog.pg_get_function_arguments(p.oid) AS arg_types,
              pg_catalog.pg_get_function_result(p.oid) AS return_type
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind = 'f'
       ORDER BY p.proname`,
      [record.schema_name]
    );

    return rows.map((r) => ({ name: r.name, argTypes: r.arg_types, returnType: r.return_type }));
  },

  // ── Foreign keys ─────────────────────────────────────────────────────────
  // listTables reports columns only, so the agent was told the exact column
  // names but nothing about how tables relate, and inferred relationships from
  // naming. Wrong joins on anything non-obvious follow directly from that.
  async listRelationships(userId: string, projectId?: string): Promise<TenantRelationship[]> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return [];

    const pg = await pool();
    const { rows } = await pg.query<{ table: string; column: string; ref_table: string; ref_column: string }>(
      `SELECT tc.table_name AS table, kcu.column_name AS column,
              ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
        ORDER BY tc.table_name, kcu.column_name`,
      [record.schema_name]
    );
    return rows.map((r) => ({ table: r.table, column: r.column, refTable: r.ref_table, refColumn: r.ref_column }));
  },

  // ── RLS state + policies ─────────────────────────────────────────────────
  // The prompt carried a STATIC "every table is deny-all by default (RLS on,
  // zero policies)" warning. It stops being true the moment the agent creates a
  // policy, and nothing updated it -- so a 403 could mean "no policy", "policy
  // excludes this role", or "no grant", and the agent had no way to tell them
  // apart. It guessed, which is the retry loop.
  async listTableAccess(userId: string, projectId?: string): Promise<TenantTableAccess[]> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return [];

    const pg = await pool();
    const { rows } = await pg.query<{ table: string; rls_enabled: boolean; cmd: string | null; roles: string | null }>(
      `SELECT c.relname AS table, c.relrowsecurity AS rls_enabled,
              p.cmd, array_to_string(p.polroles_names, ',') AS roles
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN (
           SELECT pol.polrelid,
                  CASE pol.polcmd WHEN 'r' THEN 'select' WHEN 'a' THEN 'insert'
                                  WHEN 'w' THEN 'update' WHEN 'd' THEN 'delete' ELSE 'all' END AS cmd,
                  ARRAY(SELECT pg_get_userbyid(unnest(pol.polroles))) AS polroles_names
             FROM pg_policy pol
         ) p ON p.polrelid = c.oid
        WHERE n.nspname = $1 AND c.relkind = 'r'
        ORDER BY c.relname`,
      [record.schema_name]
    );

    const byTable = new Map<string, TenantTableAccess>();
    for (const r of rows) {
      if (!byTable.has(r.table)) {
        byTable.set(r.table, { table: r.table, rlsEnabled: Boolean(r.rls_enabled), policies: [] });
      }
      if (r.cmd) byTable.get(r.table)!.policies.push(r.roles ? `${r.cmd}(${r.roles})` : r.cmd);
    }
    return [...byTable.values()];
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

  // ── Overview: health + ERD shape. Catalog and statistics reads only; never
  // touches tenant data rows (row numbers are planner estimates).
  async getOverview(userId: string, projectId?: string): Promise<TenantOverview | null> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') return null;
    const schema = record.schema_name;
    const pg = await pool();

    const start = Date.now();
    let connected = true; let latency: number | null = null; let version: string | null = null;
    try {
      const v = await pg.query<{ v: string }>('SHOW server_version');
      latency = Date.now() - start; version = v.rows[0]?.v ?? null;
    } catch { connected = false; }

    const [stats, tables, columns, counts, conns, roles, exposed, analyze] = await Promise.all([
      pg.query<{ tables: string; views: string; functions: string; sequences: string; indexes: string; policies: string; triggers: string; size: string }>(
        `SELECT
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r') AS tables,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v','m')) AS views,
           (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1) AS functions,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S') AS sequences,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'i') AS indexes,
           (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1) AS policies,
           (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal) AS triggers,
           (SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','m')) AS size`,
        [schema]),
      pg.query<{ name: string; row_estimate: string; size_bytes: string; index_count: string; seq_scans: string; idx_scans: string; dead_tuples: string; rls_enabled: boolean; policy_count: string }>(
        `SELECT c.relname AS name, greatest(c.reltuples, 0)::bigint AS row_estimate, pg_total_relation_size(c.oid) AS size_bytes,
                (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS index_count,
                coalesce(st.seq_scan, 0) AS seq_scans, coalesce(st.idx_scan, 0) AS idx_scans, coalesce(st.n_dead_tup, 0) AS dead_tuples,
                c.relrowsecurity AS rls_enabled,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
          WHERE n.nspname = $1 AND c.relkind = 'r'
          ORDER BY c.relname`,
        [schema]),
      pg.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null; primary_key: boolean; is_unique: boolean }>(
        `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
                EXISTS (SELECT 1 FROM pg_index i JOIN pg_class r ON r.oid = i.indrelid JOIN pg_namespace n ON n.oid = r.relnamespace
                         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = ANY(i.indkey)
                        WHERE n.nspname = c.table_schema AND r.relname = c.table_name AND a.attname = c.column_name AND i.indisprimary) AS primary_key,
                EXISTS (SELECT 1 FROM pg_index i JOIN pg_class r ON r.oid = i.indrelid JOIN pg_namespace n ON n.oid = r.relnamespace
                         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = ANY(i.indkey)
                        WHERE n.nspname = c.table_schema AND r.relname = c.table_name AND a.attname = c.column_name AND i.indisunique AND NOT i.indisprimary) AS is_unique
           FROM information_schema.columns c
          WHERE c.table_schema = $1
          ORDER BY c.table_name, c.ordinal_position`,
        [schema]),
      pg.query<{ rls_tables: string }>(
        `SELECT count(*) AS rls_tables FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relrowsecurity`,
        [schema]),
      pg.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename LIKE $1`, [`${schema}\_%`]),
      pg.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [[`${schema}_anon`, `${schema}_service`, `${schema}_owner`]]),
      pg.query<{ schemas: string | null }>(`SELECT current_setting('pgrst.db_schemas', true) AS schemas`).catch(() => ({ rows: [{ schemas: null }] })),
      pg.query<{ last: string | null }>(
        `SELECT max(greatest(st.last_analyze, st.last_autoanalyze))::text AS last FROM pg_stat_user_tables st WHERE st.schemaname = $1`, [schema]),
    ]);

    const colsByTable = new Map<string, TenantOverview['tables'][number]['columns']>();
    for (const c of columns.rows) {
      if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, []);
      colsByTable.get(c.table_name)!.push({
        name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default,
        primary_key: c.primary_key, unique: c.is_unique,
      });
    }
    const tableRows = tables.rows.map((t) => ({
      name: t.name, row_estimate: Number(t.row_estimate), size_bytes: Number(t.size_bytes), index_count: Number(t.index_count),
      seq_scans: Number(t.seq_scans), idx_scans: Number(t.idx_scans), dead_tuples: Number(t.dead_tuples),
      rls_enabled: Boolean(t.rls_enabled), policy_count: Number(t.policy_count), columns: colsByTable.get(t.name) ?? [],
    }));
    const live = tableRows.reduce((n, t) => n + t.row_estimate, 0);
    const dead = tableRows.reduce((n, t) => n + t.dead_tuples, 0);
    const roleNames = new Set(roles.rows.map((r) => r.rolname));
    const exposedSchemas = exposed.rows[0]?.schemas;
    const s0 = stats.rows[0];

    return {
      schema,
      health: {
        connected, latency_ms: latency, server_version: version,
        size_bytes: Number(s0?.size ?? 0), tables: Number(s0?.tables ?? 0), views: Number(s0?.views ?? 0), functions: Number(s0?.functions ?? 0),
        sequences: Number(s0?.sequences ?? 0), indexes: Number(s0?.indexes ?? 0), policies: Number(s0?.policies ?? 0), triggers: Number(s0?.triggers ?? 0),
        rls_enabled_tables: Number(counts.rows[0]?.rls_tables ?? 0),
        tables_without_policies: tableRows.filter((t) => t.policy_count === 0).map((t) => t.name),
        connections: Number(conns.rows[0]?.n ?? 0),
        roles: { anon: roleNames.has(`${schema}_anon`), service: roleNames.has(`${schema}_service`), owner: roleNames.has(`${schema}_owner`) },
        api_exposed: exposedSchemas == null ? null : exposedSchemas.split(',').map((x) => x.trim()).includes(schema),
        dead_tuple_ratio: live + dead > 0 ? dead / (live + dead) : null,
        last_analyze: analyze.rows[0]?.last ?? null,
      },
      tables: tableRows,
      relationships: await this.listRelationships(userId, projectId),
    };
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
      `-- SMEsAgent hosted database dump`,
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
  /**
   * Run several staged statements as ONE transaction, in the given order, as
   * the tenant's service role. Either every statement lands or none does; on
   * failure the index of the statement that failed comes back with Postgres's
   * message, so the caller can pin the error to the right row.
   *
   * This is what the "Run all in order" action uses. Running rows one by one
   * from a newest-first list is how a CREATE TABLE ended up executed after
   * the INSERT that needed it.
   */
  async runStatementsAtomic(
    userId: string,
    statements: readonly string[],
    projectId?: string,
  ): Promise<{ ok: true } | { ok: false; failedIndex: number; error: string }> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') throw new Error('No active database');
    if (statements.length === 0) return { ok: true };

    const pg = await pool();
    const c = await pg.connect();
    let index = -1;
    try {
      await c.query(`SET ROLE "${record.schema_name}_service"`);
      await c.query('BEGIN');
      await c.query(`SET LOCAL search_path TO "${record.schema_name}"`);
      await c.query('SET LOCAL statement_timeout TO 30000');
      for (index = 0; index < statements.length; index++) {
        await c.query(statements[index]);
      }
      const ranDdl = statements.some((st) => /^\s*(create|alter|drop)\s/i.test(st));
      if (ranDdl) await enableRlsOnNewTables(c, record.schema_name);
      await c.query('COMMIT');
      if (ranDdl) {
        try { await this._reloadPostgREST(); }
        catch (err) { console.warn(`[DatabaseService] Schema-cache reload after batch DDL failed (non-fatal): ${(err as Error).message}`); }
      }
      return { ok: true };
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch { /* connection may be gone */ }
      return { ok: false, failedIndex: Math.max(0, index), error: (err as Error).message };
    } finally {
      try { await c.query('RESET ROLE'); } catch { /* ignore */ }
      c.release();
    }
  },

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

    // Computed before execution (not just for the reload/audit steps below):
    // gates the RLS-enforcement scan too, so it only runs when this batch
    // could plausibly have created a table.
    const ranDdl = statements.some(s => /^\s*(create|alter|drop)\s/i.test(s));

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

      // Deny-all by default: any table this batch just created still has RLS
      // disabled until this runs. Must happen INSIDE this transaction, before
      // COMMIT   see enableRlsOnNewTables() for why. Runs even for role ===
      // 'anon' technically never reaches here (anon can't run DDL, blocked
      // above), so this only ever fires for the service role's own tables.
      if (ranDdl) {
        await enableRlsOnNewTables(c, record.schema_name);
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
      if (ranDdl) {
        try {
          await this._reloadPostgREST();
        } catch (err) {
          console.warn(`[DatabaseService] Schema-cache reload after DDL failed (non-fatal, will self-heal on next provision event): ${(err as Error).message}`);
        }

        // Append-only audit trail for tenant DDL -- there is otherwise no
        // record anywhere of what schema changes landed on a tenant schema or
        // when. Best-effort, never blocks the query result: this is
        // visibility, not correctness (runQuery's own transaction above is
        // what actually keeps the DDL safe). 2026-08 stability review, Step 6.
        supabase.from('tenant_schema_migrations').insert({
          schema_name: record.schema_name,
          project_id: projectId ?? null,
          user_id: userId,
          sql_text: trimmed,
          statement_count: statements.length,
        }).then(({ error }) => {
          if (error) logger.warn('[databaseService] failed to record tenant_schema_migrations audit row (non-fatal)', error);
        });
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

  // ── Runtime verification for agent-written SQL functions ─────────────────
  // 2026-08-13 stability review: write_edge_function's AST validation and
  // query_database's DDL confirmation gate both check that CREATE FUNCTION
  // SQL is well-formed -- neither ever EXECUTES the function body. PL/pgSQL
  // does not resolve function/table/column references inside a function body
  // at CREATE time; a call to an undefined function (e.g. an unqualified
  // pgcrypto call) compiles cleanly and only fails the first time something
  // actually invokes it. Real incident: a register_and_login function passed
  // every static check and broke registration in production for hours before
  // anyone actually called it.
  //
  // This closes that gap: runs the function for real, inside a transaction
  // that ALWAYS rolls back (success or failure) -- so even a function that
  // inserts/updates/deletes rows, like register_and_login, can be tested
  // with zero lasting effect. Same SET ROLE + search_path scoping as
  // runQuery() above. Known caveat: sequence nextval() advances are NOT
  // transactional in Postgres and will NOT be undone by the rollback -- an
  // acceptable, minor side effect (a skipped ID value) for what this buys.
  async testDatabaseFunction(
    userId: string,
    functionName: string,
    args: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ ok: true; rows: object[] } | { ok: false; error: string }> {
    const record = await this.getStatus(userId, projectId);
    if (!record || record.status !== 'active') throw new Error('No active database');

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
      throw new Error(`Invalid function name "${functionName}"`);
    }
    for (const key of Object.keys(args)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid argument name "${key}"`);
      }
    }

    const pg = await pool();
    const schemaRole = `${record.schema_name}_service`;
    const c = await pg.connect();
    try {
      await c.query(`SET ROLE "${schemaRole}"`);
      await c.query('BEGIN');
      await c.query(`SET LOCAL search_path TO "${record.schema_name}"`);
      await c.query('SET LOCAL statement_timeout TO 10000');

      // Named-parameter call (func(param_name := $1, ...)) rather than
      // positional -- the agent supplies args keyed by the parameter names
      // it just declared, not an order it has to get exactly right.
      const argNames = Object.keys(args);
      const callArgs = argNames.map((name, i) => `${name} := $${i + 1}`).join(', ');
      const values = argNames.map((k) => args[k]);
      const result = await c.query(`SELECT * FROM ${functionName}(${callArgs})`, values);

      return { ok: true, rows: result.rows };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      try { await c.query('ROLLBACK'); } catch { /* ignore -- always roll back, this is a test */ }
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

  // ── Transactional DDL/DML Migration Execution ──────────────────────────────
  executeTransactionalMigration(userId: string, projectId: string, statements: string[]): Promise<MigrationResult> {
    return executeTransactionalMigration(userId, projectId, statements);
  },
};

export interface MigrationResult {
  success: boolean;
  statementsRun: number;
  error?: string;
}

/**
 * Execute an array of DDL/DML migration statements inside a strict, isolated PostgreSQL
 * transaction block (BEGIN ... COMMIT/ROLLBACK).
 * If any statement fails, the transaction is immediately rolled back and a detailed diagnostic
 * payload (containing Postgres error code, position, detail, hint, and failing SQL statement)
 * is returned to enable autonomous LLM error resolution.
 */
export async function executeTransactionalMigration(
  userId: string,
  projectId: string,
  statements: string[]
): Promise<MigrationResult> {
  const status = await databaseService.getStatus(userId, projectId);
  if (!status || status.status !== 'active') {
    return {
      success: false,
      statementsRun: 0,
      error: `[PostgreSQL DDL Migration Error] Database is not provisioned or active for project "${projectId}".`,
    };
  }

  const pg = await pool();
  const client = await pg.connect();
  const schemaRole = `${status.schema_name}_service`;
  let statementsRun = 0;

  try {
    await client.query(`SET ROLE "${schemaRole}"`);
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${status.schema_name}"`);
    await client.query(`SET LOCAL statement_timeout TO 30000`);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i].trim();
      if (!stmt) continue;
      await client.query(stmt);
      statementsRun++;
    }

    // Deny-all by default: same enforcement as runQuery()'s service-role
    // branch, see enableRlsOnNewTables() above for the full rationale. Must
    // run before COMMIT so it's part of the same atomic migration.
    const hasDdl = statements.some((s) => /^\s*(create|alter|drop)\s/i.test(s));
    if (hasDdl) {
      await enableRlsOnNewTables(client, status.schema_name);
    }

    await client.query('COMMIT');

    // Reload PostgREST schema cache if any statement was DDL
    if (hasDdl) {
      try {
        await databaseService._reloadPostgREST();
      } catch (reloadErr) {
        logger.warn('[executeTransactionalMigration] PostgREST reload warning', reloadErr);
      }

      // Record in audit table
      supabase.from('tenant_schema_migrations').insert({
        schema_name: status.schema_name,
        project_id: projectId,
        user_id: userId,
        sql_text: statements.join(';\n'),
        statement_count: statementsRun,
      }).then(({ error }) => {
        if (error) logger.warn('[executeTransactionalMigration] failed to record audit row', error);
      });
    }

    return {
      success: true,
      statementsRun,
    };
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure if connection died */
    }

    const pgCode = err.code ? String(err.code) : 'UNKNOWN';
    const position = err.position ? `Position ${err.position}` : 'Position unknown';
    const detail = err.detail ? `\nDetail: ${err.detail}` : '';
    const hint = err.hint ? `\nHint: ${err.hint}` : '';
    const constraint = err.constraint ? `\nConstraint: ${err.constraint}` : '';
    const where = err.where ? `\nContext: ${err.where}` : '';
    const failingStmt = statements[statementsRun] ? `\nFailing Statement: "${statements[statementsRun]}"` : '';
    const message = err.message ?? String(err);

    const detailedError =
      `[PostgreSQL DDL Migration Error] Transaction rolled back cleanly.\n` +
      `ErrorCode [${pgCode}]: ${message}\n` +
      `Location: ${position}${failingStmt}${detail}${constraint}${hint}${where}\n` +
      `Executed ${statementsRun} of ${statements.length} statements before failure.`;

    return {
      success: false,
      statementsRun,
      error: detailedError,
    };
  } finally {
    try {
      await client.query('RESET ROLE');
    } catch {
      /* ignore reset role error */
    }
    client.release();
  }
}

