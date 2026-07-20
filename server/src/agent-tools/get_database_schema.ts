/**
 * get_database_schema tool   list tables/columns/row counts in the project's
 * hosted PostgreSQL database (see server/src/services/database.service.ts).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';
import { logger } from '../utils/logger.js';

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

    const creds = await databaseService.getCredentials(ctx.userId, ctx.projectId);
    if (!creds) {
      return 'No hosted database is provisioned for this project. Tell the user to provision one from Settings > Hosted Database before you write database-dependent code.';
    }

    let tables: Awaited<ReturnType<typeof databaseService.listTables>>;
    try {
      tables = await databaseService.listTables(ctx.userId, ctx.projectId);
    } catch (err) {
      logger.warn('[get_database_schema] listTables failed', err);
      tables = [];
    }

    const tableLines = tables.length === 0
      ? '(no tables yet   use query_database with CREATE TABLE statements to add some)'
      : tables.map((t) => {
          const cols = t.columns
            .map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`)
            .join(', ');
          return `- ${t.name} (${t.row_count ?? '?'} rows): ${cols}`;
        }).join('\n');

    return [
      `Schema: "${creds.schema}" (this project's isolated schema)`,
      `API_URL: ${creds.api_url} (available as import.meta.env.VITE_DB_API_URL)`,
      `ANON_KEY available as import.meta.env.VITE_DB_ANON_KEY`,
      '',
      'Tables:',
      tableLines,
      '',
      'IMPORTANT   this database has NO row-level security. ANON_KEY is bundled into the public JS bundle and its role has a flat SELECT grant on every table, every row, no per-user scoping. Direct client-side fetches are only safe for genuinely public, world-readable data. For anything user-specific/private, and for ALL writes, use write_edge_function instead   never a direct client fetch.',
      '',
      'If you do use a direct client fetch (public read-only data only):',
      `  • API_URL already includes the schema path segment   use it EXACTLY as given, do not add or modify any path segments before /rest/v1/.`,
      `  • All fetch requests go to: \`\${import.meta.env.VITE_DB_API_URL}/rest/v1/<table>\``,
      `  • Headers (ONLY these   do NOT add Accept-Profile or Content-Profile, the server derives the schema from the URL path automatically):`,
      `    { "Authorization": \`Bearer \${import.meta.env.VITE_DB_ANON_KEY}\`, "apikey": import.meta.env.VITE_DB_ANON_KEY, "Content-Type": "application/json" }`,
      '  • NEVER hardcode the URL, key, or schema as a string literal anywhere in code   not even as a fallback/default value. ALWAYS reference the import.meta.env.VITE_DB_* variable directly.',
      '  • NEVER call /api/auth/* routes   there is no Express backend in the preview; use direct PostgREST calls only',
    ].join('\n');
  },
};
