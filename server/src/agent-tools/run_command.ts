/**
 * run_command tool — execute safe, allowlisted shell commands in the project workspace.
 * Only npm install / npm uninstall are permitted.
 */
import { exec } from 'node:child_process';
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';

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
    // Never add these flags to uninstall — they don't apply there.
    const isInstall = /^npm\s+(install|i|add)\b/.test(cmd);
    const safeCmd = isInstall
      ? cmd.replace(/^(npm\s+\S+)/, '$1 --ignore-scripts --no-audit --no-fund')
      : cmd;

    return new Promise<string>((resolve) => {
      exec(
        safeCmd,
        {
          cwd: ctx.appPath,
          timeout: 120_000, // 2 min max
          env: { ...process.env, NODE_ENV: 'development' },
        },
        (err, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, 2000);
          if (err) {
            resolve(`Command failed (${cmd}):\n${out}`);
          } else {
            resolve(`Command succeeded (${cmd}):\n${out}`);
          }
        }
      );
    });
  },
};
