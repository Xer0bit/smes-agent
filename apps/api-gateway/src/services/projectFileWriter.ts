/**
 * The single owner of project file writes -- Phase 3 of spatiotemporal
 * composability adoption.
 *
 * Basis: Shi, Zhang & Cui, "A Programming Paradigm for Spatiotemporal
 * Composability" (PKU + DeepSeek-AI, 2026), section 6.1, which draws the system
 * boundary PER LOCATION rather than per medium:
 *
 *   "a file lies inside when only the system can reach it under a private path,
 *    and outside when it is a path other programs read or write."
 *
 * That sentence is the whole reason this module exists. EcomGear's project
 * files were outside the boundary not because they are files, but because
 * fourteen-plus call sites in api-gateway alone wrote them directly via
 * fs.writeFileSync, with nothing reconciling them. A location with many writers
 * cannot be reverted, because by the time you try, someone else may have moved
 * it underneath you. Reducing the writers to one is what moves the location
 * inside the boundary and makes its effects genuinely trackable.
 *
 * So: every project file write goes through writeProjectFile. Other call sites
 * call it rather than fs. The point is not the wrapper, it is the exclusivity.
 *
 * WHAT THIS DOES NOT PRETEND. A write is only compensable if we actually
 * captured what was there before. When the prior content is too large to hold
 * in the ledger, this records the effect as a `barrier` instead of claiming a
 * compensation it cannot perform -- consistent with effectLedger.ts, where
 * recovery HALTS at a barrier rather than stepping over it. Section 5.1.1 is
 * explicit that the runtime does not verify an inverse inverts; classifying
 * honestly at the point of capture is how we discharge that obligation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeJoin } from '../agent-tools/types.js';
import { recordEffect, EFFECT_KINDS, type Boundary, type LedgerRow } from './effectLedger.js';
import { logger } from '../utils/logger.js';

/**
 * Above this, prior content is not held in the ledger and the write is recorded
 * as an irreversible barrier. Generated source files are far below it; the cap
 * exists so a large binary cannot bloat the ledger row, not to be hit routinely.
 */
export const MAX_CAPTURED_BEFORE_BYTES = 256 * 1024;

/** Marker distinguishing a captured binary payload from captured text. */
const BINARY_PREFIX = 'base64:';

export interface ProjectFileWriteContext {
  appPath: string;
  projectId?: string;
  /** The agent_locks token; absent outside an agent run (e.g. template seeding). */
  runId?: string;
}

export interface WriteProjectFileResult {
  fullPath: string;
  /** False when the write created the file -- its compensation is deletion. */
  existed: boolean;
  boundary: Boundary;
  effectId: number | null;
}

function captureBefore(fullPath: string): { existed: boolean; captured: string | null; tooLarge: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return { existed: false, captured: null, tooLarge: false };
  }
  if (!stat.isFile()) return { existed: false, captured: null, tooLarge: false };
  if (stat.size > MAX_CAPTURED_BEFORE_BYTES) return { existed: true, captured: null, tooLarge: true };

  const buf = fs.readFileSync(fullPath);
  // Round-trip test rather than an extension guess: if the bytes survive a
  // utf8 decode/encode unchanged they are text, otherwise hold them as base64.
  // An extension list would misfile the binary payloads this codebase already
  // carries under source-looking paths.
  const asUtf8 = buf.toString('utf8');
  const isText = Buffer.from(asUtf8, 'utf8').equals(buf);
  return { existed: true, captured: isText ? asUtf8 : BINARY_PREFIX + buf.toString('base64'), tooLarge: false };
}

/**
 * Write a project file, recording it as a tracked effect.
 *
 * The write happens whether or not the ledger accepts the record: an
 * observability layer that can fail the operation it observes is a new outage
 * source. A missing record degrades to the pre-ledger behaviour (untracked),
 * which is the current baseline.
 */
export async function writeProjectFile(
  ctx: ProjectFileWriteContext,
  relPath: string,
  content: string | Buffer,
): Promise<WriteProjectFileResult> {
  const fullPath = safeJoin(ctx.appPath, relPath);
  const { existed, captured, tooLarge } = captureBefore(fullPath);

  // A creation is compensable by deleting what we created (section 6.1 names
  // exactly this as a compensation). An overwrite is compensable only if we
  // hold the prior bytes.
  const boundary: Boundary = !existed || captured !== null ? EFFECT_KINDS.file_write : 'barrier';

  if (tooLarge) {
    logger.warn(
      `[project-writer] prior content of ${relPath} is ${MAX_CAPTURED_BEFORE_BYTES} bytes or more; ` +
      `recording this overwrite as irreversible rather than claiming a compensation we cannot perform.`,
    );
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content as never);

  let effectId: number | null = null;
  if (ctx.runId && ctx.projectId) {
    effectId = await recordEffect({
      runId: ctx.runId,
      projectId: ctx.projectId,
      kind: 'file_write',
      target: relPath,
      boundary,
      beforeState: existed ? { existed: true, content: captured } : { existed: false },
      // The project root travels WITH the effect. Recovery runs in a different
      // process (and a different request) than the write did, at a point where
      // appPath has not been resolved yet -- so a compensator that needed it
      // passed in from outside could never run, and recovery would halt on
      // every file_write. Carrying it on the row keeps the effect
      // self-contained.
      afterState: { appPath: ctx.appPath },
    });
  }

  return { fullPath, existed, boundary, effectId };
}

/**
 * Synchronous variant, for the many existing call sites that write inside
 * synchronous control flow. Threading `await` through those would change their
 * ordering semantics, which is a bigger and riskier edit than this migration
 * should be.
 *
 * The ledger insert is intentionally NOT awaited here. It is best-effort
 * anyway, and recordEffect catches its own failures, so there is no unhandled
 * rejection. Ordering is still exact: `seq` is assigned synchronously by
 * nextSeq before the insert is dispatched, so recovery's LIFO order is fixed at
 * call time even if the inserts themselves land out of order.
 */
export function writeProjectFileSync(
  ctx: ProjectFileWriteContext,
  relPath: string,
  content: string | Buffer,
): WriteProjectFileResult {
  const fullPath = safeJoin(ctx.appPath, relPath);
  const { existed, captured, tooLarge } = captureBefore(fullPath);
  const boundary: Boundary = !existed || captured !== null ? EFFECT_KINDS.file_write : 'barrier';

  if (tooLarge) {
    logger.warn(
      `[project-writer] prior content of ${relPath} is ${MAX_CAPTURED_BEFORE_BYTES} bytes or more; ` +
      `recording this overwrite as irreversible rather than claiming a compensation we cannot perform.`,
    );
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content as never);

  if (ctx.runId && ctx.projectId) {
    void recordEffect({
      runId: ctx.runId,
      projectId: ctx.projectId,
      kind: 'file_write',
      target: relPath,
      boundary,
      beforeState: existed ? { existed: true, content: captured } : { existed: false },
      afterState: { appPath: ctx.appPath },
    });
  }

  return { fullPath, existed, boundary, effectId: null };
}

/**
 * Compensation for a tracked file write: restore the prior bytes, or delete the
 * file when the write created it.
 *
 * Throws rather than swallowing, because a compensation that silently fails
 * leaves the location in a state nobody knows -- effectLedger.ts records the
 * error and halts recovery on a throw, which is the intended outcome.
 */
export async function compensateFileWrite(row: LedgerRow, appPathOverride?: string): Promise<void> {
  const before = row.before_state as { existed?: boolean; content?: string | null } | null;
  const recorded = (row.after_state as { appPath?: string } | null)?.appPath;
  const appPath = appPathOverride ?? recorded;
  if (!appPath) {
    throw new Error(`no project root recorded for ${row.target}; cannot locate the file to restore`);
  }
  const fullPath = safeJoin(appPath, row.target);

  if (!before || before.existed === false) {
    // We created it; deletion restores the prior state exactly.
    try {
      fs.rmSync(fullPath, { force: true });
    } catch (err) {
      throw new Error(`could not delete created file ${row.target}: ${(err as Error).message}`);
    }
    return;
  }

  if (typeof before.content !== 'string') {
    // Recorded as a barrier at capture time, so recovery should have halted
    // before reaching this. Reaching it anyway means the classification and the
    // compensator disagree -- refuse rather than invent content.
    throw new Error(`no captured content for ${row.target}; refusing to guess at its prior state`);
  }

  const payload = before.content.startsWith(BINARY_PREFIX)
    ? Buffer.from(before.content.slice(BINARY_PREFIX.length), 'base64')
    : Buffer.from(before.content, 'utf8');

  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, payload);
  } catch (err) {
    throw new Error(`could not restore ${row.target}: ${(err as Error).message}`);
  }
}
