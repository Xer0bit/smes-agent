/**
 * query_database tool   run SQL against the project's hosted PostgreSQL database
 * with full (service-role) access: DDL for tables/migrations, DML for data.
 * See server/src/services/database.service.ts for the underlying provisioning/query logic.
 *
 * DDL confirmation gate (2026-08 core-loop audit): schema-mutating statements
 * (CREATE/ALTER/DROP/TRUNCATE) used to execute the instant the model called
 * this tool   zero visibility, zero chance to stop a bad migration before it
 * hit the live tenant DB. Plain DML (SELECT/INSERT/UPDATE/DELETE) still runs
 * immediately; DDL is staged into ctx.pendingDbChanges and only actually runs
 * when the model makes a SEPARATE confirm_database_change call with the
 * returned confirmationId. See confirm_database_change.ts.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';

const MAX_CALLS_PER_RUN = 50;

// Matches a DDL keyword at the start of the string or right after a statement
// separator (';'). Deliberately simple (no full SQL parser)   a false positive
// just means an extra confirm round-trip for a DML statement, which is safe;
// a false negative would let schema-mutating SQL slip past the gate, so the
// keyword list is intentionally broad (includes GRANT/REVOKE   they change
// what other roles can touch, same "silent live change" risk as DDL proper).
const DDL_RE = /(^|;)\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\s/i;

export function isSchemaMutatingSql(sql: string): boolean {
  return DDL_RE.test(sql);
}

// Table-name capture for CREATE POLICY   `ON [schema.]table`, quotes optional.
// The policy name itself is commonly a quoted multi-word string (e.g.
// `CREATE POLICY "public read products" ON ...`)   matched as `"[^"]+"` first
// so \S+ (bare/unquoted name) doesn't stop at the first space inside it and
// miss the whole statement.
const CREATE_POLICY_TABLE_RE = /CREATE\s+POLICY\s+(?:"[^"]+"|\S+)\s+ON\s+(?:"?[\w]+"?\.)?"?(\w+)"?/i;
// Only counts as "resolves the anon-fetch gap" when the policy actually grants
// to an anon-shaped or public role   a policy scoped to e.g. `authenticated`
// doesn't help an anon-key fetch, so it shouldn't clear the gate either.
const POLICY_TO_ANON_RE = /\bTO\s+(?:"?[\w]+"?_anon\b|"?anon"?\b|public\b)/i;

/**
 * Extracts table names (lowercased) that got a CREATE POLICY statement
 * targeting an anon/public role within `sql`. Used by confirm_database_change
 * (only once the DDL actually EXECUTED, not merely staged) to populate
 * ctx.anonPolicyTables for the anon-fetch-without-policy closure gate. See
 * AgentContext.anonPolicyTables in types.ts for the full mechanism.
 */
export function extractAnonPolicyTables(sql: string): string[] {
  const tables = new Set<string>();
  for (const stmt of sql.split(';')) {
    if (!/CREATE\s+POLICY/i.test(stmt)) continue;
    const m = CREATE_POLICY_TABLE_RE.exec(stmt);
    if (m && POLICY_TO_ANON_RE.test(stmt)) {
      tables.add(m[1].toLowerCase());
    }
  }
  return [...tables];
}

export function formatQueryResult(result: Awaited<ReturnType<typeof databaseService.runQuery>>): string {
  const stmtNote = result.statementsRun && result.statementsRun > 1
    ? ` (${result.statementsRun} statements executed)`
    : '';
  if (result.rows.length === 0) {
    const colNote = result.fields.length ? ` Columns: ${result.fields.join(', ')}.` : '';
    return `Query executed successfully${stmtNote}.${colNote} No rows returned.`;
  }
  const preview = result.rows.slice(0, 20);
  const moreNote = result.rows.length > 20 ? ' (showing first 20)' : '';
  return `Query returned ${result.rows.length} row(s)${stmtNote}${moreNote}:\n${JSON.stringify(preview, null, 2)}`;
}

export function formatQueryError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('No active database')) {
    return 'No hosted database is provisioned for this project. Tell the user to provision one from Settings → Hosted Database before running queries.';
  }
  return `ERROR running query: ${msg}`;
}

const schema = z.object({
  sql: z.string().describe(
    "One or more SQL statements to run against the project's hosted database. " +
    "Separate multiple statements with semicolons   they all execute in one atomic transaction. " +
    "Supports DDL (CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX) and DML (SELECT, INSERT, UPDATE, DELETE, TRUNCATE)."
  ),
});

export const queryDatabaseTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'query_database',
  description:
    "Run SQL against the project's hosted PostgreSQL database with full service-role access. " +
    "Supports any DDL or DML: create/alter/drop tables, insert/update/delete rows, run multi-statement migrations. " +
    "Multiple statements separated by semicolons execute atomically   if one fails, all roll back. " +
    "Returns the result of the last statement plus how many statements ran. " +
    "ALWAYS call get_database_schema first when you're unsure what tables exist. " +
    "SCHEMA-MUTATING SQL (CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE) is NOT executed immediately: this call " +
    "stages it and returns a confirmationId   you MUST call confirm_database_change with that id as a " +
    "separate tool call before the change actually runs against the live database. Plain data statements " +
    "(SELECT/INSERT/UPDATE/DELETE) run immediately as usual. " +
    "If no database is provisioned, tell the user to provision one from Settings → Hosted Database.",
  inputSchema: schema,
  getConsentPreview: (args) => `Run SQL: ${args.sql.slice(0, 120)}${args.sql.length > 120 ? '…' : ''}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available for database access.';

    ctx.dbQueryCallCount = (ctx.dbQueryCallCount ?? 0) + 1;
    if (ctx.dbQueryCallCount > MAX_CALLS_PER_RUN) {
      return `STOP: query_database has been called ${ctx.dbQueryCallCount} times this run (limit is ${MAX_CALLS_PER_RUN}). Stop and summarize what was done.`;
    }

    if (isSchemaMutatingSql(args.sql)) {
      if (!ctx.pendingDbChanges) ctx.pendingDbChanges = new Map();
      const confirmationId = crypto.randomUUID();
      ctx.pendingDbChanges.set(confirmationId, { sql: args.sql, createdAt: Date.now() });
      return (
        `PENDING CONFIRMATION   this SQL was NOT executed yet. It contains a schema-mutating statement ` +
        `(CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE), which changes the live database for real users, so it ` +
        `requires one extra confirmation step.\n\n` +
        `SQL to run:\n${args.sql}\n\n` +
        `To actually execute it, call confirm_database_change with confirmationId: "${confirmationId}". ` +
        `If you decide NOT to run it (e.g. after reconsidering), simply don't call confirm   nothing happens.`
      );
    }

    try {
      const result = await databaseService.runQuery(ctx.userId, args.sql, 'service', ctx.projectId);
      return formatQueryResult(result);
    } catch (err: unknown) {
      return formatQueryError(err);
    }
  },
};
