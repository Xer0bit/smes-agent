/**
 * publish_site tool — rebuild and redeploy the project's live site, from
 * inside an agent run.
 *
 * Reuses the same production deploy flow the editor's "Publish" button and
 * the SEO/header-integrations sync endpoints already call
 * (server/src/services/hostingDeploy.service.ts): export a fresh Vite build
 * from preview-service, push it to hosting-service. The project must already
 * have been published once (has a subdomain) — this redeploys, it doesn't
 * do first-time domain setup.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { deployProjectToProduction } from '../services/hostingDeploy.service.js';

const schema = z.object({});

export const publishSiteTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'publish_site',
  description:
    'Rebuild and redeploy the project\'s live published site with the current code. ' +
    'Only call this when the user explicitly asks to publish/deploy/ship/go live — never automatically after a fix. ' +
    'Requires the project to already be published once (has a subdomain via the editor\'s Publish button); if not, tell the user to publish it there first.',
  inputSchema: schema,
  getConsentPreview: () => 'Rebuild and redeploy the live site',

  execute: async (_args, ctx: AgentContext) => {
    const result = await deployProjectToProduction(ctx.projectId);
    if (!result.productionDeployed) return `Publish failed: ${result.deployError}`;
    return `Site rebuilt and deployed.${result.hostingUrl ? ` Live at ${result.hostingUrl}` : ''}`;
  },
};
