import { describe, it, expect } from 'vitest';
import { DEFAULT_CATALOG, estimateMonthly, overCapacity, baseEntitlements } from '../entitlementsPricing.js';

/** The owner's own example: SINGLE plus one extra of each unit = $95/month. */
describe('estimateMonthly', () => {
  it('reproduces the $95 example: base + 1 app + 1 user + 1 agent + 1 database', () => {
    const e = { apps: 2, users: 2, agents: 2, databases: 2 };
    const { lines, total_cents } = estimateMonthly(DEFAULT_CATALOG, e);
    expect(lines.map((l) => `${l.label} $${l.amount_cents / 100}`)).toEqual([
      'Base SINGLE $19', '1 App $19', '1 User $19', '1 Agent $19', '1 Database $19',
    ]);
    expect(total_cents).toBe(9500);
  });

  it('charges only the base for the included quantities', () => {
    const base = baseEntitlements('org', DEFAULT_CATALOG);
    expect(estimateMonthly(DEFAULT_CATALOG, base).total_cents).toBe(1900);
  });

  it('never charges for fewer than included, and pluralises extras', () => {
    const { lines, total_cents } = estimateMonthly(DEFAULT_CATALOG, { apps: 0, users: 4, agents: 1, databases: 1 });
    expect(lines.map((l) => l.label)).toEqual(['Base SINGLE', '3 Users']);
    expect(total_cents).toBe(1900 + 3 * 1900);
  });
});

describe('overCapacity', () => {
  it('names each unit that is over what was bought', () => {
    const over = overCapacity({ apps: 1, users: 1, agents: 1, databases: 1 }, { apps: 2, users: 1, agents: 0, databases: 1 });
    expect(over).toEqual([{ unit: 'apps', used: 2, purchased: 1 }]);
  });
});
