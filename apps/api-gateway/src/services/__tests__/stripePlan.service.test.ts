import { describe, it, expect } from 'vitest';
import { DEFAULT_CATALOG } from '../entitlementsPricing.js';
import { entitlementsFromItems, lookupKey, parseLookupKey } from '../stripePlanPricing.js';

describe('stripe plan mapping', () => {
  it('maps subscription items back to purchased quantities (included + extras)', () => {
    const q = entitlementsFromItems(DEFAULT_CATALOG, [
      { lookup_key: lookupKey('base', 1900), quantity: 1 },
      { lookup_key: lookupKey('apps', 1900), quantity: 2 },
      { lookup_key: lookupKey('databases', 1900), quantity: 1 },
      { lookup_key: 'price_from_some_other_product', quantity: 5 },
    ]);
    expect(q).toEqual({ apps: 3, users: 1, agents: 1, databases: 2 });
  });

  it('lookup keys round-trip and embed the amount', () => {
    expect(lookupKey('users', 1900)).toBe('ecg_users_1900');
    expect(parseLookupKey('ecg_users_1900')).toBe('users');
    expect(parseLookupKey('ecg_users_2500')).toBe('users');
    expect(parseLookupKey('ecg_nope_1900')).toBeNull();
    expect(parseLookupKey(undefined)).toBeNull();
  });
});
