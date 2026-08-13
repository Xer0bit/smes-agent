/**
 * test_database_function tool -- runtime verification for a SQL function the
 * agent just created via query_database/confirm_database_change.
 *
 * 2026-08-13 stability review: write_edge_function's AST validation and
 * query_database's DDL confirmation gate both check that SQL is WELL-FORMED
 * -- neither ever EXECUTES it. PL/pgSQL does not resolve function/table/
 * column references inside a function body at CREATE time; a call to an
 * undefined function (e.g. an unqualified pgcrypto call) compiles cleanly and
 * only fails the first time something actually invokes it. Real incident: a
 * register_and_login function passed every static check and broke
 * registration in production for hours before anyone actually called it.
 *
 * This tool closes that gap. It runs the function for real, inside a
 * transaction that ALWAYS rolls back (success or failure) -- so even a
 * function that inserts/updates/deletes rows can be tested with zero lasting
 * effect on the database.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';

const schema = z.object({
  functionName: z.string().describe('Name of the SQL function to test-call (must already exist -- create it via query_database/confirm_database_change first).'),
  args: z.record(z.string(), z.any()).describe(
    'Test arguments, keyed by the function\'s own parameter names (e.g. {"p_email": "test@example.com", "p_password": "test123"}). ' +
    'Use realistic-looking dummy values -- the goal is to exercise the function\'s real logic (including any table it reads/writes), not just check it parses.',
  ),
});

export const testDatabaseFunctionTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'test_database_function',
  description:
    'Test-call a SQL function you just created, inside a transaction that is ALWAYS rolled back afterward -- so this is safe to call even for ' +
    'functions that insert/update/delete rows (a test registration, a test session, etc. never actually lands). Use this after CREATE OR REPLACE ' +
    'FUNCTION for anything with real logic (not a trivial one-liner): it catches runtime errors -- an unqualified pgcrypto call, a typo\'d column ' +
    'name, a table that does not exist -- that CREATE FUNCTION itself does not check, because PL/pgSQL does not validate a function body\'s ' +
    'references until something actually calls it. Do NOT skip this and just assume a function works because it was created without error.',
  inputSchema: schema,
  modifiesState: false,
  getConsentPreview: (args) => `Test-call ${args.functionName}(...) (rolled back, no lasting effect)`,

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available for database access.';

    try {
      const result = await databaseService.testDatabaseFunction(ctx.userId, args.functionName, args.args, ctx.projectId);
      if (result.ok) {
        const preview = result.rows.slice(0, 5);
        return (
          `PASSED (rolled back, no lasting effect): "${args.functionName}" ran successfully with the given test args.\n` +
          `Result: ${JSON.stringify(preview, null, 2)}`
        );
      }
      return (
        `FAILED: "${args.functionName}" raised a real error when called with the given test args:\n\n"${result.error}"\n\n` +
        `The function was NOT actually left changed by this test (rolled back regardless of outcome) -- fix the function body ` +
        `(read it back with query_database if needed) and re-run test_database_function once you've corrected it.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No active database')) {
        return 'No hosted database is provisioned for this project. Provision one before testing functions.';
      }
      if (msg.includes('Invalid function name') || msg.includes('Invalid argument name')) {
        return `ERROR: ${msg}`;
      }
      return `ERROR: ${msg}`;
    }
  },
};
