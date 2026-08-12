import { ToolSet, jsonSchema } from 'ai';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { AgentContext } from '../agent-tools/types.js';
import { safeJoin } from '../agent-tools/types.js';
import { writeFileTool } from '../agent-tools/write_file.js';
import { proposePlanTool } from '../agent-tools/propose_plan.js';
import { declareScopeTool, pathMatchesScope } from '../agent-tools/declare_scope.js';
import { placeAssetTool } from '../agent-tools/place_asset.js';
import { replaceAssetReferencesTool } from '../agent-tools/replace_asset_references.js';
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
import { confirmDatabaseChangeTool } from '../agent-tools/confirm_database_change.js';
import { provisionDatabaseTool } from '../agent-tools/provision_database.js';
import { writeEdgeFunctionTool } from '../agent-tools/write_edge_function.js';
import { confirmEdgeFunctionDeployTool } from '../agent-tools/confirm_edge_function_deploy.js';
import { deleteEdgeFunctionTool } from '../agent-tools/delete_edge_function.js';
import { setSecretTool } from '../agent-tools/set_secret.js';
import { listSecretsTool } from '../agent-tools/list_secrets.js';
import { searchOrgKnowledgeTool } from '../agent-tools/search_org_knowledge.js';
import { pushToGithubTool } from '../agent-tools/push_to_github.js';
import { publishSiteTool } from '../agent-tools/publish_site.js';
import { checkTsSyntaxInLoop } from './agentContextCompaction.js';
import { validateCodeAst } from './agentAstValidation.js';
import { applySearchReplace } from '../agent-tools/edit_file.js';

// Tools irrelevant to a single-file, single-property "micro" change (color/text/
// one-line fixes   see MICRO_SYSTEM_PROMPT). Every tool schema sent costs real
// input tokens on EVERY step regardless of whether it's ever called   sending the
// full ~20-tool backend/infra set (query_database, write_edge_function, etc.) for
// a text tweak is pure fixed overhead. Micro tier's own prompt already scopes the
// task this narrowly; scoping the tool list to match is the same idea applied to
// the request payload, not just the instructions.
const MICRO_EXCLUDED_TOOLS = new Set([
  'run_command', 'get_database_schema', 'query_database', 'confirm_database_change', 'provision_database',
  'write_edge_function', 'confirm_edge_function_deploy', 'delete_edge_function', 'set_secret', 'list_secrets',
  'push_to_github', 'publish_site',
]);

export function buildToolSet(ctx: AgentContext, brainMemory: string[], tier?: string): ToolSet {
  // Expose the tier to tools (read_file's truncated-view-first gating needs it).
  ctx.tier = tier;
  const defs = [
    thinkTool,
    proposePlanTool,
    declareScopeTool,
    getBuildErrorsTool,
    writeFileTool,
    readFileTool,
    readFilesTool,
    listFilesTool,
    deleteFileTool,
    renameFileTool,
    placeAssetTool,
    replaceAssetReferencesTool,
    grepTool,
    globFilesTool,
    searchCodebaseTool,
    findSymbolUsagesTool,
    editFileTool,
    runCommandTool, // npm install/uninstall only   whitelist enforced inside the tool
    getDatabaseSchemaTool,
    queryDatabaseTool,
    confirmDatabaseChangeTool,
    provisionDatabaseTool,
    writeEdgeFunctionTool,
    confirmEdgeFunctionDeployTool,
    deleteEdgeFunctionTool,
    setSecretTool,
    listSecretsTool,
    pushToGithubTool,
    publishSiteTool,
    ...(ctx.ecgMcp ? [searchOrgKnowledgeTool] : []),
  ].filter((def) => tier !== 'micro' || !MICRO_EXCLUDED_TOOLS.has(def.name));

  // ── Per-run routing/budget state (buildToolSet is called once per run) ──
  // Serial-edit detector (2026-08-09 logo incident): the agent replaced one
  // asset path across 5 files via grep + serial per-file edit_file round-trips
  // -- ~3x the cost of the purpose-built replace_asset_references tool it
  // never called. Track each edit_file call's SEARCH strings; when the same
  // needle shows up across enough distinct files, route to the bulk tool
  // (hard redirect only when a real bulk tool exists for the pattern).
  const priorEditSearches: Array<{ path: string; norm: string }> = [];
  const SERIAL_EDIT_DISTINCT_PATHS = 2; // block the 3rd distinct file
  const ASSET_NEEDLE_RE = /\.(png|jpe?g|gif|svg|webp|ico|mp4|mp3|woff2?)\b|assets\//i;
  const normalizeSearch = (s: string) => s.replace(/\s+/g, ' ').trim();
  let serialEditAdvisoryShown = false;
  // Serial-read nudge: 3+ consecutive single-file read_file calls with no
  // intervening non-read tool call -> tip toward the batch read_files tool.
  // Advisory only (never blocks: the content is needed either way, and a
  // block would just burn a round-trip -- see the 2026-07-21 prefer-edit
  // guard incident above for why bounced-paid-work blocks are a last resort).
  let consecutiveSingleReads = 0;
  let readBatchTipShown = false;
  // Redundant-re-read block: a FULL read of a file that is still un-compacted
  // in context (read within the last 4 steps = compaction's KEEP_RECENT
  // window) and unmodified since is pure duplicate context. Truncated-view
  // reads are never blocked (re-reading after the outline IS the designed
  // escalation), nor are ranged reads or reads after an edit.
  const fullReadStepByPath = new Map<string, number>();
  const REREAD_BLOCK_WINDOW_STEPS = 4;
  // Think cap (2026-08-10): think was the single most-called tool across
  // 1,238 measured runs (2,853 calls), each one a full-context billed
  // request. Capped on the SMALL tiers only -- fix-tier diagnosis and
  // build-tier planning legitimately think more, and the root-cause-lock
  // feature depends on think calls, so those tiers stay uncapped.
  const THINK_CAP_TIERS: Record<string, number> = { micro: 2, edit: 3 };
  let thinkCallsThisRun = 0;
  // Rename-shape advisory: write_file(newPath, X) followed by delete_file of a
  // file whose on-disk content is identical to X was a rename done the
  // expensive way (full content resent through the model). Advisory only --
  // by delete time the cost is already sunk, this teaches the cheaper path.
  const writeHashToPath = new Map<string, string>();
  const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
  // Tier budget backstop (2026-08-09): cap DISTINCT files written/edited per
  // run by tier. PREVENTATIVE RUNAWAY GUARD ONLY -- explicitly NOT a cost
  // mechanism (the confirmed cost drivers are serial-edit routing and
  // transcript size, handled separately). Mirrors the DDL confirm-gate shape:
  // blocked-with-instructions, not a hard kill; feature/build stay uncapped.
  const TIER_FILE_CAPS: Record<string, number> = { micro: 3, edit: 10, fix: 10 };
  const tierFileCap = tier ? TIER_FILE_CAPS[tier] : undefined;
  const editedPathsThisRun = new Set<string>();

  const toolSet: ToolSet = {};
  for (const def of defs) {
    toolSet[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (args: any) => {
        // Advisory (non-blocking) routing note to append to a successful result.
        let pendingRoutingAdvisory: string | null = null;

        // ── Think cap (small tiers only) ─────────────────────────────────────
        if (def.name === 'think' && tier && THINK_CAP_TIERS[tier] !== undefined) {
          thinkCallsThisRun++;
          if (thinkCallsThisRun > THINK_CAP_TIERS[tier]) {
            return (
              `Think budget for this ${tier} task is used up (${THINK_CAP_TIERS[tier]} calls). Act now: make the ` +
              `edit, or if something genuinely blocks you, say exactly what it is in your response text instead of ` +
              `thinking further.`
            );
          }
        }

        // ── Redundant-re-read block ──────────────────────────────────────────
        if (
          def.name === 'read_file' && typeof args.path === 'string' &&
          args.full !== true &&
          args.start_line_one_indexed == null && args.end_line_one_indexed_inclusive == null
        ) {
          const lastFullRead = fullReadStepByPath.get(args.path);
          const nowStep = ctx.ledger?.getStep?.() ?? 0;
          if (
            lastFullRead !== undefined &&
            nowStep - lastFullRead <= REREAD_BLOCK_WINDOW_STEPS &&
            !editedPathsThisRun.has(args.path)
          ) {
            return (
              `Already in context: you read "${args.path}" in full at step ${lastFullRead} and it has not been ` +
              `modified since -- the content above is still current. Do not re-read; work from what you have.`
            );
          }
        }

        // ── Serial-read tracking (for the read_files batch nudge below) ──────
        if (def.name === 'read_file') {
          consecutiveSingleReads++;
          if (consecutiveSingleReads >= 3 && !readBatchTipShown) {
            readBatchTipShown = true;
            pendingRoutingAdvisory =
              `TIP: this is your ${consecutiveSingleReads}th consecutive single-file read. ` +
              `read_files([path1, path2, ...]) reads multiple files in ONE step -- batch your remaining reads.`;
          }
        } else {
          consecutiveSingleReads = 0;
        }

        // ── Tier file-budget backstop ────────────────────────────────────────
        // Preventative runaway guard, NOT a cost fix. Counts distinct paths
        // this run has written/edited; at the cap, further NEW files are
        // staged behind an explicit user go-ahead (existing-file re-edits
        // stay allowed so in-flight work on already-touched files finishes).
        if (
          tierFileCap !== undefined &&
          (def.name === 'write_file' || def.name === 'edit_file' || def.name === 'place_asset') &&
          typeof (args.path ?? args.destName) === 'string'
        ) {
          const budgetPath: string = args.path ?? args.destName;
          if (!editedPathsThisRun.has(budgetPath) && editedPathsThisRun.size >= tierFileCap) {
            return (
              `BLOCKED (tier file budget): this ${tier} run has already modified ${editedPathsThisRun.size} distinct ` +
              `files -- the cap for a ${tier}-tier task. Touching "${budgetPath}" would expand scope further. ` +
              `Finish up: summarize what is done, list the remaining files you would still change and WHY, and ask ` +
              `the user to confirm before continuing. If this task genuinely needs broad changes, tell the user to ` +
              `re-run it phrased as a feature/build request so it routes to an uncapped tier.`
            );
          }
        }

        // ── Serial-edit → bulk-tool routing ──────────────────────────────────
        // Same-needle SEARCH blocks across distinct files = a find-and-replace
        // being done one LLM round-trip at a time. Asset-path needles get a
        // hard redirect (replace_asset_references does the whole job in one
        // call); non-asset needles get an advisory on the executed result
        // only, because no true multi-file replace tool exists to point at
        // and bouncing already-generated work is proven waste (2026-07-21).
        if (def.name === 'edit_file' && typeof args.path === 'string' && typeof args.diff === 'string') {
          const searches = [...args.diff.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======/g)]
            .map((m) => normalizeSearch(m[1]))
            .filter((s) => s.length >= 8);
          for (const norm of searches) {
            const priorPaths = new Set(
              priorEditSearches.filter((e) => e.norm === norm && e.path !== args.path).map((e) => e.path),
            );
            if (priorPaths.size >= SERIAL_EDIT_DISTINCT_PATHS && ASSET_NEEDLE_RE.test(norm)) {
              return (
                `BLOCKED (serial-edit detected): you are replacing the same asset reference ` +
                `("${norm.slice(0, 80)}") file-by-file -- this is your ${priorPaths.size + 1}th file with the ` +
                `identical SEARCH text. Call replace_asset_references(oldAssetPath, newAssetPath) instead: it ` +
                `rewrites EVERY reference (img src, CSS url(), <link>/<meta> tags, manifest icons, JS imports) ` +
                `across the whole project in ONE pass and reports exactly what it changed. Then verify with grep.`
              );
            }
            if (priorPaths.size >= SERIAL_EDIT_DISTINCT_PATHS && !ASSET_NEEDLE_RE.test(norm) && !serialEditAdvisoryShown) {
              serialEditAdvisoryShown = true;
              pendingRoutingAdvisory =
                `NOTE: this is your ${priorPaths.size + 1}th file applying the same replacement ` +
                `("${norm.slice(0, 60)}"). If more files need it, use grep to list ALL remaining occurrences ` +
                `first, then edit them in as few steps as possible instead of one file per step.`;
            }
          }
          for (const norm of searches) priorEditSearches.push({ path: args.path, norm });
        }

        // ── Rename-shape advisory (delete after identical-content write) ─────
        if (def.name === 'delete_file' && typeof args.path === 'string') {
          try {
            const fullPath = safeJoin(ctx.appPath, args.path);
            if (fs.existsSync(fullPath)) {
              const stat = fs.statSync(fullPath);
              if (stat.size < 1024 * 1024) {
                const newPath = writeHashToPath.get(sha1(fs.readFileSync(fullPath, 'utf8')));
                if (newPath && newPath !== args.path) {
                  pendingRoutingAdvisory =
                    `NOTE: you wrote "${newPath}" with content identical to the file you just deleted -- that was ` +
                    `a rename done the expensive way (full content resent). Next time call ` +
                    `rename_file("${args.path}", "${newPath}") -- one step, no content round-trip, and imports ` +
                    `get updated for you.`;
                }
              }
            }
          } catch { /* advisory only -- never interfere with the delete */ }
        }

        // ── Pre-flight AST Reflection Interceptor ─────────────────────────────
        if ((def.name === 'write_file' || def.name === 'edit_file') && typeof args.path === 'string') {
          let contentToValidate: string | null = null;

          if (def.name === 'write_file' && typeof args.content === 'string') {
            contentToValidate = args.content;
          } else if (def.name === 'edit_file' && typeof args.diff === 'string') {
            try {
              const fullPath = safeJoin(ctx.appPath, args.path);
              if (fs.existsSync(fullPath)) {
                const original = fs.readFileSync(fullPath, 'utf8');
                const result = applySearchReplace(original, args.diff);
                if (result.success && result.content != null) {
                  contentToValidate = result.content;
                }
              }
            } catch { /* ignore read errors for non-existent files */ }
          }

          if (contentToValidate !== null) {
            const astCheck = validateCodeAst(args.path, contentToValidate);
            if (!astCheck.valid) {
              const errorLines = astCheck.errors
                .map((e) => `  • Line ${e.line}:${e.column} - TS${e.code}: ${e.message}`)
                .join('\n');
              return (
                `[AST REFLECTION REJECTION] Code was NOT written to disk due to syntax errors:\n` +
                `${errorLines}\n\n` +
                `The file operation was short-circuited and disk content remains untouched. ` +
                `Please fix these syntax errors before attempting to write.`
              );
            }
          }
        }

        // ── Diagnosis-before-write guard (fix tier only) ─────────────────────
        // Root-cause audit finding: a fix run could jump straight from a bug
        // report to write_file/edit_file with zero verified evidence of what's
        // actually broken   producing a new "root cause" guess every turn
        // instead of confirming one against the real compiler/runtime output.
        // get_build_errors already documents itself as "call FIRST, never guess
        // at errors"; this makes that a hard requirement instead of an ignorable
        // prompt line. Read-before-write (below) only proves the model looked at
        // a file's contents, not that it knows WHY that file is broken   those
        // are different guarantees, so this doesn't piggyback on that guard.
        // Scoped to tier === 'fix' only: build/feature/edit runs legitimately
        // write files with no pre-existing error to diagnose.
        if (tier === 'fix' && (def.name === 'write_file' || def.name === 'edit_file') && !ctx.buildErrorCallCount) {
          return (
            `BLOCKED: call get_build_errors first to see the real error before making a fix. ` +
            `This is a fix run   don't guess at the root cause from the bug report alone; confirm it against ` +
            `the actual compiler/runtime output, then make ONE targeted change.`
          );
        }
        // ── Root-cause-lock (Phase 3) ────────────────────────────────────────
        // Diagnosis-before-write above only gates the FIRST write of a run.
        // agentLoopService.ts's per-step think-comparison sets this flag the
        // moment a `think` call silently contradicts the run's locked active
        // hypothesis (different reasoning, no falsification language, active
        // hypothesis not yet verified fixed)   block the write that would act
        // on that unreconciled pivot instead of letting it through ungated.
        if (tier === 'fix' && (def.name === 'write_file' || def.name === 'edit_file') && ctx.rootCauseLockViolation) {
          return (
            `BLOCKED: you pivoted to a different explanation for this bug without reconciling it against your ` +
            `previous one. Call \`think\` again and either (1) state specifically what evidence showed the earlier ` +
            `hypothesis was wrong, or (2) go back and verify/finish the earlier hypothesis's fix instead of ` +
            `abandoning it silently. Then retry this write.`
          );
        }
        // ── Mutation circuit breaker (lifecycle audit fix, 2026-08-11/12) ────
        // Real fix for the dead editFailures mechanism (see AgentContext's
        // mutationFailureStreak doc comment for the full incident this
        // replaces). agentLoopService.ts tracks per-(tool,path) identical-
        // failure streaks in ctx.mutationFailureStreak after each step; once a
        // streak hits the threshold, HARD-block further calls to that exact
        // tool+path combo -- not just an advisory note the model can ignore.
        // Mirrors get_build_errors.ts's in-call breaker, the one place in the
        // toolset where a repeated failure already produced a guaranteed
        // behavior change. The escape hatch is genuine, not a special case:
        // switching tool (edit_file -> write_file for a full rewrite, or vice
        // versa) uses a DIFFERENT map key, so it's still allowed -- exactly
        // "try a fundamentally different approach" instead of "retry the same
        // broken thing again."
        const MUTATION_CIRCUIT_BREAKER_THRESHOLD = 3;
        if (
          (def.name === 'write_file' || def.name === 'edit_file' || def.name === 'delete_file' || def.name === 'rename_file') &&
          ctx.mutationFailureStreak
        ) {
          const targetPath: string | undefined = def.name === 'rename_file' ? args.from : args.path;
          if (typeof targetPath === 'string') {
            const streak = ctx.mutationFailureStreak.get(`${def.name}:${targetPath}`);
            if (streak && streak.count >= MUTATION_CIRCUIT_BREAKER_THRESHOLD) {
              return (
                `BLOCKED (repeated identical failure): "${def.name}" has failed on "${targetPath}" ${streak.count} times in a row ` +
                `with the exact same error:\n\n"${streak.message.slice(0, 300)}"\n\n` +
                `Retrying this exact call again will fail the same way. Do ONE of: ` +
                `(1) call read_file("${targetPath}") to see its current real state, then use ${def.name === 'edit_file' ? 'write_file to rewrite the whole file' : 'edit_file for a smaller targeted patch'} instead of repeating ${def.name}; ` +
                `(2) if the error names a different file (e.g. a type it imports), fix THAT file instead; ` +
                `(3) tell the user plainly this is blocked and why, instead of continuing to retry.`
              );
            }
          }
        }
        // ── Declared-scope guard (harness redesign increment 2, 2026-08-11) ──
        // Root-cause audit finding: nothing restricted WHICH files a write/
        // edit/delete/rename call could target, only how many. A "fix the
        // logo" request could (and did) wander into unrelated pre-existing
        // bugs across the whole codebase with nothing to stop it. Opt-in
        // (ctx.declaredScope stays undefined, gate is a no-op, unless the
        // model called declare_scope) and soft-warn-then-block, not a hard
        // block on the first brush outside the declared set   tonight's
        // incident was SUSTAINED wandering, not one edge-case touch; a
        // tolerance-then-block pattern catches that shape without killing a
        // legitimate multi-file dependency edit (e.g. a shared type used by
        // several declared files).
        const SCOPE_VIOLATION_TOLERANCE = 2;
        if (
          ctx.declaredScope &&
          (def.name === 'write_file' || def.name === 'edit_file' || def.name === 'delete_file' || def.name === 'rename_file')
        ) {
          const targetPaths = def.name === 'rename_file'
            ? [args.from, args.to].filter((p): p is string => typeof p === 'string')
            : (typeof args.path === 'string' ? [args.path] : []);
          const outOfScope = targetPaths.filter((p) => !pathMatchesScope(p, ctx.declaredScope!));
          if (outOfScope.length > 0) {
            ctx.scopeViolationCount = (ctx.scopeViolationCount ?? 0) + 1;
            if (ctx.scopeViolationCount > SCOPE_VIOLATION_TOLERANCE) {
              return (
                `BLOCKED (out of declared scope): "${outOfScope.join('", "')}" ${outOfScope.length === 1 ? 'was' : 'were'} not in your ` +
                `declare_scope call, and this is the ${ctx.scopeViolationCount}${ctx.scopeViolationCount === 3 ? 'rd' : 'th'} file outside it this run. ` +
                `If the task genuinely requires touching more than you originally declared, call declare_scope again with the ` +
                `wider set and explain why   otherwise stop and stay on the reported task.`
              );
            }
            // Soft warning, tolerance not yet exceeded: let the write through
            // (do NOT return/short-circuit here   that would block on the
            // very first brush outside scope, exactly the false-positive risk
            // this increment is designed to avoid) and attach the warning to
            // the real result afterward, same pendingRoutingAdvisory pattern
            // already used for the batch-read tip / serial-edit note below.
            pendingRoutingAdvisory =
              `WARNING (out of declared scope): "${outOfScope.join('", "')}" ${outOfScope.length === 1 ? 'was' : 'were'} not in your declare_scope ` +
              `call. If this file genuinely needs to change to complete the task, explain why in your next message; ` +
              `if not, stay focused on the files you declared.`;
          }
        }

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

          // ── Truncated-rewrite guard (was: blanket prefer-edit guard) ────────
          // The old version rejected EVERY write_file on a read file >40 lines
          // and told the model to redo the work via edit_file. Confirmed live
          // 2026-07-21: Claude produced a complete corrected file TWICE in one
          // run ($0.16/attempt), both bounced by this guard, the model never
          // switched to edit_file, and the run died in the stuck-detector with
          // the user billed $1.40 for zero changes. Rejecting content that is
          // already generated and paid for is pure waste   the danger the guard
          // exists for is specifically TRUNCATED rewrites ("// rest of code
          // unchanged") silently deleting untouched code. So check for THAT:
          // accept complete-looking rewrites, reject only suspicious shrinkage
          // or placeholder markers.
          if (def.name === 'write_file' && ctx.readFiles?.has(relPath) && typeof args.content === 'string') {
            try {
              const fullPath = safeJoin(ctx.appPath, relPath);
              if (fs.existsSync(fullPath)) {
                const existing = fs.readFileSync(fullPath, 'utf8');
                const oldLines = existing.split('\n').length;
                const newLines = (args.content as string).split('\n').length;
                const placeholderRe = /\/\/\s*\.\.\.|\/\*\s*\.\.\.|rest of (the )?(code|file|component)|remains? (the )?same|unchanged (code|above|below)|existing (code|implementation) here/i;
                // Block ONLY on explicit placeholder markers   the unambiguous
                // truncation signal. A first draft of this guard also blocked
                // any rewrite under 50% of the old line count, which rejects
                // legitimate deletion requests ("remove the rest of the page")
                // just as wastefully as the blanket prefer-edit guard it
                // replaced   caught 2026-07-21 before it billed anyone. Large
                // shrinkage without markers is accepted; the per-run snapshot
                // and revisions system cover recovery if a rewrite genuinely
                // dropped code, and the shrink warning below tells the model
                // (and the run log) that it happened.
                if (oldLines > 40 && placeholderRe.test(args.content as string)) {
                  return (
                    `BLOCKED: your write_file for "${relPath}" contains placeholder text like "rest of code" / ` +
                    `"unchanged"   writing it would silently delete the code those placeholders stand for. ` +
                    `Provide the COMPLETE file content, or use edit_file with SEARCH/REPLACE blocks for targeted changes.`
                  );
                }
                if (oldLines > 40 && newLines < oldLines * 0.5) {
                  ctx.pendingShrinkWarnings = ctx.pendingShrinkWarnings ?? new Map();
                  ctx.pendingShrinkWarnings.set(relPath, `note: this rewrite shrank ${relPath} from ${oldLines} to ${newLines} lines. If that was not intentional, restore the missing sections with edit_file.`);
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

          // ── Wrong-shape edge-function invoke path guard ────────────────────────
          // Confirmed live (CardPro, 2026-08-10): the agent wrote
          // `${VITE_FUNCTIONS_API_URL}/api/v1/functions/<name>/invoke` into 4
          // frontend files -- the exact shape the prompt explicitly bans
          // (VITE_FUNCTIONS_API_URL already ends in /functions; the invoke
          // path is FLAT: `/<name>/invoke`). Every such call 404s, and the
          // user saw it as "external api error". Prompt-only enforcement
          // failed again; this makes it mechanical.
          const wrongInvokePath = newContent.match(/api\/v1\/functions/);
          if (wrongInvokePath) {
            return (
              `BLOCKED: "${args.path}" builds an edge-function URL with "/api/v1/functions/" -- that path shape is ` +
              `this platform's INTERNAL API and always 404s from a generated app. VITE_FUNCTIONS_API_URL already ` +
              `ends in "/functions"; the correct call is FLAT: ` +
              '`fetch(`${import.meta.env.VITE_FUNCTIONS_API_URL}/<function-name>/invoke`, ...)` -- ' +
              `no "/api/v1", no extra "/functions". Rewrite the URL and retry.`
            );
          }

          // ── Root-relative /api/* fetch guard ───────────────────────────────────
          // Generated apps have NO Express backend: the preview service and the
          // production host serve static files only, so every fetch to a
          // root-relative "/api/..." path 404s (blank data, "request failed",
          // broken login screens -- the recurring "API GET hook conflict"
          // client reports). The prompt bans this pattern (rule 3, "NEVER call
          // /api/*"); this makes it mechanical. Composed platform URLs like
          // `${VITE_DB_API_URL}/...` never match: the match requires the quote
          // to sit immediately before "/api/".
          const rootRelativeApiFetch = newContent.match(/\b(?:fetch|axios(?:\.\w+)?)\(\s*(['"`])\/api\//);
          if (rootRelativeApiFetch) {
            return (
              `BLOCKED: "${args.path}" calls a root-relative "/api/..." URL. There is NO backend server behind ` +
              `this app -- previews and published sites serve static files only, so every "/api/*" request 404s. ` +
              `Use the real integrations instead: auth via the client from VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY, ` +
              `app data via PostgREST on VITE_DB_API_URL, and custom server logic as an edge function invoked with ` +
              '`fetch(`${import.meta.env.VITE_FUNCTIONS_API_URL}/<function-name>/invoke`, ...)`. Rewrite and retry.'
            );
          }

          // ── Hardcoded-undefined auth/DB config guard ───────────────────────────
          // Confirmed live incident (2026-08-06 audit, 3 separate projects): an
          // agent turn wrote `const supabaseUrl = undefined;` / `const
          // supabaseAnonKey = undefined;` as literal source   not missing an env
          // read by omission, but writing the literal keyword `undefined` where a
          // real `import.meta.env.VITE_*` reference belonged. That code always
          // fails silently or with a manufactured "Auth service is not configured"
          // message, no build/type error ever surfaces it (valid TS: `const x:
          // undefined = undefined` type-checks fine), and nothing else in this
          // tool set would catch it   the platform-URL guard above only catches
          // hardcoded URLs and `??`/`||` fallbacks, not a bare `= undefined`
          // assignment. Same incident class as materialize.js's documented
          // `${undefined}` template-literal artifact (Fix 3.45), just as a
          // standalone statement instead of embedded in a string. Scoped to
          // variable names that look like connection config (url/key/anon/schema
          // combined with supabase/auth/db) so this doesn't fire on legitimate
          // `const x = undefined;` elsewhere in generated code.
          const undefinedConfigMatch = newContent.match(
            /\b(?:const|let|var)\s+(\w*(?:supabase|auth|db)\w*(?:url|key|anon|schema)\w*)\s*=\s*undefined\b/i
          );
          if (undefinedConfigMatch) {
            return (
              `BLOCKED: "${args.path}" hardcodes \`${undefinedConfigMatch[1]} = undefined\`   this is the exact ` +
              `pattern that has broken auth in production before (a real "Auth service is not configured" incident ` +
              `traced to this literal statement). If this is meant to hold a connection URL or ` +
              `key, read it from the actual env var: \`import.meta.env.VITE_SUPABASE_URL\` / \`VITE_SUPABASE_ANON_KEY\` ` +
              `for auth, \`VITE_DB_API_URL\` / \`VITE_DB_ANON_KEY\` / \`VITE_DB_SCHEMA\` for the hosted database   ` +
              `never a bare \`undefined\` placeholder.`
            );
          }
        }

        try {
          let result = await def.execute(args, ctx);
          // ── Track successful reads ─────────────────────────────────────────
          // Mark file as read so subsequent write_file/edit_file calls are allowed.
          if (def.name === 'read_file' && typeof args.path === 'string' && ctx.readFiles) {
            ctx.readFiles.add(args.path);
            // Track FULL (untruncated, unranged) reads for the re-read block.
            if (
              typeof result === 'string' && !result.startsWith('[TRUNCATED VIEW]') && !result.startsWith('Error') &&
              args.start_line_one_indexed == null && args.end_line_one_indexed_inclusive == null
            ) {
              fullReadStepByPath.set(args.path, ctx.ledger?.getStep?.() ?? 0);
            }
          }
          // ── Track distinct files modified (tier file-budget accounting) ────
          if (
            (def.name === 'write_file' || def.name === 'edit_file' || def.name === 'place_asset') &&
            typeof (args.path ?? args.destName) === 'string' &&
            typeof result === 'string' &&
            !result.startsWith('ERROR') && !result.startsWith('BLOCKED') && !result.startsWith('[AST')
          ) {
            editedPathsThisRun.add(args.path ?? args.destName);
            if (def.name === 'write_file' && typeof args.content === 'string' && args.content.length < 1024 * 1024) {
              writeHashToPath.set(sha1(args.content), args.path);
            }
          }
          // ── Append routing advisory (batch-read tip / serial-edit note) ────
          if (
            pendingRoutingAdvisory &&
            typeof result === 'string' &&
            !result.startsWith('ERROR') && !result.startsWith('BLOCKED')
          ) {
            result = `${result}\n\n${pendingRoutingAdvisory}`;
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
          // Surface a pending shrink warning (set by the truncation guard above)
          // on the SUCCESSFUL write result it belongs to.
          if (
            def.name === 'write_file' && typeof args.path === 'string' &&
            typeof result === 'string' && !result.startsWith('ERROR') && !result.startsWith('BLOCKED')
          ) {
            const warn = ctx.pendingShrinkWarnings?.get(args.path);
            if (warn) {
              ctx.pendingShrinkWarnings!.delete(args.path);
              return `${result}\n\n${warn}`;
            }
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
