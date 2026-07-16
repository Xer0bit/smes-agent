/**
 * push_to_github tool — commit the project's current files to its linked
 * GitHub repo, from inside an agent run.
 *
 * Reuses the exact push logic the "Commit to GitHub" button in Settings
 * calls (server/src/routes/github.routes.ts) — same one-commit blob/tree/ref
 * flow, just triggered by the agent instead of a human clicking a button.
 * Requires the user to have already connected GitHub and linked a repo;
 * this tool does not create either (existing settings UI does that).
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { collectWorkspaceFiles } from './search_codebase.js';
import { pushFilesToGithub } from '../routes/github.routes.js';

const schema = z.object({});

export const pushToGithubTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'push_to_github',
  description:
    'Commit the project\'s current files to its linked GitHub repository as a single commit. ' +
    'Only call this when the user explicitly asks to push/commit/sync to GitHub — never automatically after a fix. ' +
    'Requires a GitHub account already connected and a repo already linked in Settings; if not, tell the user to do that first.',
  inputSchema: schema,
  getConsentPreview: () => 'Push current project files to the linked GitHub repo',

  execute: async (_args, ctx: AgentContext) => {
    if (!ctx.userId) return 'Cannot push: no authenticated user on this run.';

    const files = collectWorkspaceFiles(ctx.appPath);
    if (files.length === 0) return 'No files found in project — nothing to push.';

    const result = await pushFilesToGithub(ctx.userId, ctx.projectId, files);
    if (!result.success) return `Push failed: ${result.error}`;
    return `Pushed ${result.filesPushed} files to GitHub. Commit: ${result.commitUrl}`;
  },
};
