/**
 * confirm_database_change tool   executes a schema-mutating SQL statement
 * previously staged by query_database. Second half of the DDL confirmation
 * gate (2026-08 core-loop audit)   see query_database.ts for why this exists.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';
import { formatQueryResult, formatQueryError, extractAnonPolicyTables } from './query_database.js';

const schema = z.object({
  confirmationId: z.string().describe(
    'The confirmationId returned by a prior query_database call whose SQL contained a ' +
    'schema-mutating statement (CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE).'
  ),
});

export const confirmDatabaseChangeTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'confirm_database_change',
  description:
    'Execute a schema-mutating SQL statement that query_database staged (it returns a ' +
    'PENDING CONFIRMATION message with a confirmationId when the SQL contains CREATE/ALTER/DROP/' +
    'TRUNCATE/GRANT/REVOKE). Call this ONLY after you have shown the SQL to the user or are otherwise ' +
    'confident it should run   this actually changes the live database. Each confirmationId can be used once.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Confirm and execute pending database change ${args.confirmationId}`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available for database access.';

    const pending = ctx.pendingDbChanges?.get(args.confirmationId);
    if (!pending) {
      return (
        `ERROR: no pending database change found for confirmationId "${args.confirmationId}". ` +
        `Either it was already confirmed, it expired with this run, or it was never staged   ` +
        `call query_database with the schema-mutating SQL first.`
      );
    }
    // One-shot: remove before executing so a retried/duplicated confirm call
    // can't replay the same DDL twice.
    ctx.pendingDbChanges!.delete(args.confirmationId);

    try {
      const result = await databaseService.runQuery(ctx.userId, pending.sql, 'service', ctx.projectId);
      // Anon-fetch-without-policy gate: only count a policy as "granted" once
      // its DDL has actually executed, not merely staged   see types.ts
      // AgentContext.anonPolicyTables for the full mechanism.
      const policyTables = extractAnonPolicyTables(pending.sql);
      if (policyTables.length > 0) {
        if (!ctx.anonPolicyTables) ctx.anonPolicyTables = new Set();
        for (const t of policyTables) ctx.anonPolicyTables.add(t);
      }
      return `Confirmed and executed. ${formatQueryResult(result)}`;
    } catch (err: unknown) {
      return formatQueryError(err);
    }
  },
};
