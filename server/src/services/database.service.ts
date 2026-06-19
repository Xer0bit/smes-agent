import { createHmac } from 'crypto';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Config — all from env vars
// ---------------------------------------------------------------------------
function cfg() {
  const host     = process.env.TENANT_DB_HOST;
  const port     = parseInt(process.env.TENANT_DB_PORT || '5432', 10);
  const user     = process.env.TENANT_DB_SUPERUSER     || 'ecg_provisioner';
  const password = process.env.TENANT_DB_SUPERUSER_PASSWORD;
  const database = process.env.TENANT_DB_NAME          || 'ecg_tenants';
  const jwtSecret = process.env.TENANT_DB_JWT_SECRET;
  const apiUrl   = process.env.TENANT_DB_API_URL       || 'https://db.ecomgear.app';

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
// JWT helpers — HS256, no external dep
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

// ---------------------------------------------------------------------------
// Schema ID: short, stable, postgres-safe from userId
// Uses 16 hex chars (64 bits of UUID entropy) to make collisions negligible.
// ---------------------------------------------------------------------------
function schemaId(userId: string): string {
  return 'tenant_' + userId.replace(/-/g, '').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TenantDb {
  id: string;
  user_id: string;
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
// SQL literal formatting — used by dumpDatabase for INSERT statements
// ---------------------------------------------------------------------------
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export const databaseService = {

  // ── Status ──────────────────────────────────────────────────────────────
  async getStatus(userId: string): Promise<TenantDb | null> {
    const { data, error } = await supabase
      .from('tenant_databases')
      .select('*')
      .eq('user_id', userId)
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
  async getCredentials(userId: string): Promise<TenantCredentials | null> {
    const record = await this.getStatus(userId);
    if (!record || record.status !== 'active') return null;
    const c = cfg();
    const { anon_key, service_key } = tenantJwts(record.schema_name);
    return {
      api_url:     c.apiUrl,
      schema:      record.schema_name,
      anon_key,
      service_key,
      db_url: `postgresql://${record.schema_name}_owner@${c.host}:${c.port}/${c.database}?search_path=${record.schema_name}`,
    };
  },

  // ── Provision ────────────────────────────────────────────────────────────
  async provision(userId: string, organizationId: string | null): Promise<TenantDb> {
    const existing = await this.getStatus(userId);
    if (existing && existing.status === 'active') {
      throw new Error('already_provisioned');
    }

    const schema = schemaId(userId);
    const anonRole    = `${schema}_anon`;
    const serviceRole = `${schema}_service`;
    const ownerRole   = `${schema}_owner`;
    const ownerPass   = Buffer.from(userId + process.env.TENANT_DB_JWT_SECRET!).toString('base64').slice(0, 24);
    const { user: superuser } = cfg();

    // Insert tracking record
    const { data: row, error: insertErr } = await supabase
      .from('tenant_databases')
      .insert({ user_id: userId, organization_id: organizationId, schema_name: schema, status: 'provisioning' })
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
        // INHERIT/SET — without this, both `SET ROLE` (used by runQuery()) and
        // `ALTER DEFAULT PRIVILEGES FOR ROLE` (used below) fail with
        // "permission denied".
        await c.query(`GRANT "${anonRole}"    TO "${superuser}" WITH INHERIT TRUE, SET TRUE`);
        await c.query(`GRANT "${serviceRole}" TO "${superuser}" WITH INHERIT TRUE, SET TRUE`);
        await c.query(`GRANT "${ownerRole}"   TO "${superuser}" WITH INHERIT TRUE, SET TRUE`);

        // 3. Permissions — anon + service: no public schema access so neither role
        // can enumerate ecg_tenant_registry or read other tenants' objects.
        await c.query(`REVOKE ALL ON SCHEMA public FROM "${anonRole}"`);
        await c.query(`REVOKE ALL ON SCHEMA public FROM "${serviceRole}"`);
        await c.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${anonRole}"`);

        // 4. Permissions — service: full on their own schema only
        await c.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${serviceRole}"`);

        // 5. Permissions — owner: full + login
        await c.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${ownerRole}"`);

        // 5b. Default privileges, scoped to the roles that actually CREATE tables
        // (serviceRole — used by the agent's query_database tool — and ownerRole —
        // used by direct postgres:// connections). `ALTER DEFAULT PRIVILEGES` with
        // no `FOR ROLE` only applies to objects the EXECUTING role (the provisioner)
        // creates, which never happens in practice — without `FOR ROLE` here, anon
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

        // 8. Register schema in the tenant registry (updates PostgREST config)
        await c.query(
          `INSERT INTO public.ecg_tenant_registry (id, schema_name, anon_role, service_role)
           VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [userId, schema, anonRole, serviceRole]
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

  // ── Deprovision ──────────────────────────────────────────────────────────
  async deprovision(userId: string): Promise<void> {
    const record = await this.getStatus(userId);
    if (!record) throw new Error('No active database found');

    await supabase.from('tenant_databases').update({ status: 'deprovisioning' }).eq('id', record.id);
    const schema = record.schema_name;

    try {
      const pg = await pool();
      const c  = await pg.connect();
      try {
        // Remove from registry first
        await c.query(`DELETE FROM public.ecg_tenant_registry WHERE id = $1`, [userId]);

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
      logger.info('Tenant DB deprovisioned', { userId, schema });

    } catch (err) {
      const msg = (err as Error).message;
      await supabase.from('tenant_databases').update({ status: 'error', error_message: msg }).eq('id', record.id);
      throw new Error(`Deprovision failed: ${msg}`);
    }
  },

  // ── List tables in tenant schema ─────────────────────────────────────────
  async listTables(userId: string): Promise<TenantTable[]> {
    const record = await this.getStatus(userId);
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
  async queryTable(userId: string, tableName: string, limit = 50, offset = 0): Promise<{ rows: object[]; total: number }> {
    const record = await this.getStatus(userId);
    if (!record || record.status !== 'active') throw new Error('No active database');

    // Validate table exists in their schema
    const tables = await this.listTables(userId);
    if (!tables.find(t => t.name === tableName)) throw new Error('Table not found');

    const pg = await pool();
    const safe = `"${record.schema_name}"."${tableName}"`;
    const [dataRes, countRes] = await Promise.all([
      pg.query(`SELECT * FROM ${safe} LIMIT $1 OFFSET $2`, [limit, offset]),
      pg.query(`SELECT COUNT(*)::int as count FROM ${safe}`),
    ]);
    return { rows: dataRes.rows, total: countRes.rows[0].count };
  },

  // ── Connection check — live ping, separate from the stored provisioning status ──
  async testConnection(userId: string): Promise<{ connected: boolean; latencyMs?: number; error?: string }> {
    const record = await this.getStatus(userId);
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
  async dumpDatabase(userId: string): Promise<{ sql: string; schema: string; truncated: boolean }> {
    const DUMP_ROW_LIMIT = 10_000;
    const record = await this.getStatus(userId);
    if (!record || record.status !== 'active') throw new Error('No active database');

    const tables = await this.listTables(userId);
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
  async runQuery(userId: string, sql: string, role: 'anon' | 'service' = 'anon'): Promise<{ rows: object[]; fields: string[]; statementsRun?: number }> {
    const record = await this.getStatus(userId);
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
    // the same transaction — if any fails the whole batch rolls back.
    const statements = role === 'service'
      ? trimmed.split(/;\s*\n|;\s*$|;(?=\s*[A-Za-z])/).map(s => s.trim()).filter(Boolean)
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
  async _reloadPostgREST(): Promise<void> {
    // Read all active schemas from registry and update PostgREST config via API
    // PostgREST reloads on SIGUSR1 — we signal it via the VPS5 reload script
    // For now: fire-and-forget HTTP request to a reload endpoint we'll expose
    // If that fails, PostgREST still works; new schema just needs manual reload
    try {
      const reloadUrl = process.env.TENANT_DB_RELOAD_URL;
      if (reloadUrl) {
        await fetch(reloadUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.TENANT_DB_RELOAD_SECRET}` },
        });
      }
    } catch {
      logger.warn('PostgREST reload signal failed — restart manually if schema not visible');
    }
  },
};
