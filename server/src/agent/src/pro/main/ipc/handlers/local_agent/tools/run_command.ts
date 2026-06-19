import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types.js";
import { safeJoin } from "@/ipc/utils/path_utils";

const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = [
  "npm",
  "pnpm",
  "bun",
  "npx",
  "supabase",
  "docker",
  "docker-compose",
] as const;

const runCommandSchema = z.object({
  command: z
    .enum(ALLOWED_COMMANDS)
    .describe("The command binary to execute (allowlisted for safety)"),
  args: z
    .array(z.string())
    .optional()
    .describe("Command arguments as an array of tokens"),
  cwd: z
    .string()
    .optional()
    .describe("Optional working directory relative to the app root"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300000)
    .optional()
    .describe("Optional timeout in milliseconds (max 300000)"),
});

const MAX_OUTPUT_CHARS = 12000;

function hasSuspiciousArg(arg: string): boolean {
  return /[\r\n;&|`]|\$\(/.test(arg);
}

function clampOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }
  const omitted = output.length - MAX_OUTPUT_CHARS;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[output truncated: omitted ${omitted} characters]`;
}

export const runCommandTool: ToolDefinition<z.infer<typeof runCommandSchema>> =
  {
    name: "run_command",
    description:
      "Run an allowlisted development command (npm, pnpm, bun, npx, supabase, docker, docker-compose) inside the app workspace.",
    inputSchema: runCommandSchema,
    defaultConsent: "ask",
    modifiesState: true,

    getConsentPreview: (args) =>
      `${args.command} ${(args.args ?? []).join(" ")}`.trim(),

    buildXml: (args, isComplete) => {
      if (!args.command) {
        return undefined;
      }
      const argText = (args.args ?? []).join(" ");
      let xml = `<dyad-status title="Running command: ${escapeXmlAttr(args.command)}">${escapeXmlContent(argText)}</dyad-status>`;
      if (!isComplete) {
        return xml;
      }
      return xml;
    },

    execute: async (args, ctx: AgentContext) => {
      const commandArgs = args.args ?? [];

      for (const arg of commandArgs) {
        if (hasSuspiciousArg(arg)) {
          throw new Error(
            `Rejected argument '${arg}' because it contains shell control characters`,
          );
        }
      }

      const workingDirectory = args.cwd
        ? safeJoin(ctx.appPath, args.cwd)
        : ctx.appPath;

      ctx.onXmlStream(
        `<dyad-status title="Running command: ${escapeXmlAttr(args.command)}">${escapeXmlContent(commandArgs.join(" "))}</dyad-status>`,
      );

      const result = await execFileAsync(args.command, commandArgs, {
        cwd: workingDirectory,
        timeout: args.timeoutMs ?? 120000,
        maxBuffer: 4 * 1024 * 1024,
      });

      const combinedOutput = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      const safeOutput = clampOutput(combinedOutput || "Command completed.");

      ctx.onXmlComplete(
        `<dyad-status title="Command completed: ${escapeXmlAttr(args.command)}">${escapeXmlContent(safeOutput)}</dyad-status>`,
      );

      return safeOutput;
    },
  };