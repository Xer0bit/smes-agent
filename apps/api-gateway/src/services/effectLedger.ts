/**
 * Effect ledger -- Phase 1 of spatiotemporal composability adoption.
 *
 * Basis: Shi, Zhang & Cui, "A Programming Paradigm for Spatiotemporal
 * Composability" (PKU + DeepSeek-AI, 2026), sections 3.1 and 6.1. This is the
 * durable analogue of Cordis's `ctx.effect` (Algorithm 1): register an effect,
 * get back a disposer, and have inverses compose in LIFO order.
 *
 * The divergence from Cordis is deliberate and is the reason this exists at
 * all. Cordis holds each inverse in a closure chain in process memory, which is
 * sound when a component is *unloaded* -- the chain is alive when recovery
 * runs. Our components are not unloaded, they are SIGKILLed (OOM, `pm2
 * restart`, the 15s force-exit in index.ts). An in-memory inverse dies with the
 * process that registered it. That is not a hypothetical: it is precisely how
 * agent_locks rows leaked and wedged projects behind a false "a generation is
 * already running" for 15 minutes. So the inverse is recorded as DATA that a
 * different process can act on later, not as a closure.
 *
 * What this module does NOT do, on purpose:
 *   - It does not claim every effect is revertible. Section 6.1 draws the
 *     system boundary per location, and effects that cross it (a published
 *     container, a committed DDL migration) are recorded as barriers with no
 *     recovery action. Recovery STOPS at a barrier rather than skipping past
 *     it, because half-reverted state is silent and un-reverted state is loud.
 *   - It does not verify that an inverse inverts. Section 5.1.1 is explicit
 *     that this is "an obligation on the component author rather than a
 *     property the runtime verifies". We discharge that obligation by making
 *     each effect kind declare its boundary class up front (see EFFECT_KINDS)
 *     rather than by assuming.
 */
import { logger } from '../utils/logger.js';

/**
 * The Supabase client is loaded LAZILY rather than imported at module scope.
 *
 * config/database.js throws at import time when SUPABASE_URL is unset. Because
 * projectFileWriter.ts imports this module, and every file-writing agent tool
 * imports that, a static import here would make the entire tool layer refuse to
 * load without database configuration -- which is exactly what it did: adding
 * the import broke edit_file's test suite at collection, not at assertion.
 *
 * A best-effort observability layer must not impose a load-time dependency on
 * its consumers. Resolving it on first use keeps the failure where it belongs:
 * the ledger degrades to unavailable, and the write it was describing still
 * happens.
 */
type Db = Awaited<typeof import('../config/database.js')>['supabase'];
let cachedDb: Db | null | undefined;

async function getDb(): Promise<Db | null> {
  if (cachedDb !== undefined) return cachedDb;
  try {
    cachedDb = (await import('../config/database.js')).supabase;
  } catch (err) {
    logger.warn(`[effect-ledger] database unavailable, effects will not be tracked: ${(err as Error).message}`);
    cachedDb = null;
  }
  return cachedDb;
}

/** Section 6.1's per-location classification. See the migration header. */
export type Boundary = 'inside' | 'compensable' | 'barrier';

export interface EffectRecord {
  runId: string;
  projectId: string;
  seq: number;
  kind: string;
  target: string;
  boundary: Boundary;
  beforeState?: unknown;
  afterState?: unknown;
}

/**
 * The boundary class of every effect kind the agent can produce, decided once
 * here instead of at each call site. Adding a kind without adding it here is a
 * type error, which is the point: a new effect must state whether it can be
 * taken back before it is allowed to happen.
 */
export const EFFECT_KINDS = {
  // -- inside: we hold these exclusively and can restore the prior state ----
  /** A row in agent_locks. We are its sole owner; deleting it fully reverts. */
  agent_lock: 'inside',
  /** A tenant secret we set; the prior value is recorded and restorable. */
  secret_set: 'inside',

  // -- compensable: crosses outside, but a coarser restoring action exists --
  /** A project file write. Compensation is restoring the prior content, which
   *  is only sound once ONE writer owns the path -- see Phase 3. Until then
   *  another writer may have moved it underneath us, so compensation is
   *  best-effort and its failure must be reported, never swallowed. */
  file_write: 'compensable',
  /** A preview push. rollbackProjectSrc already implements the compensation. */
  preview_push: 'compensable',
  /** An edge function deploy. Compensation is redeploying the prior code, or
   *  deleting it when there was no prior version. */
  edge_function_deploy: 'compensable',

  // -- barrier: crosses outside with no compensation we will assert ---------
  /** Schema-mutating SQL committed against live customer data. A down-migration
   *  is not derivable in general, and guessing one on a customer's database is
   *  the worst failure mode available to us. */
  db_migration: 'barrier',
  /** A published site/container. Prior versions may already be serving traffic
   *  and third parties may have observed the emission (section 6.1). */
  publish: 'barrier',
} as const satisfies Record<string, Boundary>;

export type EffectKind = keyof typeof EFFECT_KINDS;

/** Per-run sequence counters. Only an optimisation: the UNIQUE(run_id, seq)
 *  constraint is what actually guarantees ordering, so a counter lost to a
 *  restart cannot corrupt an existing run's ordering, it can only collide --
 *  and a collision is rejected by the database rather than silently accepted. */
const seqCounters = new Map<string, number>();

function nextSeq(runId: string): number {
  const next = (seqCounters.get(runId) ?? 0) + 1;
  seqCounters.set(runId, next);
  return next;
}

/** Drop a finished run's counter so the map cannot grow without bound. */
export function forgetRun(runId: string): void {
  seqCounters.delete(runId);
}

/**
 * Record one effect. Returns the ledger row id, or null if recording failed.
 *
 * Recording is best-effort BY DESIGN and must never fail the operation it
 * describes: a ledger write that could abort an agent run would make the
 * observability layer a new source of outages. An unrecorded effect degrades us
 * to exactly today's behaviour (untracked), which is the current baseline, so
 * the failure mode is "no worse than before" rather than "newly broken".
 */
export async function recordEffect(effect: Omit<EffectRecord, 'seq'> & { seq?: number }): Promise<number | null> {
  const seq = effect.seq ?? nextSeq(effect.runId);
  try {
    const supabase = await getDb();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('agent_run_effects')
      .insert({
        run_id: effect.runId,
        project_id: effect.projectId,
        seq,
        kind: effect.kind,
        target: effect.target,
        boundary: effect.boundary,
        before_state: effect.beforeState ?? null,
        after_state: effect.afterState ?? null,
      })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: number }).id;
  } catch (err) {
    logger.warn(
      `[effect-ledger] failed to record ${effect.kind} on ${effect.target} for run ${effect.runId}: ` +
      `${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Mark one effect as taken back, when the code that owns it reverts it on the
 * normal path rather than through recoverRun. The happy path and the crash path
 * must converge on the same ledger state, otherwise a cleanly-released lock
 * still looks "standing" to every other worker and we have reintroduced the
 * visibility bug in a new place.
 */
export async function markReverted(effectId: number | null): Promise<void> {
  if (effectId === null) return;
  try {
    const supabase = await getDb();
    if (!supabase) return;
    await supabase
      .from('agent_run_effects')
      .update({ reverted_at: new Date().toISOString() })
      .eq('id', effectId);
  } catch (err) {
    // Non-fatal: the row stays standing and recoverRun will find it later.
    // Leaving a reverted effect marked standing is safe (recovery is
    // idempotent); the reverse would not be.
    logger.warn(`[effect-ledger] could not mark effect ${effectId} reverted: ${(err as Error).message}`);
  }
}

/** A recovery action for one effect kind. Returns nothing on success, throws to
 *  report that the location is now in an unknown state. */
export type Compensator = (row: LedgerRow) => Promise<void>;

export interface LedgerRow {
  id: number;
  run_id: string;
  project_id: string;
  seq: number;
  kind: string;
  target: string;
  boundary: Boundary;
  before_state: unknown;
  after_state: unknown;
}

export interface RecoveryOutcome {
  reverted: number;
  /** Effects left standing because recovery hit a barrier and stopped. */
  haltedAtBarrier: boolean;
  /** Effects whose compensation threw. Each one is a location in an unknown
   *  state and is surfaced, never swallowed. */
  failures: Array<{ kind: string; target: string; error: string }>;
}

/**
 * Recover a run's effects in LIFO order, mirroring Algorithm 1's
 * `inverse := value ∘ inverse` composition (newest inverse runs first).
 *
 * Stops at the first barrier. That is a deliberate choice over skipping it:
 * once an irreversible effect is in the middle of the stack, everything older
 * than it was potentially observed by, or built upon, that effect. Reverting
 * past it would produce a state that never existed, silently. Halting leaves
 * the run partially recovered and SAYS SO, which an operator can act on.
 */
export async function recoverRun(
  runId: string,
  compensators: Partial<Record<string, Compensator>>,
): Promise<RecoveryOutcome> {
  const outcome: RecoveryOutcome = { reverted: 0, haltedAtBarrier: false, failures: [] };

  const supabase = await getDb();
  if (!supabase) return outcome;

  const { data, error } = await supabase
    .from('agent_run_effects')
    .select('id, run_id, project_id, seq, kind, target, boundary, before_state, after_state')
    .eq('run_id', runId)
    .is('reverted_at', null)
    .order('seq', { ascending: false });

  if (error) {
    logger.warn(`[effect-ledger] cannot read effects for run ${runId}: ${error.message}`);
    return outcome;
  }

  for (const row of (data ?? []) as LedgerRow[]) {
    if (row.boundary === 'barrier') {
      logger.warn(
        `[effect-ledger] recovery for run ${runId} halted at an irreversible ${row.kind} on ` +
        `${row.target}. ${outcome.reverted} newer effect(s) were reverted; everything older is ` +
        `left standing deliberately -- reverting past a barrier would synthesise a state that ` +
        `never existed.`,
      );
      outcome.haltedAtBarrier = true;
      break;
    }

    const compensate = compensators[row.kind];
    if (!compensate) {
      // No registered recovery action. Treat as a barrier rather than assuming
      // it is safe to continue past an effect we do not know how to undo.
      logger.warn(
        `[effect-ledger] no compensator registered for kind "${row.kind}" (run ${runId}, ` +
        `target ${row.target}) -- halting recovery here rather than stepping over it.`,
      );
      outcome.haltedAtBarrier = true;
      break;
    }

    try {
      await compensate(row);
      await supabase
        .from('agent_run_effects')
        .update({ reverted_at: new Date().toISOString() })
        .eq('id', row.id);
      outcome.reverted++;
    } catch (err) {
      const message = (err as Error).message;
      outcome.failures.push({ kind: row.kind, target: row.target, error: message });
      await supabase
        .from('agent_run_effects')
        .update({ revert_error: message })
        .eq('id', row.id);
      logger.error(
        `[effect-ledger] compensation FAILED for ${row.kind} on ${row.target} (run ${runId}): ` +
        `${message}. That location is now in an unknown state; halting recovery.`,
      );
      // Same reasoning as a barrier: continuing past a failed compensation
      // builds on state we no longer understand.
      outcome.haltedAtBarrier = true;
      break;
    }
  }

  return outcome;
}

/**
 * Effects still standing for a project, newest first. This is the cross-process
 * answer to "what did the last run leave behind?" -- the question the old
 * per-worker activeAgentRuns Map could only answer for its own process, which
 * is what made a live run invisible ~50% of the time under 2 PM2 workers.
 */
export async function standingEffects(projectId: string, limit = 100): Promise<LedgerRow[]> {
  const supabase = await getDb();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('agent_run_effects')
    .select('id, run_id, project_id, seq, kind, target, boundary, before_state, after_state')
    .eq('project_id', projectId)
    .is('reverted_at', null)
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error) {
    logger.warn(`[effect-ledger] cannot read standing effects for ${projectId}: ${error.message}`);
    return [];
  }
  return (data ?? []) as LedgerRow[];
}
