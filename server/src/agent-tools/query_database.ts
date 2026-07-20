/**
 * query_database tool   run SQL against the project's hosted PostgreSQL database
 * with full (service-role) access: DDL for tables/migrations, DML for data.
 * See server/src/services/database.service.ts for the underlying provisioning/query logic.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';

const MAX_CALLS_PER_RUN = 50;

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
    "If no database is provisioned, tell the user to provision one from Settings → Hosted Database.",
  inputSchema: schema,
  getConsentPreview: (args) => `Run SQL: ${args.sql.slice(0, 120)}${args.sql.length > 120 ? '…' : ''}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available for database access.';

    ctx.dbQueryCallCount = (ctx.dbQueryCallCount ?? 0) + 1;
    if (ctx.dbQueryCallCount > MAX_CALLS_PER_RUN) {
      return `STOP: query_database has been called ${ctx.dbQueryCallCount} times this run (limit is ${MAX_CALLS_PER_RUN}). Stop and summarize what was done.`;
    }

    try {
      const result = await databaseService.runQuery(ctx.userId, args.sql, 'service', ctx.projectId);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No active database')) {
        return 'No hosted database is provisioned for this project. Tell the user to provision one from Settings → Hosted Database before running queries.';
      }
      return `ERROR running query: ${msg}`;
    }
  },
};
