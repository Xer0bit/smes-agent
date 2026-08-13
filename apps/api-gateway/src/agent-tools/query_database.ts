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

// pgcrypto functions this codebase's own generated SQL actually uses. Not the
// extension's full surface -- deliberately scoped to what's been seen live,
// same "broad enough to catch the real class, not a general SQL linter"
// posture as DDL_RE above.
const PGCRYPTO_FUNCTIONS = ['crypt', 'gen_salt', 'gen_random_bytes', 'digest', 'hmac'];

/**
 * Real incident, 2026-08-13: a register_and_login function correctly
 * schema-qualified extensions.crypt/extensions.gen_salt for password hashing,
 * then called a bare gen_random_bytes(32) two lines later for the session
 * token -- pgcrypto isn't on this role's search_path, so the unqualified call
 * failed with "function ... does not exist" at RUNTIME. write_edge_function's
 * AST validation never sees this class of bug (it doesn't execute SQL);
 * neither does this tool's own success/failure path for a CREATE FUNCTION
 * statement, which only fails when the function BODY runs, not when it's
 * defined. Advisory only (a function name match doesn't prove the call is
 * actually unqualified in every syntactic position) -- surfaced at staging
 * time, before confirm_database_change actually runs it, so the model has a
 * chance to catch its own mistake before it reaches the live database.
 */
export function findUnqualifiedPgcryptoCalls(sql: string): string[] {
  const found: string[] = [];
  for (const fn of PGCRYPTO_FUNCTIONS) {
    const re = new RegExp(`(?<!extensions\\.)\\b${fn}\\s*\\(`, 'gi');
    if (re.test(sql)) found.push(fn);
  }
  return found;
}

// Unqualified DELETE/UPDATE (no WHERE clause) previously ran IMMEDIATELY,
// with zero staging -- unlike DDL, which was already gated above. A model
// forgetting a WHERE clause on a DELETE wipes an entire table with no
// confirm step at all, which is at least as dangerous as a DROP TABLE
// (arguably worse: DROP TABLE is at least visually alarming in a diff,
// `DELETE FROM users;` looks routine). Confirmed 2026-08-09 core-loop audit:
// this was the one DML shape structurally as risky as DDL and NOT staged.
// Deliberately simple per-statement check (split on top-level ';', same
// looseness as DDL_RE above) -- a false positive on a DELETE/UPDATE that
// legitimately has no WHERE (rare, e.g. clearing a whole scratch table)
// just costs one extra confirm round-trip, which is safe.
const UNQUALIFIED_MUTATION_RE = /(^|;)\s*(DELETE\s+FROM|UPDATE)\s+[^;]*?(?=;|$)/gi;

export function isUnqualifiedMutation(sql: string): boolean {
  const matches = sql.matchAll(UNQUALIFIED_MUTATION_RE);
  for (const m of matches) {
    if (!/\bWHERE\b/i.test(m[0])) return true;
  }
  return false;
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
    "separate tool call before the change actually runs against the live database. The same staging applies " +
    "to a DELETE or UPDATE with no WHERE clause (affects every row, as risky as a schema change). Plain, " +
    "row-scoped data statements (SELECT/INSERT, or UPDATE/DELETE with a WHERE clause) run immediately as usual. " +
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
      const unqualified = findUnqualifiedPgcryptoCalls(args.sql);
      const pgcryptoWarning = unqualified.length > 0
        ? `\n\n⚠ POSSIBLE BUG: this SQL calls pgcrypto function(s) ${unqualified.map(f => `"${f}"`).join(', ')} without the ` +
          `"extensions." prefix. pgcrypto is installed in the extensions schema, which is NOT on this role's search_path -- ` +
          `an unqualified call fails at RUNTIME with "function ... does not exist" (this exact bug broke registration in ` +
          `production for hours on 2026-08-13). Before confirming, check every pgcrypto call in this statement is written ` +
          `as extensions.${unqualified[0]}(...), not bare ${unqualified[0]}(...).`
        : '';
      return (
        `PENDING CONFIRMATION   this SQL was NOT executed yet. It contains a schema-mutating statement ` +
        `(CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE), which changes the live database for real users, so it ` +
        `requires one extra confirmation step.${pgcryptoWarning}\n\n` +
        `SQL to run:\n${args.sql}\n\n` +
        `To actually execute it, call confirm_database_change with confirmationId: "${confirmationId}". ` +
        `If you decide NOT to run it (e.g. after reconsidering), simply don't call confirm   nothing happens.`
      );
    }

    if (isUnqualifiedMutation(args.sql)) {
      if (!ctx.pendingDbChanges) ctx.pendingDbChanges = new Map();
      const confirmationId = crypto.randomUUID();
      ctx.pendingDbChanges.set(confirmationId, { sql: args.sql, createdAt: Date.now() });
      return (
        `PENDING CONFIRMATION   this SQL was NOT executed yet. It contains a DELETE or UPDATE with no WHERE ` +
        `clause, which would affect every row in the table -- this is at least as risky as a schema change, so it ` +
        `requires the same one extra confirmation step. If this was intentional (e.g. clearing a scratch table), ` +
        `just confirm it. If you meant to target specific rows, add a WHERE clause and call query_database again instead.\n\n` +
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
