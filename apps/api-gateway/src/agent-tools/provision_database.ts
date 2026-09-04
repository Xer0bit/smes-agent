/**
 * provision_database tool   auto-provision the project's hosted PostgreSQL database
 * if the user has a paid plan and hasn't provisioned one yet.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { databaseService, buildProjectEnvSecrets } from '../services/database.service.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

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
    "Requires the user to be on a Pro or Agency plan   if they are on a free plan, tell them to upgrade and do NOT call this. " +
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

    // Resolve organization_id   use provided or look up the user's org
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
      // getCredentials() also upserts VITE_DB_* into project_secrets   call it
      // immediately so secrets exist even if the agent never reaches get_database_schema.
      await databaseService.getCredentials(ctx.userId, ctx.projectId);

      // ── CRITICAL: push the new secrets to the LIVE preview so the app can
      // use them immediately. Without this, import.meta.env.VITE_DB_API_URL
      // stays undefined in the running app ("Database API URL is not
      // configured") even though the row exists in project_secrets. The
      // frontend "Sync" button does the same thing   we replicate it here so
      // one-click provisioning from the agent actually works end-to-end.
      try {
        const secrets = await buildProjectEnvSecrets(ctx.userId, ctx.projectId);
        const previewBase = (process.env.PREVIEW_SERVICE_URL || ctx.previewServiceUrl || 'http://localhost:3001').replace(/\/$/, '');
        await fetch(`${previewBase}/preview/${ctx.projectId}/secrets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
          },
          body: JSON.stringify({ secrets }),
        });
      } catch (syncErr) {
        logger.warn('[provision_database] preview secret sync failed (DB is still provisioned)', syncErr);
      }

      // Surface the billable DB provisioning in the chat (reuses the write_file
      // chip path). This tag is deliberately self-closing and NOT parsed by
      // agentXmlParser.ts's <SMEsAgent-write> regex (which requires a literal
      // </SMEsAgent-write> and would push the placeholder text through as a
      // real file write) -- "database/${record.schema_name}" isn't a project
      // file, so a matching open/close tag would inject a bogus file into the
      // live project tree. This call is chat-display-only (sink.emit in
      // agentLoopService.ts's onXmlComplete streams the raw XML to the
      // frontend regardless of whether the strict parser matches it).
      // agentWroteFiles/ghostRun tracking goes through nonFileMutation below
      // instead, which was the actual gap here.
      ctx.onXmlComplete?.(`<SMEsAgent-write path="database/${record.schema_name}" description="Provisioned hosted PostgreSQL (${record.status})" />`);
      // See AgentContext.nonFileMutation's doc comment (agent-tools/types.ts):
      // a real, billable mutation with no project file to track it by. Without
      // this, a turn whose only action was provisioning a database left
      // agentWroteFiles false -- no preview-sync push, and the run got flagged
      // ghostRun despite the provisioning having genuinely happened.
      ctx.nonFileMutation = true;
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
