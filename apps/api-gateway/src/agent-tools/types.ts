/**
 * Shared types for the EcomGear Agent Tool system.
 * Express-native port of the Dyad local_agent tools (no Electron / Drizzle deps).
 */

import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { RunStateLedger } from '../services/runStateLedger.js';

// ─── AgentContext ────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Absolute path to the project root on disk. */
  appPath: string;
  /** Logical project identifier from the DB. */
  projectId: string;
  /**
   * Called once when a tool finishes to stream the rendered XML block
   * to the SSE client (e.g. <ecomgear-write …>…</ecomgear-write>).
   */
  onXmlComplete: (xml: string) => void;
  /** Returns packages declared via <ecomgear-add-dependency> so far in this run. */
  getDeclaredDependencies?: () => string[];
  /**
   * Tracks which project-relative paths have been fetched via read_file in this run.
   * Used to enforce a read-before-write discipline: the agent must read a file before
   * overwriting it, preventing it from clobbering unread content.
   */
  readFiles?: Set<string>;
  /** Per-run change journal   records every read/write/edit for journal injection into prepareStep. */
  ledger?: RunStateLedger;
  /** Cost-routing tier for this run (micro/edit/fix/feature/build) -- set by buildToolSet so tools can tier-gate behavior. */
  tier?: string;
  /**
   * Reverse import graph: for each file path, the set of files that import it.
   * Used by write_file / edit_file to warn the agent about downstream breakage risk.
   */
  reverseGraph?: Map<string, Set<string>>;
  /**
   * Buffer of files written/edited during this run (path → final content).
   * write_file and edit_file accumulate here instead of pushing to the preview
   * service on every change. get_build_errors flushes this before checking.
   * The agent loop does a final fullSync flush when all steps complete.
   */
  pendingPreviewFiles?: Map<string, string>;
  /**
   * Large-shrink notices from the truncation guard (agentToolSet), keyed by
   * file path; appended to that file's successful write_file result so the
   * model knows the rewrite dropped many lines and can restore if unintended.
   */
  pendingShrinkWarnings?: Map<string, string>;
  /**
   * Real fix, harness redesign (2026-08-11/12 lifecycle audit): this field
   * used to be `editFailures?: Map<string, number>`, described in this exact
   * comment as blocking edit_file after 2 failures and forcing write_file --
   * but repo-wide grep found it was NEVER written to or read anywhere. Dead
   * code describing a mechanism that didn't exist, discovered by a live
   * incident (agent retried an identical failing write_file 5x in a row,
   * tailwind.config.js, project dfe41091, 2026-08-11 08:52).
   *
   * This is the real, wired-up version. Keyed by `${toolName}:${normalizedPath}`,
   * populated by agentLoopService.ts's post-step failure tracking (same data
   * that already existed for the advisory-only circuitBreakerNote, now also
   * written here) and READ by agentToolSet.ts's write_file/edit_file dispatch
   * gate: once a (tool, path) pair hits MUTATION_CIRCUIT_BREAKER_THRESHOLD
   * identical-message failures, further calls to that EXACT tool+path combo
   * are hard-blocked -- not just advised against -- until either that pair
   * succeeds (clears the entry) or the model switches tool (edit_file -> full
   * write_file rewrite, or vice versa, is a different key and stays allowed;
   * "try a fundamentally different approach" is the actual escape hatch, not
   * a special-cased reset). Mirrors get_build_errors.ts's in-call circuit
   * breaker, the one place in the toolset where a repeated failure already
   * produced a guaranteed behavior change instead of an ignorable suggestion.
   */
  mutationFailureStreak?: Map<string, { message: string; count: number }>;
  /**
   * Tracks how many times get_build_errors has been called in this agent run.
   * After 3 calls the tool returns a hard STOP message to prevent infinite
   * error-check loops where errors never fully resolve.
   */
  buildErrorCallCount?: number;
  /**
   * Result of the MOST RECENT get_build_errors call this run: true only when
   * it returned "healthy", false when it returned real errors, undefined if
   * never called or the result was inconclusive (service unreachable/5xx).
   * Used to gate resolution-claim language ("this should fix it") in the
   * agent's final message   a claim with no passing verification behind it
   * gets forced back for an actual check instead of reaching the user unverified.
   */
  lastBuildErrorsHealthy?: boolean;
  /**
   * Set by get_build_errors when the session-level thrash detector escalates
   * (same file+error-kind fingerprint has tripped the circuit breaker 2+ times
   * across this and/or prior runs). agentLoopService.ts reads this at run end
   * to force an honest "N attempts, still broken" closing message regardless
   * of what the model actually wrote   mirrors the verified-fix-before-
   * closure-claim override, reused rather than rebuilt.
   */
  thrashEscalated?: boolean;
  thrashFingerprint?: string;
  thrashTripCount?: number;
  /**
   * Root-cause-lock (Phase 3 of the 2026-08-06 audit). The first post-diagnosis
   * `think` thought this run (fix tier only) is recorded here as the session's
   * active hypothesis. A later `think` call that diverges from it (low text
   * similarity) without either (a) the active hypothesis's fix having been
   * verified healthy, or (b) explicit falsification language explaining why it
   * was wrong, is a SILENT pivot   agentLoopService.ts flags
   * rootCauseLockViolation, which agentToolSet.ts's write_file/edit_file guard
   * then blocks on until the model reconciles. Prevents the "six different
   * stated root causes, no acknowledgment any prior one was wrong" pattern.
   */
  activeHypothesis?: string;
  rootCauseLockViolation?: boolean;
  rootCauseLockTriggerCount?: number;
  /**
   * Declared-scope guard (harness redesign increment 2, 2026-08-11). Set by
   * the declare_scope tool when the model opts in to naming which files/dirs
   * a task will touch. Turn-scoped, never persisted   same shape as
   * activeHypothesis above, not propose_plan's DB-backed agent_plans row.
   * undefined (never declared) means the gate in agentToolSet.ts is a no-op;
   * this is opt-in, not enforced by default. scopeViolationCount tracks how
   * many write/edit/delete/rename calls this run have landed outside the
   * declared set   past SCOPE_VIOLATION_TOLERANCE the gate hard-blocks
   * instead of warning, so sustained wandering (tonight's incident shape) is
   * caught without killing a single legitimate off-declaration touch.
   */
  declaredScope?: Set<string>;
  scopeViolationCount?: number;
  /**
   * Counts edit_file SEARCH-block misses and get_build_errors circuit-breaker
   * trips this run. Previously these only reached a console.warn   the
   * edit_file.ts comment admits the miss rate was "unmeasurable... zero grep
   * hits across 2 months of production logs." agentLoopService.ts reads these
   * at run end and persists them to agent_runs so miss/breaker rates become
   * queryable instead of relying on someone noticing a bad run manually.
   */
  editSearchMissCount?: number;
  buildErrorCircuitBreakCount?: number;
  /**
   * Retrieval-consult telemetry (CP4a, measurement only -- no gate/nudge yet,
   * see docs/spec/agent-orchestration-stability.md). retrievalConsulted is
   * set true the first time this run calls search_codebase/grep/glob_files
   * (agentToolSet.ts's generic tool-dispatch point). netNewWriteCount counts
   * write_file calls whose target didn't exist on disk before the write
   * (agentToolSet.ts's read-before-write guard, reusing its existsSync
   * check); netNewWriteWithoutRetrievalCount is the subset of those where
   * retrievalConsulted was still false. agentLoopService.ts persists both to
   * agent_runs so the retrieval skip rate is queryable instead of guessed --
   * whether that rate justifies a CP4b gate is a later, separate decision.
   */
  retrievalConsulted?: boolean;
  netNewWriteCount?: number;
  netNewWriteWithoutRetrievalCount?: number;
  /** URL of the preview service, e.g. http://localhost:3001 */
  previewServiceUrl?: string;
  /** Authenticated user id   required by database_query / get_database_schema to scope tenant DB access. */
  userId?: string;
  /** Tracks how many times query_database has been called in this run, to cap runaway query loops. */
  dbQueryCallCount?: number;
  /** eCG Agents Portal MCP endpoint, present only for projects with MCP enabled at launch. */
  ecgMcp?: { url: string; token?: string };
  /**
   * Asset-reference completeness tracking (root cause #2 of the 2026-08-06
   * asset-replacement audit). Keyed by old asset path (project-relative,
   * e.g. "public/assets/old-logo.png"). Set by replace_asset_references
   * after it scans+rewrites; read by agentToolSet.ts's delete_file gate
   * (block deleting an old asset until references to it were checked) and
   * by agentLoopService.ts's asset-completeness closure-claim check (don't
   * let "replaced everywhere" stand unless this actually ran and found
   * nothing left un-rewritten).
   */
  assetReferencesChecked?: Map<string, { fullyResolved: boolean; unresolvedCount: number }>;
  /** Counts place_asset calls this run   cheap signal for "an asset task happened", used to scope the asset-completeness closure-claim check without a false trigger on unrelated runs. */
  placeAssetCallCount?: number;
  /**
   * Project-relative paths place_asset wrote this run (e.g.
   * "public/assets/logo.png"). The orphaned-asset gate checks at run end
   * that something in src/ actually references each placed filename --
   * a placed-but-never-referenced image renders nowhere, yet the run
   * used to report success (2026-08-17 "change the logo" incident).
   */
  placedAssetPaths?: string[];
  /**
   * Set true by a tool that made a real, billable/consequential change with
   * NO corresponding project file (e.g. provision_database.ts provisioning a
   * tenant Postgres schema   there's nothing on disk to write). agentWroteFiles
   * in agentLoopService.ts ORs this in alongside filesToWrite/filesEdited/
   * filesToDelete/renames, so a turn whose only action was this kind of
   * mutation still triggers the end-of-turn preview-sync gate and doesn't get
   * mislabeled ghostRun. Deliberately NOT implemented via a synthetic
   * <ecomgear-write> entry: agentLoopService.ts's disk-walk sync re-reads
   * every path in filesToWrite from disk, and a path with nothing real there
   * would inject a bogus placeholder file into the live project instead of
   * fixing anything (found during the 2026-08 sync audit, provision_database.ts).
   */
  nonFileMutation?: boolean;
  /**
   * Turn-scoped staging area for schema-mutating SQL (DDL: CREATE/ALTER/DROP/
   * TRUNCATE) awaiting a confirm_database_change call. query_database stages
   * DDL here instead of executing it immediately   closes the "agent silently
   * altered live schema with zero visibility" gap found in the 2026-08 core-loop
   * audit. Never persisted; abandoned entries just expire with the run.
   */
  pendingDbChanges?: Map<string, { sql: string; createdAt: number }>;
  /**
   * Mutation-breaker support for confirm_database_change (checkpoint 1,
   * 2026-08 orchestration hardening). Its own arg is only a single-use
   * confirmationId minted fresh every call -- no stable key to track retries
   * on. agentToolSet.ts's dispatch wrapper snapshots the staged SQL here
   * (keyed by confirmationId) BEFORE calling execute(), because execute()
   * deletes the pendingDbChanges entry unconditionally as its first act (see
   * confirm_database_change.ts) -- by the time agentLoopService.ts's
   * post-step tracking loop runs, pendingDbChanges no longer has it. See
   * deriveDbMutationKey below.
   */
  dbMutationSqlByConfirmationId?: Map<string, string>;
  /**
   * Turn-scoped staging area for edge-function deploys awaiting a
   * confirm_edge_function_deploy call. write_edge_function validates and
   * stages here instead of writing the live DB row / syncing to the execution
   * host immediately   same "surface then confirm" gate as pendingDbChanges,
   * for the other live-effecting tool the 2026-08 audit flagged.
   */
  pendingEdgeFunctionDeploys?: Map<string, {
    name: string;
    code: string;
    description?: string;
    requiresServiceRole?: boolean;
    isPublic?: boolean;
    createdAt: number;
  }>;
  /**
   * Anon-fetch-without-policy gate (2026-08 audit follow-up). Live repro: an
   * agent created a table (RLS auto-enabled, zero policies   correct), wrote
   * clean frontend code doing a direct `fetch()` to `/rest/v1/<table>` with
   * the anon key, never issued a CREATE POLICY, and closed the run with a
   * confident summary. get_build_errors passes clean (nothing is syntactically
   * wrong)   the anon role just gets 0 rows back at runtime. Two turn-scoped
   * sets close that gap:
   *   - anonFetchTables: table name (lowercased) -> first file path where
   *     write_file/edit_file detected a direct `/rest/v1/<table>` fetch
   *     alongside an ANON_KEY/VITE_DB_ANON_KEY/DB_ANON_KEY marker in the same
   *     file content. See extractAnonFetchTables in this file.
   *   - anonPolicyTables: table names (lowercased) that got a CREATE POLICY
   *     actually EXECUTED this run (confirm_database_change, not just staged)
   *     targeting an anon/public role. See extractAnonPolicyTables in
   *     query_database.ts.
   * agentLoopService.ts computes the gap (anonFetchTables minus
   * anonPolicyTables) at the closure-claim gate and forces a corrective
   * continuation when non-empty. KNOWN LIMITATION: a pre-existing table from
   * a prior run that already has an anon policy, newly wired to a fetch this
   * run, will false-positive here   there's no live pg_policies check, only
   * this-run tracking. Accepted trade-off; flagged rather than silently
   * expanding scope to a live DB check.
   */
  anonFetchTables?: Map<string, string>;
  anonPolicyTables?: Set<string>;
  /**
   * Maps a chat-upload tempPath (exactly the string embedded in the
   * attachmentContext prompt as place_asset's `tmpPath` instruction) to its
   * durable Supabase Storage signed URL. agentLoopService.ts populates this
   * while building attachmentContext, at which point it already re-validates
   * (and, if needed, self-heals) the tempPath -- but that check runs once,
   * before the model has even seen the attachment. If the /tmp file goes
   * missing in the gap between that check and the model actually calling
   * place_asset (confirmed live, project fa6fc688, 2026-08-17: valid when the
   * prompt was built, gone ~20-40s later when place_asset ran, tool failed
   * with no recovery and the run never retried), place_asset had no way to
   * recover -- it only ever saw a bare tmpPath/destName pair. This lets it
   * run the exact same publicUrl self-heal agentLoopService.ts already does,
   * instead of failing hard on a still-valid attachment.
   */
  attachmentPublicUrls?: Map<string, string>;
}

// ─── Anon-fetch detection helper ─────────────────────────────────────────────

// Matches `/rest/v1/<table>`, optionally preceded by a hardcoded tenant-schema
// path segment (`/tenant_xxx/rest/v1/<table>`)   the normal generated-code form
// is `${import.meta.env.VITE_DB_API_URL}/rest/v1/<table>` where the schema
// segment lives inside the env var, not the source literal, but a model can
// also hardcode it, so both forms are matched.
const ANON_FETCH_URL_RE = /(?:tenant_[a-zA-Z0-9_]+\/)?rest\/v1\/([a-zA-Z_][a-zA-Z0-9_]*)/g;
const ANON_KEY_MARKER_RE = /\b(?:VITE_DB_ANON_KEY|DB_ANON_KEY|ANON_KEY)\b/;

/**
 * Extracts table names a piece of frontend source code fetches directly via
 * the anon key. Requires BOTH an anon-key marker AND a `/rest/v1/<table>`
 * path somewhere in the same file content   deliberately not "contains the
 * substring anon anywhere", which would cross-contaminate on unrelated code
 * (a comment, an unrelated identifier). Returns [] for files with no anon-key
 * marker, however many REST-looking paths they contain.
 */
export function extractAnonFetchTables(content: string): string[] {
  if (!ANON_KEY_MARKER_RE.test(content)) return [];
  const tables = new Set<string>();
  ANON_FETCH_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANON_FETCH_URL_RE.exec(content)) !== null) {
    tables.add(m[1].toLowerCase());
  }
  return [...tables];
}

// ─── DB-mutation-tool key derivation ─────────────────────────────────────────

/**
 * Resolves a stable per-retry key for the mutation circuit breaker
 * (ctx.mutationFailureStreak) for the 3 database-action tools. Unlike
 * write_file/edit_file/delete_file/rename_file, none of these have a simple
 * string arg field to key on directly:
 *   - query_database: no natural identity beyond the SQL itself, so the key
 *     is a hash of the (whitespace-normalized) SQL text -- stable across
 *     retries of the identical statement, distinct across different ones.
 *   - confirm_database_change: its own arg is a single-use confirmationId
 *     minted fresh every call, never a stable key on its own -- resolves via
 *     the staged SQL snapshotted in ctx.dbMutationSqlByConfirmationId
 *     (populated by agentToolSet.ts before execute() consumes the pending
 *     entry), hashed the same way as query_database.
 *   - provision_database: no per-call key at all (only an optional
 *     organization_id) -- a project has exactly one hosted DB, so every call
 *     this run shares one fixed constant key.
 * Returns undefined when no stable key can be derived (e.g. the SQL for a
 * confirmationId was never captured) -- callers should skip tracking that
 * call rather than track it under a wrong or empty key.
 */
export function deriveDbMutationKey(toolName: string, args: Record<string, unknown>, ctx: AgentContext): string | undefined {
  if (toolName === 'provision_database') return 'provision_database';
  if (toolName === 'query_database') {
    return typeof args?.sql === 'string' ? hashSql(args.sql) : undefined;
  }
  if (toolName === 'confirm_database_change') {
    const sql = typeof args?.confirmationId === 'string'
      ? ctx.dbMutationSqlByConfirmationId?.get(args.confirmationId)
      : undefined;
    return typeof sql === 'string' ? hashSql(sql) : undefined;
  }
  return undefined;
}

function hashSql(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ─── Tool abstraction ────────────────────────────────────────────────────────

export type ToolResult = string;

export interface ToolDefinition<T = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<T>;
  readonly modifiesState?: boolean;
  execute: (args: T, ctx: AgentContext) => Promise<ToolResult>;
  getConsentPreview?: (args: T) => string;
}

// ─── Path safety helper ──────────────────────────────────────────────────────

/**
 * Joins base + relative path and throws if the result escapes base.
 * Direct port of the Dyad `safeJoin` utility.
 */
export function safeJoin(base: string, relative: string): string {
  const resolved = path.resolve(base, relative);
  const normalized = path.normalize(base);
  if (!resolved.startsWith(normalized + path.sep) && resolved !== normalized) {
    throw new Error(`Path traversal detected: ${relative}`);
  }
  return resolved;
}

// ─── Opaque-binary write guard ───────────────────────────────────────────────
// write_file/edit_file take `content: string` -- the model can only ever
// generate text, so any write to a genuinely opaque binary format (raster
// images, fonts, audio/video, archives) can only be a hallucinated or
// accidental overwrite, never legitimate content. Confirmed live 2026-08-19:
// nothing in either tool guarded this, so a stray write_file/edit_file call
// against an existing image path silently UTF-8-mangled or blanked it --
// place_asset.ts is the one tool that writes these correctly (raw
// arrayBuffer bytes), and is the only legitimate way to add or replace one.
// .svg is deliberately excluded: it's plain XML text, and the model can
// legitimately author one directly.
const OPAQUE_BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.wav', '.ogg', '.webm', '.mov',
  '.pdf', '.zip',
]);

export function isOpaqueBinaryPath(relativePath: string): boolean {
  return OPAQUE_BINARY_EXTS.has(path.extname(relativePath).toLowerCase());
}

// ─── XML escape helpers ──────────────────────────────────────────────────────

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── File read helper ────────────────────────────────────────────────────────

export interface ReadProjectFileResult {
  content: string;
  totalLines: number;
}

/**
 * Resolves, exists-checks, reads, and ledger-records a project file.
 * Shared by read_file and read_files so both stay in sync on this logic.
 */
export function readProjectFile(
  ctx: AgentContext,
  relPath: string
): ReadProjectFileResult | { error: string } {
  const fullPath = safeJoin(ctx.appPath, relPath);
  if (!fs.existsSync(fullPath)) {
    return { error: `File does not exist: ${relPath}` };
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const totalLines = content.split('\n').length;
  ctx.ledger?.recordRead(relPath, totalLines);
  return { content, totalLines };
}

// ─── Reference-scan helper ───────────────────────────────────────────────────

// Exported (not just used by findReferencesToPath below) so replace_asset_references.ts
// can reuse the exact same skip/scan boundaries instead of maintaining a parallel
// set that could silently drift out of sync with delete_file's own scan scope.
export const REF_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '__edge_functions__']);
// .webmanifest added alongside manifest.json   PWA manifests commonly use either
// filename/extension for the same icon-list shape replace_asset_references scans.
export const REF_SCAN_TEXT_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css', '.scss', '.html', '.json', '.webmanifest']);
export const REF_SCAN_MAX_FILES = 2000;

const REF_SCAN_SOURCE_EXTS = /\.(tsx?|jsx?)$/;
export const IMPORT_SPECIFIER_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Resolves an import specifier found in `fromFile` to a project-relative path
 * (no extension), or null if it's a bare package specifier (not a project file).
 */
export function resolveImportSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) {
    return path.posix.normalize(`src/${specifier.slice(2)}`);
  }
  if (specifier.startsWith('.')) {
    const fromDir = path.posix.dirname(fromFile);
    return path.posix.normalize(path.posix.join(fromDir, specifier));
  }
  return null;
}

/**
 * Finds other project files that still reference a given path   either as a
 * code import (`from './logo'`, `from '@/lib/supabase'`) or as an asset path
 * string (`src="/assets/logo.png"`, `url(...)`). Shared by delete_file (where
 * it originated   see that tool's history for the incident this fixed: a
 * deleted logo image left an <img src="..."> pointing at nothing, with no
 * warning) and rename_file (which had no equivalent check at all   a rename
 * could silently break every importer's `from './OldName'`, identified as a
 * real gap in a code-quality audit since delete_file already had this exact
 * protection).
 *
 * Import-specifier resolution (not just substring matching) is required, not
 * optional: confirmed via a live repro that plain substring needles ("supabase.ts",
 * "src/lib/supabase.ts") never match `import { supabase } from '@/lib/supabase'`
 * the extensionless `@/` alias form this codebase's own app-builder prompt tells
 * every generated app to use. A substring-only version of this function would
 * silently miss the exact "deleted file still imported elsewhere" scenario it
 * exists to catch. Resolving each import specifier to a path and comparing it
 * against the target (both extension-stripped) closes that gap; the substring
 * needles remain as a fallback for asset-path references, which aren't import
 * statements and have no specifier to resolve.
 */
export function findReferencesToPath(appPath: string, targetRelPath: string): string[] {
  const basename = path.basename(targetRelPath);
  const targetNoExt = targetRelPath.replace(REF_SCAN_SOURCE_EXTS, '');
  const assetNeedles = [basename, `/${targetRelPath}`, targetRelPath].filter((n, i, arr) => arr.indexOf(n) === i);
  const referencing: string[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    if (scanned >= REF_SCAN_MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned >= REF_SCAN_MAX_FILES) return;
      if (entry.isDirectory()) {
        if (REF_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!REF_SCAN_TEXT_EXTS.has(ext)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(appPath, fullPath).replace(/\\/g, '/');
      if (relPath === targetRelPath) continue;
      scanned++;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');

        let matched = false;
        if (REF_SCAN_SOURCE_EXTS.test(relPath)) {
          IMPORT_SPECIFIER_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = IMPORT_SPECIFIER_RE.exec(content)) !== null) {
            const resolved = resolveImportSpecifier(m[1], relPath);
            if (resolved && (resolved === targetNoExt || resolved === targetRelPath)) {
              matched = true;
              break;
            }
          }
        }
        if (!matched && assetNeedles.some((n) => content.includes(n))) {
          matched = true;
        }
        if (matched) {
          referencing.push(relPath);
        }
      } catch { /* unreadable   skip */ }
    }
  };
  walk(appPath);
  return referencing;
}
