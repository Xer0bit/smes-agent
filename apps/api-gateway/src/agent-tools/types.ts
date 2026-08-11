/**
 * Shared types for the EcomGear Agent Tool system.
 * Express-native port of the Dyad local_agent tools (no Electron / Drizzle deps).
 */

import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
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
   * Tracks how many times edit_file has failed (SEARCH mismatch) per file path.
   * After 2 failures, the tool dispatch blocks edit_file and forces write_file.
   */
  editFailures?: Map<string, number>;
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
   * Turn-scoped staging area for schema-mutating SQL (DDL: CREATE/ALTER/DROP/
   * TRUNCATE) awaiting a confirm_database_change call. query_database stages
   * DDL here instead of executing it immediately   closes the "agent silently
   * altered live schema with zero visibility" gap found in the 2026-08 core-loop
   * audit. Never persisted; abandoned entries just expire with the run.
   */
  pendingDbChanges?: Map<string, { sql: string; createdAt: number }>;
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
