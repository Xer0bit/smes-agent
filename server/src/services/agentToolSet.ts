import { ToolSet, jsonSchema } from 'ai';
import fs from 'node:fs';
import type { AgentContext } from '../agent-tools/types.js';
import { safeJoin } from '../agent-tools/types.js';
import { writeFileTool } from '../agent-tools/write_file.js';
import { placeAssetTool } from '../agent-tools/place_asset.js';
import { readFileTool } from '../agent-tools/read_file.js';
import { readFilesTool } from '../agent-tools/read_files.js';
import { listFilesTool } from '../agent-tools/list_files.js';
import { deleteFileTool } from '../agent-tools/delete_file.js';
import { renameFileTool } from '../agent-tools/rename_file.js';
import { grepTool } from '../agent-tools/grep.js';
import { globFilesTool } from '../agent-tools/glob_files.js';
import { searchCodebaseTool } from '../agent-tools/search_codebase.js';
import { findSymbolUsagesTool } from '../agent-tools/find_symbol_usages.js';
import { editFileTool } from '../agent-tools/edit_file.js';
import { getBuildErrorsTool } from '../agent-tools/get_build_errors.js';
import { runCommandTool } from '../agent-tools/run_command.js';
import { thinkTool } from '../agent-tools/think.js';
import { getDatabaseSchemaTool } from '../agent-tools/get_database_schema.js';
import { queryDatabaseTool } from '../agent-tools/query_database.js';
import { provisionDatabaseTool } from '../agent-tools/provision_database.js';
import { writeEdgeFunctionTool } from '../agent-tools/write_edge_function.js';
import { deleteEdgeFunctionTool } from '../agent-tools/delete_edge_function.js';
import { setSecretTool } from '../agent-tools/set_secret.js';
import { listSecretsTool } from '../agent-tools/list_secrets.js';
import { searchOrgKnowledgeTool } from '../agent-tools/search_org_knowledge.js';
import { pushToGithubTool } from '../agent-tools/push_to_github.js';
import { publishSiteTool } from '../agent-tools/publish_site.js';
import { checkTsSyntaxInLoop } from './agentContextCompaction.js';

// Tools irrelevant to a single-file, single-property "micro" change (color/text/
// one-line fixes   see MICRO_SYSTEM_PROMPT). Every tool schema sent costs real
// input tokens on EVERY step regardless of whether it's ever called   sending the
// full ~20-tool backend/infra set (query_database, write_edge_function, etc.) for
// a text tweak is pure fixed overhead. Micro tier's own prompt already scopes the
// task this narrowly; scoping the tool list to match is the same idea applied to
// the request payload, not just the instructions.
const MICRO_EXCLUDED_TOOLS = new Set([
  'run_command', 'get_database_schema', 'query_database', 'provision_database',
  'write_edge_function', 'delete_edge_function', 'set_secret', 'list_secrets',
  'push_to_github', 'publish_site',
]);

export function buildToolSet(ctx: AgentContext, brainMemory: string[], tier?: string): ToolSet {
  const defs = [
    thinkTool,
    getBuildErrorsTool,
    writeFileTool,
    readFileTool,
    readFilesTool,
    listFilesTool,
    deleteFileTool,
    renameFileTool,
    placeAssetTool,
    grepTool,
    globFilesTool,
    searchCodebaseTool,
    findSymbolUsagesTool,
    editFileTool,
    runCommandTool, // npm install/uninstall only   whitelist enforced inside the tool
    getDatabaseSchemaTool,
    queryDatabaseTool,
    provisionDatabaseTool,
    writeEdgeFunctionTool,
    deleteEdgeFunctionTool,
    setSecretTool,
    listSecretsTool,
    pushToGithubTool,
    publishSiteTool,
    ...(ctx.ecgMcp ? [searchOrgKnowledgeTool] : []),
  ].filter((def) => tier !== 'micro' || !MICRO_EXCLUDED_TOOLS.has(def.name));

  const toolSet: ToolSet = {};
  for (const def of defs) {
    toolSet[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (args: any) => {
        // ── Read-before-write guard ──────────────────────────────────────────
        // Copilot-style discipline: the agent must read an existing file before
        // overwriting it. This prevents clobbering unread content and forces the
        // model to work with the true current state of each file.
        if ((def.name === 'write_file' || def.name === 'edit_file') && typeof args.path === 'string') {
          const relPath = args.path;
          if (ctx.readFiles && !ctx.readFiles.has(relPath)) {
            try {
              const fullPath = safeJoin(ctx.appPath, relPath);
              if (fs.existsSync(fullPath)) {
                return (
                  `BLOCKED: You haven't read "${relPath}" yet in this run. ` +
                  `Call read_file("${relPath}") first to get the current content, then proceed with your edit. ` +
                  `This prevents accidental overwrites of unread code.`
                );
              }
            } catch { /* path traversal   let the tool itself reject it */ }
          }

          // ── Prefer-edit guard ────────────────────────────────────────────────
          // If the agent tries to write_file on a file it already read and the file
          // has more than 40 lines, redirect it to edit_file unless this is truly
          // a full structural rebuild. Prevents the "rewrite the whole file to change
          // two lines" pattern that silently deletes untouched code.
          if (def.name === 'write_file' && ctx.readFiles?.has(relPath)) {
            try {
              const fullPath = safeJoin(ctx.appPath, relPath);
              if (fs.existsSync(fullPath)) {
                const existing = fs.readFileSync(fullPath, 'utf8');
                const lineCount = existing.split('\n').length;
                if (lineCount > 40) {
                  return (
                    `PREFER EDIT: "${relPath}" exists with ${lineCount} lines. ` +
                    `Use edit_file with SEARCH/REPLACE blocks to change only the lines that need updating   ` +
                    `do NOT rewrite the whole file. This prevents accidentally deleting untouched code. ` +
                    `Only call write_file on this file again if you are completely rebuilding its structure from scratch.`
                  );
                }
              }
            } catch { /* ignore   let write_file handle path errors */ }
          }
        }
        // ── Pre-write TSX/JSX sanity check ─────────────────────────────────────
        // Catches the most common agent mistake: writing return() / JSX at module
        // scope with no function wrapper, which crashes React rendering.
        if (def.name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
          const ext = args.path.split('.').pop()?.toLowerCase() ?? '';
          if (ext === 'tsx' || ext === 'jsx') {
            const content: string = args.content;
            const hasExportDefault = /export\s+default\s+(function|const|class|memo|forwardRef)/m.test(content);
            // Detect return( or return ( at column 0   classic module-scope return
            const moduleReturn = /^return\s*[\n(]/m.test(content);
            if (moduleReturn && !hasExportDefault) {
              return (
                `BLOCKED: "${args.path}" has a return() statement at module scope with no export default function. ` +
                `A React component MUST be wrapped in a function: \`export default function ComponentName() { return ( ... ); }\`. ` +
                `Rewrite the file with a proper function wrapper before calling write_file again.`
              );
            }
          }
        }
        // ── Platform-URL guard ─────────────────────────────────────────────────
        // EcomGear infrastructure URLs (api/gen.ecomgear.dev, db/cloud/preview/
        // apps.ecomgear.app) must never be hardcoded into generated project code  
        // they belong in env vars (VITE_SUPABASE_URL, VITE_DB_API_URL,
        // VITE_FUNCTIONS_API_URL). The prompt says so, but models still write
        // fallbacks like `import.meta.env.X || 'https://api.ecomgear.dev'`; this
        // blocks them at the tool layer. edit_file only scans REPLACE sides so
        // removing an already-hardcoded URL stays possible.
        if ((def.name === 'write_file' || def.name === 'edit_file') && typeof args.path === 'string' && /\.(tsx?|jsx?)$/.test(args.path)) {
          const newContent = def.name === 'write_file'
            ? (typeof args.content === 'string' ? args.content : '')
            : (typeof args.diff === 'string' ? args.diff.replace(/<<<<<<< SEARCH[\s\S]*?=======/g, '') : '');
          const urlMatch = newContent.match(/https?:\/\/(?:[a-z0-9-]+\.)*ecomgear\.(?:dev|app|ai)\b/i);
          if (urlMatch) {
            return (
              `BLOCKED: "${args.path}" contains a hardcoded EcomGear platform URL (${urlMatch[0]}). ` +
              `Platform/system URLs must NEVER be written into project code   not even as env-var fallbacks. ` +
              `Use the env var directly with NO fallback: import.meta.env.VITE_SUPABASE_URL for auth, ` +
              `import.meta.env.VITE_DB_API_URL for the hosted database, import.meta.env.VITE_FUNCTIONS_API_URL for edge functions. ` +
              `If the env var you need is not in the project's environment variables, that integration is not provisioned   ` +
              `tell the user instead of inventing a URL.`
            );
          }
          // ANY fallback chained to these three critical connection URLs is wrong,
          // not just a literal EcomGear domain   `window.location.origin`,
          // `location.origin`, `'localhost'`, empty-string, etc. are all just as
          // broken (createClient(window.location.origin, ...) silently points auth
          // at the wrong host instead of failing loudly). Seen in the wild: an
          // agent "fixed" a missing-env-var crash by falling back to
          // window.location.origin   that masks the real bug (the secret was never
          // synced) behind a subtler one (auth silently talks to the wrong origin).
          const criticalEnvFallback = newContent.match(
            /import\.meta\.env\.(VITE_SUPABASE_URL|VITE_DB_API_URL|VITE_FUNCTIONS_API_URL)\s*(\?\?|\|\|)/
          );
          if (criticalEnvFallback) {
            return (
              `BLOCKED: "${args.path}" adds a fallback after \`import.meta.env.${criticalEnvFallback[1]}\` ` +
              `(via \`${criticalEnvFallback[2]}\`). This env var must NEVER have a fallback of any kind   not a ` +
              `platform URL, not \`window.location.origin\`, not \`'localhost'\`, nothing. If it's missing, the ` +
              `integration isn't set up for this project; the correct fix is to tell the user to sync/provision it ` +
              `in Settings, NOT to silently substitute a different value that will point the app at the wrong place. ` +
              `Read the value directly with no fallback, and let it fail loudly (or show a clear "not configured" ` +
              `message) if missing.`
            );
          }
        }

        try {
          const result = await def.execute(args, ctx);
          // ── Track successful reads ─────────────────────────────────────────
          // Mark file as read so subsequent write_file/edit_file calls are allowed.
          if (def.name === 'read_file' && typeof args.path === 'string' && ctx.readFiles) {
            ctx.readFiles.add(args.path);
          }
          // ── In-loop TS syntax feedback ───────────────────────────────────────
          // Check the file the model JUST wrote/edited, with hot context still
          // in the conversation. Cheaper and more reliable than the cold post-run
          // repair pass, which re-reads context from scratch after the run ends.
          // Only fires on success (an ERROR: result already told the model what's wrong).
          if (
            (def.name === 'write_file' || def.name === 'edit_file') &&
            typeof args.path === 'string' &&
            typeof result === 'string' &&
            !result.startsWith('ERROR') &&
            !result.startsWith('BLOCKED')
          ) {
            try {
              const fullPath = safeJoin(ctx.appPath, args.path);
              const finalContent = fs.readFileSync(fullPath, 'utf8');
              const diagnostic = checkTsSyntaxInLoop(args.path, finalContent);
              if (diagnostic) {
                return `${result}\n\n⚠️ SYNTAX CHECK FAILED for ${args.path}: ${diagnostic}\nFix this now with edit_file before moving to the next file   this file will not compile as-is.`;
              }
            } catch { /* file may not exist yet or be unreadable   don't block the tool result */ }
          }
          return result;
        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          const errCode = (err as NodeJS.ErrnoException)?.code ?? '';
          // Truncated args for context (avoid leaking huge file contents)
          const argsSummary = JSON.stringify(args, (_k, v) =>
            typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v
          );
          console.warn(`[AgentTool] ${def.name} failed:`, errMsg, '| args:', argsSummary);
          const codeNote = errCode ? ` (${errCode})` : '';
          return `ERROR: Tool "${def.name}" failed${codeNote}   ${errMsg}. Args: ${argsSummary}. You MUST address this error before proceeding. Either retry with corrected arguments or use a different approach.`;
        }
      },
    };
  }

  // Brain memory tool   agent can persist key facts that survive context compaction
  toolSet['save_memory'] = {
    description:
      'Save an important fact, decision, or state to your persistent brain memory for this run. ' +
      'Use this EARLY and OFTEN to remember: architecture decisions, which files you created/modified, ' +
      'key user requirements, error patterns you spotted, and anything you\'ll need in later steps. ' +
      'Your older tool call history gets compacted to save tokens   only facts saved here are guaranteed to persist.',
    inputSchema: jsonSchema({
      type: 'object' as const,
      properties: {
        memory: {
          type: 'string',
          description: 'The fact, decision, or context to remember. Be specific and concise.',
        },
      },
      required: ['memory'],
    }),
    execute: async (args: any) => {
      const text = typeof args.memory === 'string' ? args.memory.trim() : String(args.memory);
      if (text.length > 500) {
        brainMemory.push(text.substring(0, 500));
      } else {
        brainMemory.push(text);
      }
      return `Memory saved (${brainMemory.length} total). This will persist even as older context is compacted.`;
    },
  };

  return toolSet;
}
