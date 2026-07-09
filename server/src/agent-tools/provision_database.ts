/**
 * provision_database tool — auto-provision the project's hosted PostgreSQL database
 * if the user has a paid plan and hasn't provisioned one yet.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService } from '../services/database.service.js';
import { supabase } from '../config/database.js';

const schema = z.object({
  organization_id: z.string().optional().describe(
    "The organization ID to provision the database under. Leave empty to use the user's default organization."
  ),
});

export const provisionDatabaseTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'provision_database',
  description:
    "Provision a hosted PostgreSQL database for the project if one doesn't exist yet. " +
    "Call this when the user asks for persistent data storage and get_database_schema reports no database is provisioned. " +
    "Requires the user to be on a Pro or Agency plan — if they are on a free plan, tell them to upgrade and do NOT call this. " +
    "After provisioning, call get_database_schema to confirm and then proceed with CREATE TABLE statements.",
  inputSchema: schema,
  getConsentPreview: () => 'Provision hosted PostgreSQL database',

  execute: async (args, ctx: AgentContext) => {
    if (!ctx.userId) return 'ERROR: no user context available.';

    // Check if already provisioned
    const existing = await databaseService.getStatus(ctx.userId, ctx.projectId);
    if (existing && existing.status === 'active') {
      return `Database is already provisioned (schema: ${existing.schema_name}). Call get_database_schema to see the current tables.`;
    }

    // Resolve organization_id — use provided or look up the user's org
    let orgId = args.organization_id ?? null;
    if (!orgId) {
      const { data } = await supabase
        .from('org_members')
        .select('organization_id, organizations!inner(plan_tier)')
        .eq('user_id', ctx.userId)
        .not('organizations.plan_tier', 'eq', 'free')
        .limit(1)
        .maybeSingle();
      if (data) orgId = (data as { organization_id: string }).organization_id;
    }

    if (!orgId) {
      return (
        'Cannot provision database: the user is not a member of any paid organization. ' +
        'Tell the user to upgrade to a Pro or Agency plan from Settings → Billing, then try again.'
      );
    }

    try {
      const record = await databaseService.provision(ctx.userId, orgId, ctx.projectId);
      // getCredentials() also upserts VITE_DB_* into project_secrets — call it
      // immediately so secrets exist even if the agent never reaches get_database_schema.
      await databaseService.getCredentials(ctx.userId, ctx.projectId);
      // Surface the billable DB provisioning in the chat (reuses the write_file
      // chip path). Previously this account-level mutation was invisible.
      ctx.onXmlComplete?.(`<ecomgear-write path="database/${record.schema_name}" description="Provisioned hosted PostgreSQL (${record.status})" />`);
      return (
        `Database provisioned successfully!\n` +
        `Schema: ${record.schema_name}\n` +
        `Status: ${record.status}\n\n` +
        `Now call get_database_schema to confirm, then use query_database to create your tables.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already_provisioned')) {
        return 'Database already provisioned. Call get_database_schema to see the current schema.';
      }
      return `ERROR provisioning database: ${msg}`;
    }
  },
};
