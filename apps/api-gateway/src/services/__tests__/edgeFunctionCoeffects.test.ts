/**
 * Coeffect extraction and reactive resolution.
 *
 * The behaviour under test is the one that would have caught CardPro: a
 * function whose declared dependencies are not provided must be reported as
 * unsatisfied at deploy time rather than deploying "successfully" and failing
 * in a customer's browser.
 *
 * The reactive classification (section 3.2) is tested separately from
 * satisfaction because they are different questions. Cordis reloads a fiber
 * precisely when a declared key changes provider, NOT on every context change;
 * a resolution that does not flip satisfaction must stay neutral or every
 * unrelated schema edit churns every function.
 */
import { describe, it, expect } from 'vitest';
import { extractCoeffects, resolveCoeffects, describeUnsatisfied } from '../edgeFunctionCoeffects.js';

const avail = (tables: string[], secrets: string[] = []) => ({
  tables: new Set(tables),
  secrets: new Set(secrets),
});

describe('coeffect extraction', () => {
  it('finds tables across every db verb the runner exposes', () => {
    const code = `
      const u = await db.select('users');
      await db.insert('orders', {});
      await db.update('users', {}, {});
      await db.delete('sessions', {});
      const n = await db.count('orders');
    `;
    expect(extractCoeffects(code).tables).toEqual(['orders', 'sessions', 'users']);
  });

  it('finds secrets by both member and index access', () => {
    const code = `const a = secrets.STRIPE_KEY; const b = secrets['MAIL_TOKEN'];`;
    expect(extractCoeffects(code).secrets).toEqual(['MAIL_TOKEN', 'STRIPE_KEY']);
  });

  it('finds rpc names', () => {
    expect(extractCoeffects(`await db.rpc('register_and_login', {})`).rpcs).toEqual(['register_and_login']);
  });

  it('returns empty sets for a function that touches nothing', () => {
    const c = extractCoeffects(`return { ok: true };`);
    expect(c).toEqual({ tables: [], rpcs: [], secrets: [] });
  });
});

describe('coeffect resolution', () => {
  it('is satisfied when everything is provided', () => {
    const r = resolveCoeffects({ tables: ['users'], rpcs: [], secrets: ['K'] }, avail(['users'], ['K']));
    expect(r.satisfied).toBe(true);
    expect(describeUnsatisfied(r)).toBeNull();
  });

  it('names the missing table -- the CardPro shape', () => {
    // Today this deploys clean and 500s in production; database.service.ts
    // skips a nonexistent table as "not this function's problem".
    const r = resolveCoeffects({ tables: ['users', 'cards'], rpcs: [], secrets: [] }, avail(['users']));
    expect(r.satisfied).toBe(false);
    expect(r.missing.tables).toEqual(['cards']);
    expect(describeUnsatisfied(r)).toMatch(/cards/);
    expect(describeUnsatisfied(r)).toMatch(/do NOT report it as working/i);
  });

  it('names missing secrets without leaking their values', () => {
    const r = resolveCoeffects({ tables: [], rpcs: [], secrets: ['STRIPE_KEY'] }, avail([], []));
    const msg = describeUnsatisfied(r) ?? '';
    expect(msg).toMatch(/STRIPE_KEY/);
    expect(msg).toMatch(/by NAME only/);
  });

  it('does not resolve rpcs, so an rpc alone never blocks', () => {
    const r = resolveCoeffects({ tables: [], rpcs: ['some_fn'], secrets: [] }, avail([]));
    expect(r.satisfied).toBe(true);
    expect(r.missing.rpcs).toEqual([]);
  });
});

describe('reactive classification', () => {
  it('is neutral with no prior state', () => {
    expect(resolveCoeffects({ tables: ['t'], rpcs: [], secrets: [] }, avail(['t'])).change).toBe('neutral');
  });

  it('activates when a missing dependency appears', () => {
    const r = resolveCoeffects({ tables: ['t'], rpcs: [], secrets: [] }, avail(['t']), false);
    expect(r.change).toBe('activating');
  });

  it('deactivates when a satisfied dependency disappears', () => {
    const r = resolveCoeffects({ tables: ['t'], rpcs: [], secrets: [] }, avail([]), true);
    expect(r.change).toBe('deactivating');
  });

  it('stays neutral when satisfaction does not flip', () => {
    // An unrelated table being created must not churn every function.
    expect(resolveCoeffects({ tables: ['t'], rpcs: [], secrets: [] }, avail(['t', 'other']), true).change)
      .toBe('neutral');
    expect(resolveCoeffects({ tables: ['t'], rpcs: [], secrets: [] }, avail(['other']), false).change)
      .toBe('neutral');
  });
});
