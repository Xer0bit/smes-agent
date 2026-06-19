/**
 * get_database_schema tool — list tables/columns/row counts in the project's
 * hosted PostgreSQL database (see server/src/services/database.service.ts).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';

const schema = z.object({});

export const getDatabaseSchemaTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'get_database_schema',
  description:
    "List all tables, columns, and row counts in the project's hosted PostgreSQL database (if one is provisioned). " +
    'Call this BEFORE writing any code that reads or writes the database, so you work against the real schema instead of guessing. ' +
    'If no database is provisioned, tells you to direct the user to Settings > Hosted Database.',
  inputSchema: schema,
  getConsentPreview: () => 'Read database schema',

  execute: async (_args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available for database access.';

    const status = await databaseService.getStatus(ctx.userId);
    if (!status || status.status !== 'active') {
      return 'No hosted database is provisioned for this project. Tell the user to provision one from Settings > Hosted Database before you write database-dependent code.';
    }

    const tables = await databaseService.listTables(ctx.userId);
    if (tables.length === 0) {
      return `Database schema "${status.schema_name}" exists but has no tables yet. Use query_database with CREATE TABLE statements to add some.`;
    }

    const lines = tables.map((t) => {
      const cols = t.columns
        .map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`)
        .join(', ');
      return `- ${t.name} (${t.row_count ?? '?'} rows): ${cols}`;
    });

    return `Schema "${status.schema_name}":\n${lines.join('\n')}`;
  },
};
