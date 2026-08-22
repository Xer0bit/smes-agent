/**
 * Recovery ordering and boundary semantics for the effect ledger.
 *
 * Two properties matter and neither is obvious from reading the code:
 *
 * 1. LIFO. Cordis composes inverses as `inverse := value ∘ inverse`
 *    (Algorithm 1), so the most recently registered inverse runs first. An
 *    effect stack recovered oldest-first restores states in an order that never
 *    existed forwards.
 *
 * 2. Halting beats skipping. Recovery stops at an irreversible effect, at an
 *    effect with no registered compensator, and at a compensation that threw.
 *    The tempting alternative -- step over it and keep going -- produces a
 *    state that never existed, silently. Section 6.1 of the paper is explicit
 *    that an effect crossing the system boundary is identity, neither tracked
 *    nor recovered; it does not license reverting *past* one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: any[] = [];
const updates: Array<{ id: number; patch: Record<string, unknown> }> = [];

// Minimal stand-in for the two supabase chains recoverRun uses:
//   .from(t).select(c).eq(..).is(..).order(..)   -> { data, error }
//   .from(t).update(patch).eq('id', n)           -> awaited
vi.mock('../../config/database.js', () => ({
  supabase: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (chain._patch) { updates.push({ id: val as number, patch: chain._patch }); return Promise.resolve({ error: null }); }
          return chain;
        },
        is: () => chain,
        // Must honour the sort argument. A mock that returns `rows` as-inserted
        // makes the LIFO test pass even when the query asks for ascending order
        // -- verified: flipping recoverRun to ascending did not fail this suite
        // until this mock started sorting.
        order: (col: string, opts?: { ascending?: boolean }) => {
          const dir = opts?.ascending ? 1 : -1;
          const sorted = [...rows].sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0));
          return Promise.resolve({ data: sorted, error: null });
        },
        update: (patch: Record<string, unknown>) => { chain._patch = patch; return chain; },
      };
      return chain;
    },
  },
  supabaseAuth: {},
  default: {},
}));

import { recoverRun } from '../effectLedger.js';

function row(seq: number, kind: string, boundary: string) {
  return { id: seq, run_id: 'r1', project_id: 'p1', seq, kind, target: `t${seq}`, boundary, before_state: null, after_state: null };
}

beforeEach(() => { rows.length = 0; updates.length = 0; });

describe('effect ledger recovery', () => {
  it('runs compensations newest-first (LIFO)', async () => {
    // Caller supplies rows already ordered seq DESC, as the query does.
    rows.push(row(3, 'file_write', 'compensable'), row(2, 'file_write', 'compensable'), row(1, 'file_write', 'compensable'));
    const order: string[] = [];
    const out = await recoverRun('r1', { file_write: async (r) => { order.push(r.target); } });
    expect(order).toEqual(['t3', 't2', 't1']);
    expect(out.reverted).toBe(3);
    expect(out.haltedAtBarrier).toBe(false);
  });

  it('marks each recovered effect reverted so recovery is idempotent', async () => {
    rows.push(row(1, 'agent_lock', 'inside'));
    await recoverRun('r1', { agent_lock: async () => {} });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toHaveProperty('reverted_at');
  });

  it('halts at a barrier instead of reverting past it', async () => {
    // Newest first: one revertible, then an irreversible publish, then an older
    // revertible that must be LEFT STANDING.
    rows.push(row(3, 'file_write', 'compensable'), row(2, 'publish', 'barrier'), row(1, 'file_write', 'compensable'));
    const touched: string[] = [];
    const out = await recoverRun('r1', { file_write: async (r) => { touched.push(r.target); } });
    expect(touched).toEqual(['t3']);       // t1 must NOT be reverted
    expect(out.reverted).toBe(1);
    expect(out.haltedAtBarrier).toBe(true);
  });

  it('halts on an effect kind with no registered compensator', async () => {
    // An unknown kind is not a licence to step over it.
    rows.push(row(2, 'mystery_kind', 'compensable'), row(1, 'file_write', 'compensable'));
    const touched: string[] = [];
    const out = await recoverRun('r1', { file_write: async (r) => { touched.push(r.target); } });
    expect(touched).toEqual([]);
    expect(out.haltedAtBarrier).toBe(true);
  });

  it('records the error and halts when a compensation throws', async () => {
    rows.push(row(2, 'file_write', 'compensable'), row(1, 'file_write', 'compensable'));
    const out = await recoverRun('r1', {
      file_write: async (r) => { if (r.seq === 2) throw new Error('disk gone'); },
    });
    expect(out.reverted).toBe(0);
    expect(out.failures).toEqual([{ kind: 'file_write', target: 't2', error: 'disk gone' }]);
    expect(out.haltedAtBarrier).toBe(true);
    // The failure must be persisted -- an unknown-state location that is only
    // in a log line is one deploy away from being invisible.
    expect(updates.some((u) => 'revert_error' in u.patch)).toBe(true);
  });

  it('reports a clean no-op when nothing is standing', async () => {
    const out = await recoverRun('r1', {});
    expect(out).toEqual({ reverted: 0, haltedAtBarrier: false, failures: [] });
  });
});
