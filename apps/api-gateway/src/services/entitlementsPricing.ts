/**
 * Unit pricing: what an organization pays for and what it may create.
 *
 *   Monthly = base + Σ max(0, purchased − included) × unit price
 *
 * `billing_catalog` holds the one price list (base SINGLE, $19 per extra
 * app / user / agent / database, included quantities, fair-use eco per app).
 * `org_entitlements` holds what each org has bought; usage is counted live
 * from the tables that hold the units. Creating a unit past the purchased
 * quantity is refused at the route with a 402 that names the unit.
 */
export type Unit = 'apps' | 'users' | 'agents' | 'databases';
export const UNITS: readonly Unit[] = ['apps', 'users', 'agents', 'databases'];

export interface Catalog {
  id: string;
  name: string;
  currency: string;
  base_price_cents: number;
  app_price_cents: number;
  user_price_cents: number;
  agent_price_cents: number;
  database_price_cents: number;
  included_apps: number;
  included_users: number;
  included_agents: number;
  included_databases: number;
  included_eco_per_app: number;
  overage_policy: 'stop' | 'allow';
  includes: string[];
}

export interface Entitlements {
  org_id: string;
  plan_id: string;
  apps: number;
  users: number;
  agents: number;
  databases: number;
  eco_per_app: number | null;
  source: 'manual' | 'stripe' | 'admin';
}

export type Usage = Record<Unit, number>;

export const DEFAULT_CATALOG: Catalog = {
  id: 'single', name: 'SINGLE', currency: 'USD',
  base_price_cents: 1900, app_price_cents: 1900, user_price_cents: 1900, agent_price_cents: 1900, database_price_cents: 1900,
  included_apps: 1, included_users: 1, included_agents: 1, included_databases: 1,
  included_eco_per_app: 150, overage_policy: 'stop', includes: ['OneNET', 'OneMAIL'],
};

export function unitPriceCents(catalog: Catalog, unit: Unit): number {
  switch (unit) {
    case 'apps': return catalog.app_price_cents;
    case 'users': return catalog.user_price_cents;
    case 'agents': return catalog.agent_price_cents;
    case 'databases': return catalog.database_price_cents;
  }
}

export function includedQuantity(catalog: Catalog, unit: Unit): number {
  switch (unit) {
    case 'apps': return catalog.included_apps;
    case 'users': return catalog.included_users;
    case 'agents': return catalog.included_agents;
    case 'databases': return catalog.included_databases;
  }
}

/** Entitlements an org has when it never bought anything: the base plan. */
export function baseEntitlements(orgId: string, catalog: Catalog): Entitlements {
  return {
    org_id: orgId, plan_id: catalog.id,
    apps: catalog.included_apps, users: catalog.included_users, agents: catalog.included_agents, databases: catalog.included_databases,
    eco_per_app: null, source: 'manual',
  };
}

export interface EstimateLine {
  unit: Unit | 'base';
  label: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
}

/** The "Estimate Monthly Cost" table: base, then one line per extra unit. Pure. */
export function estimateMonthly(catalog: Catalog, e: Pick<Entitlements, Unit>): { lines: EstimateLine[]; total_cents: number } {
  const lines: EstimateLine[] = [{
    unit: 'base', label: `Base ${catalog.name}`, quantity: 1,
    unit_price_cents: catalog.base_price_cents, amount_cents: catalog.base_price_cents,
  }];
  const labels: Record<Unit, string> = { apps: 'App', users: 'User', agents: 'Agent', databases: 'Database' };
  for (const unit of UNITS) {
    const extra = Math.max(0, e[unit] - includedQuantity(catalog, unit));
    if (extra === 0) continue;
    const price = unitPriceCents(catalog, unit);
    lines.push({ unit, label: `${extra} ${labels[unit]}${extra === 1 ? '' : 's'}`, quantity: extra, unit_price_cents: price, amount_cents: extra * price });
  }
  return { lines, total_cents: lines.reduce((n, l) => n + l.amount_cents, 0) };
}

/** Units that are over what was bought, with the numbers a 402 needs. */
export function overCapacity(e: Pick<Entitlements, Unit>, usage: Usage): Array<{ unit: Unit; used: number; purchased: number }> {
  return UNITS.filter((u) => usage[u] > e[u]).map((u) => ({ unit: u, used: usage[u], purchased: e[u] }));
}
