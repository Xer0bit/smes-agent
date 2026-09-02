/**
 * Unit pricing persistence: catalog, entitlements, live usage, capacity checks.
 * The arithmetic lives in entitlementsPricing.ts (pure, tested).
 */
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { Catalog, Entitlements, Unit, Usage, DEFAULT_CATALOG, baseEntitlements, unitPriceCents } from './entitlementsPricing.js';

export * from './entitlementsPricing.js';


export async function getCatalog(planId = 'single'): Promise<Catalog> {
  const { data, error } = await supabase.from('billing_catalog').select('*').eq('id', planId).maybeSingle();
  if (error || !data) {
    if (error) logger.warn('[entitlements] catalog read failed, using defaults', { error: error.message });
    return DEFAULT_CATALOG;
  }
  return data as Catalog;
}

export async function getEntitlements(orgId: string, catalog?: Catalog): Promise<Entitlements> {
  const cat = catalog ?? await getCatalog();
  const { data, error } = await supabase.from('org_entitlements').select('*').eq('org_id', orgId).maybeSingle();
  if (error) logger.warn('[entitlements] read failed, using base plan', { orgId, error: error.message });
  return (data as Entitlements | null) ?? baseEntitlements(orgId, cat);
}

export async function getUsage(orgId: string): Promise<Usage> {
  const { data, error } = await supabase.rpc('org_unit_usage', { p_org_id: orgId });
  if (error || !data) {
    if (error) logger.warn('[entitlements] usage read failed', { orgId, error: error.message });
    return { apps: 0, users: 0, agents: 0, databases: 0 };
  }
  const row = (Array.isArray(data) ? data[0] : data) as Partial<Usage> | undefined;
  return { apps: row?.apps ?? 0, users: row?.users ?? 0, agents: row?.agents ?? 0, databases: row?.databases ?? 0 };
}

export interface CapacityRefusal {
  status: 402;
  code: 'UNIT_LIMIT';
  unit: Unit;
  used: number;
  purchased: number;
  unit_price_cents: number;
  error: string;
}

/**
 * Whether the org may create one more of `unit`. Refusal carries what the
 * client needs to offer the upgrade ("Additional Database × $19/mo").
 */
export async function checkCapacity(orgId: string, unit: Unit): Promise<{ ok: true } | CapacityRefusal> {
  const catalog = await getCatalog();
  const [ent, usage] = await Promise.all([getEntitlements(orgId, catalog), getUsage(orgId)]);
  if (usage[unit] < ent[unit]) return { ok: true };
  const labels: Record<Unit, string> = { apps: 'app', users: 'user', agents: 'agent', databases: 'database' };
  const price = unitPriceCents(catalog, unit);
  return {
    status: 402, code: 'UNIT_LIMIT', unit, used: usage[unit], purchased: ent[unit], unit_price_cents: price,
    error: `This workspace has ${ent[unit]} ${labels[unit]}${ent[unit] === 1 ? '' : 's'} on its plan and is using ${usage[unit]}. ` +
      `Add another ${labels[unit]} for $${(price / 100).toFixed(0)}/month in Settings → Plan.`,
  };
}
