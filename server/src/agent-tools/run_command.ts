/**
 * run_command tool   execute safe, allowlisted shell commands in the project workspace.
 * Only npm install / npm uninstall are permitted.
 */
import { exec } from 'node:child_process';
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';

/**
 * Parse package names out of an npm install command.
 * e.g. "npm install chart.js lodash@4" → ["chart.js", "lodash@4"]
 */
function parsePackageNames(cmd: string): string[] {
  // Strip "npm install/i/add" prefix and any flags (starting with -)
  const withoutCmd = cmd.replace(/^npm\s+\S+/, '').trim();
  return withoutCmd
    .split(/\s+/)
    .filter(t => t && !t.startsWith('-'));
}

/**
 * Notify the preview service to install the same packages into its own
 * node_modules so Vite can resolve them. Fire-and-forget with a timeout  
 * a failure here is non-fatal; the local install already succeeded.
 */
async function syncPackagesToPreviewService(
  packages: string[],
  previewServiceUrl: string,
  projectId: string,
): Promise<void> {
  if (!packages.length) return;
  const url = `${previewServiceUrl}/packages/install`;
  const secret = process.env.PREVIEW_UPDATE_SECRET || '';
  try {
    const res = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-update-secret': secret } : {}),
        },
        body: JSON.stringify({ packages, projectId }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('preview-service install timeout')), 90_000)
      ),
    ]);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[run_command] Preview-service install failed (${res.status}): ${body}`);
    }
  } catch (e: unknown) {
    console.warn(`[run_command] Preview-service install error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const ALLOWED_PREFIXES = [
  'npm install ',
  'npm i ',
  'npm uninstall ',
  'npm remove ',
  'npm add ',
];

const schema = z.object({
  command: z
    .string()
    .describe(
      'The npm command to run, e.g. "npm install recharts" or "npm install lodash date-fns". Only npm install/uninstall is allowed.'
    ),
});

export const runCommandTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'run_command',
  description:
    'Run an npm install or uninstall command inside the project directory. ' +
    'Use this whenever you need to add or remove a package dependency. ' +
    'Example: run_command({ command: "npm install recharts" }). ' +
    'Only npm install/uninstall commands are permitted.',
  inputSchema: schema,
  modifiesState: true,

  execute: async (args, ctx: AgentContext) => {
    const cmd = args.command.trim();

    const isAllowed = ALLOWED_PREFIXES.some((prefix) =>
      cmd.toLowerCase().startsWith(prefix)
    );

    if (!isAllowed) {
      return `Error: Only npm install/uninstall commands are allowed. Received: "${cmd}"`;
    }

    // Extra safety: block shell metacharacters
    if (/[;&|`$(){}[\]<>\\]/.test(cmd)) {
      return `Error: Command contains disallowed characters: "${cmd}"`;
    }

    // Harden install commands: disable postinstall hooks (arbitrary code execution),
    // skip audit (network call, slow), skip fund messages (noise in output).
    // Never add these flags to uninstall   they don't apply there.
    const isInstall = /^npm\s+(install|i|add)\b/.test(cmd);
    const safeCmd = isInstall
      ? cmd.replace(/^(npm\s+\S+)/, '$1 --ignore-scripts --no-audit --no-fund')
      : cmd;

    const runCmd = (cmdToRun: string): Promise<{ ok: boolean; out: string }> =>
      new Promise((resolve) => {
        exec(
          cmdToRun,
          { cwd: ctx.appPath, timeout: 120_000, env: { ...process.env, NODE_ENV: 'development' } },
          (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, 1500);
            resolve({ ok: !err, out });
          }
        );
      });

    let { ok, out } = await runCmd(safeCmd);

    // Auto-retry with --legacy-peer-deps on peer dependency conflicts (ERESOLVE)
    if (!ok && isInstall && out.includes('ERESOLVE')) {
      const legacyCmd = safeCmd.replace(/^(npm\s+\S+)/, '$1 --legacy-peer-deps');
      const retry = await runCmd(legacyCmd);
      if (retry.ok) {
        ok = true;
        out = retry.out;
      } else {
        out = `Peer dep conflict. Tried --legacy-peer-deps too.\n${retry.out.slice(0, 800)}`;
      }
    }

    if (!ok) return `Command failed (${cmd}):\n${out}`;

    // Local install succeeded   sync packages to preview service + surface to UI
    if (isInstall) {
      const pkgs = parsePackageNames(cmd);
      const previewUrl = ctx.previewServiceUrl || 'http://localhost:3001';
      await syncPackagesToPreviewService(pkgs, previewUrl, ctx.projectId);
      // Surface the install in the chat as an activity chip/steps entry.
      // The frontend already parses <ecomgear-add-dependency packages="…">
      // (agentChatHelpers.parseToolActivities)   previously dead because no tool
      // emitted it. Emits AFTER success so a failed install shows no chip.
      if (pkgs.length > 0) {
        ctx.onXmlComplete?.(`<ecomgear-add-dependency packages="${pkgs.join(', ')}" />`);
      }
    }

    return `Command succeeded (${cmd}):\n${out}`;
  },
};
