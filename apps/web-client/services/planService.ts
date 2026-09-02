/**
 * Plan: the unit-based subscription (base SINGLE plus $19 units).
 * Server: apps/api-gateway/src/routes/plan.routes.ts
 */
import { getApiServerUrl } from '@/config/external-api';
import { lovableCloud } from '@/integrations/supabase/client';

export type Unit = 'apps' | 'users' | 'agents' | 'databases';
export const UNITS: readonly Unit[] = ['apps', 'users', 'agents', 'databases'];
export const UNIT_LABELS: Record<Unit, { singular: string; plural: string }> = {
  apps: { singular: 'App', plural: 'Apps' },
  users: { singular: 'User', plural: 'Users' },
  agents: { singular: 'Agent', plural: 'Agents' },
  databases: { singular: 'Database', plural: 'Databases' },
};

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

export interface EstimateLine {
  unit: Unit | 'base';
  label: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
}

export interface PlanSnapshot {
  catalog: Catalog;
  entitlements: Entitlements;
  usage: Record<Unit, number>;
  estimate: { lines: EstimateLine[]; total_cents: number };
  over: Array<{ unit: Unit; used: number; purchased: number }>;
}

export const DEFAULT_CATALOG: Catalog = {
  id: 'single', name: 'SINGLE', currency: 'USD',
  base_price_cents: 1900, app_price_cents: 1900, user_price_cents: 1900, agent_price_cents: 1900, database_price_cents: 1900,
  included_apps: 1, included_users: 1, included_agents: 1, included_databases: 1,
  included_eco_per_app: 150, overage_policy: 'stop', includes: ['OneNET', 'OneMAIL'],
};

export function unitPriceCents(catalog: Catalog, unit: Unit): number {
  return { apps: catalog.app_price_cents, users: catalog.user_price_cents, agents: catalog.agent_price_cents, databases: catalog.database_price_cents }[unit];
}

export function includedQuantity(catalog: Catalog, unit: Unit): number {
  return { apps: catalog.included_apps, users: catalog.included_users, agents: catalog.included_agents, databases: catalog.included_databases }[unit];
}

export function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(getApiServerUrl(`/api/v1/plan${path}`), { ...init, headers: { ...(await authHeaders()), ...(init.headers ?? {}) } });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

/** Public price list for the landing page (no session needed). */
export async function fetchPublicCatalog(): Promise<Catalog> {
  const res = await fetch(getApiServerUrl("/api/v1/plan/catalog"));
  if (!res.ok) throw new Error(`Catalog unavailable (${res.status})`);
  const body: { catalog: Catalog } = await res.json();
  return body.catalog;
}

export function fetchPlan(orgId: string): Promise<PlanSnapshot> {
  return request<PlanSnapshot>(`/?org_id=${encodeURIComponent(orgId)}`);
}

export function updatePlan(orgId: string, quantities: Partial<Record<Unit, number>>): Promise<PlanSnapshot> {
  return request<PlanSnapshot>('/', { method: 'PATCH', body: JSON.stringify({ org_id: orgId, ...quantities }) });
}

export function fetchCatalog(): Promise<{ catalog: Catalog }> {
  return request<{ catalog: Catalog }>('/admin/catalog');
}

export function updateCatalog(patch: Partial<Catalog>): Promise<{ catalog: Catalog }> {
  return request<{ catalog: Catalog }>('/admin/catalog', { method: 'PATCH', body: JSON.stringify(patch) });
}

export function fetchOrgPlan(orgId: string): Promise<PlanSnapshot> {
  return request<PlanSnapshot>(`/admin/entitlements/${encodeURIComponent(orgId)}`);
}

export function updateOrgEntitlements(orgId: string, patch: Partial<Record<Unit, number>> & { eco_per_app?: number | null }): Promise<PlanSnapshot> {
  return request<PlanSnapshot>(`/admin/entitlements/${encodeURIComponent(orgId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
