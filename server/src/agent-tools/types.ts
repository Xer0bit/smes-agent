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
  /** Per-run change journal — records every read/write/edit for journal injection into prepareStep. */
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
  /** Authenticated user id — required by database_query / get_database_schema to scope tenant DB access. */
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
