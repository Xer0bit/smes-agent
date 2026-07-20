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
  /** URL of the preview service, e.g. http://localhost:3001 */
  previewServiceUrl?: string;
  /** Authenticated user id   required by database_query / get_database_schema to scope tenant DB access. */
  userId?: string;
  /** Tracks how many times query_database has been called in this run, to cap runaway query loops. */
  dbQueryCallCount?: number;
  /** eCG Agents Portal MCP endpoint, present only for projects with MCP enabled at launch. */
  ecgMcp?: { url: string; token?: string };
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

const REF_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '__edge_functions__']);
const REF_SCAN_TEXT_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css', '.scss', '.html', '.json']);
const REF_SCAN_MAX_FILES = 2000;

/**
 * Finds other project files that still reference a given path   either as a
 * code import (`from './logo'`) or as an asset path string (`src="/assets/
 * logo.png"`, `url(...)`). Shared by delete_file (where it originated   see
 * that tool's history for the incident this fixed: a deleted logo image left
 * an <img src="..."> pointing at nothing, with no warning) and rename_file
 * (which had no equivalent check at all   a rename could silently break
 * every importer's `from './OldName'`, identified as a real gap in a code-
 * quality audit since delete_file already had this exact protection).
 */
export function findReferencesToPath(appPath: string, targetRelPath: string): string[] {
  const basename = path.basename(targetRelPath);
  const needles = [basename, `/${targetRelPath}`, targetRelPath].filter((n, i, arr) => arr.indexOf(n) === i);
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
        if (needles.some((n) => content.includes(n))) {
          referencing.push(relPath);
        }
      } catch { /* unreadable   skip */ }
    }
  };
  walk(appPath);
  return referencing;
}
