import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types.js";
import { safeJoin } from "@/ipc/utils/path_utils";
import {
  parseEnvFile,
  serializeEnvFile,
} from "@/ipc/utils/app_env_var_utils";

const setupEnvironmentSchema = z.object({
  envFilePath: z
    .string()
    .optional()
    .describe("Target env file path relative to app root (default: .env.local)"),
  templateFilePath: z
    .string()
    .optional()
    .describe("Optional template env file path (default: .env.example)"),
  values: z
    .record(z.string(), z.string())
    .optional()
    .describe("Key-value overrides to write into the env file"),
  requiredKeys: z
    .array(z.string())
    .optional()
    .describe("Keys that must exist after setup"),
  preserveExisting: z
    .boolean()
    .optional()
    .describe("If true, keep existing env values when present (default: true)"),
  createPlaceholdersForMissingRequired: z
    .boolean()
    .optional()
    .describe("If true, create empty placeholders for missing required keys"),
});

function buildOrderedEnvMap(
  existing: Array<{ key: string; value: string }>,
  template: Array<{ key: string; value: string }>,
  preserveExisting: boolean,
): Map<string, string> {
  const map = new Map<string, string>();

  if (preserveExisting) {
    for (const envVar of existing) {
      map.set(envVar.key, envVar.value);
    }
  }

  for (const envVar of template) {
    if (!map.has(envVar.key)) {
      map.set(envVar.key, envVar.value);
    }
  }

  if (!preserveExisting) {
    for (const envVar of existing) {
      if (!map.has(envVar.key)) {
        map.set(envVar.key, envVar.value);
      }
    }
  }

  return map;
}

export const setupEnvironmentTool: ToolDefinition<
  z.infer<typeof setupEnvironmentSchema>
> = {
  name: "setup_environment",
  description:
    "Create or update an env file from template defaults, required keys, and provided values.",
  inputSchema: setupEnvironmentSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Setup ${args.envFilePath ?? ".env.local"} using ${args.templateFilePath ?? ".env.example"}`,

  buildXml: (args) => {
    const target = args.envFilePath ?? ".env.local";
    return `<dyad-status title="Setting up environment file">${escapeXmlContent(target)}</dyad-status>`;
  },

  execute: async (args, ctx: AgentContext) => {
    const envFilePath = args.envFilePath ?? ".env.local";
    const templateFilePath = args.templateFilePath ?? ".env.example";
    const preserveExisting = args.preserveExisting ?? true;
    const createPlaceholders = args.createPlaceholdersForMissingRequired ?? true;

    const envFileFullPath = safeJoin(ctx.appPath, envFilePath);
    const templateFullPath = safeJoin(ctx.appPath, templateFilePath);

    const existingEntries = fs.existsSync(envFileFullPath)
      ? parseEnvFile(fs.readFileSync(envFileFullPath, "utf8"))
      : [];

    const templateEntries = fs.existsSync(templateFullPath)
      ? parseEnvFile(fs.readFileSync(templateFullPath, "utf8"))
      : [];

    const envMap = buildOrderedEnvMap(
      existingEntries,
      templateEntries,
      preserveExisting,
    );

    for (const [key, value] of Object.entries(args.values ?? {})) {
      envMap.set(key, value);
    }

    const requiredKeys = args.requiredKeys ?? [];
    const missingRequiredKeys: string[] = [];

    for (const key of requiredKeys) {
      const existingValue = envMap.get(key);
      if (existingValue === undefined || existingValue === "") {
        missingRequiredKeys.push(key);
        if (createPlaceholders && !envMap.has(key)) {
          envMap.set(key, "");
        }
      }
    }

    const serialized = serializeEnvFile(
      Array.from(envMap.entries()).map(([key, value]) => ({ key, value })),
    );

    fs.mkdirSync(path.dirname(envFileFullPath), { recursive: true });
    fs.writeFileSync(envFileFullPath, serialized, "utf8");

    const summaryLines = [
      `Wrote ${envFilePath} with ${envMap.size} variable(s).`,
      `Template source: ${fs.existsSync(templateFullPath) ? templateFilePath : "not found (skipped)"}.`,
    ];

    if (missingRequiredKeys.length > 0) {
      summaryLines.push(
        `Missing required values (placeholders added if enabled): ${missingRequiredKeys.join(", ")}`,
      );
    }

    const summary = summaryLines.join("\n");

    ctx.onXmlComplete(
      `<dyad-status title="Environment setup complete">${escapeXmlContent(summary)}</dyad-status>`,
    );

    return summary;
  },
};