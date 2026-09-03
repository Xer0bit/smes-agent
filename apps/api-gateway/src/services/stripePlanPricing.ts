/**
 * Pure Stripe-plan arithmetic (no env, no network): how catalog lines map to
 * Stripe lookup keys and how subscription items map back to entitlements.
 */
import { Catalog, Unit, includedQuantity, unitPriceCents } from './entitlementsPricing.js';

export type LineKey = 'base' | Unit;
export const LABELS: Record<LineKey, string> = { base: 'SINGLE plan', apps: 'Additional App', users: 'Additional User', agents: 'Additional Agent', databases: 'Additional Database' };

/** Lookup key that pins both the line and its amount, e.g. ecg_apps_1900. */
export function lookupKey(key: LineKey, cents: number): string {
  return `ecg_${key}_${cents}`;
}

export function lineAmount(catalog: Catalog, key: LineKey): number {
  return key === 'base' ? catalog.base_price_cents : unitPriceCents(catalog, key);
}

/** Parse a lookup key back into its line; null for foreign prices. */
export function parseLookupKey(lookup: string | null | undefined): LineKey | null {
  const m = /^ecg_(base|apps|users|agents|databases)_\d+$/.exec(lookup ?? '');
  return m ? (m[1] as LineKey) : null;
}

/**
 * Pure: subscription items → purchased quantities. A unit item's quantity is
 * the number of EXTRA units; purchased = included + extras. Units with no
 * item are at the included quantity.
 */
export function entitlementsFromItems(
  catalog: Catalog,
  items: Array<{ lookup_key: string | null | undefined; quantity: number }>,
): Record<Unit, number> {
  const out = { apps: catalog.included_apps, users: catalog.included_users, agents: catalog.included_agents, databases: catalog.included_databases };
  for (const it of items) {
    const key = parseLookupKey(it.lookup_key);
    if (!key || key === 'base') continue;
    out[key] = includedQuantity(catalog, key) + Math.max(0, it.quantity);
  }
  return out;
}

