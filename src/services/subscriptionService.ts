/**
 * Subscription service — reads plan limits, checks quotas, tracks usage.
 * All reads go through SECURITY DEFINER RPCs (bypasses RLS recursion issues).
 */

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrgLimits {
  plan_tier: 'free' | 'pro' | 'agency' | 'starter' | 'professional' | 'enterprise'; // legacy values kept for compat
  status: 'active' | 'pending_approval' | 'suspended' | 'cancelled';
  seats_total: number;
  seats_used: number;
  max_projects: number;
  ai_gens_used: number;
  ai_gens_limit: number;
  ai_gens_reset_at: string | null;
  publish_lines_used: number;
  publish_lines_limit: number;
  publish_lines_reset_at: string | null;
}

export const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  professional: 'Professional',
  enterprise: 'Enterprise',
  // legacy aliases
  pro: 'Professional',
  agency: 'Enterprise',
};

export const TIER_LIMITS: Record<string, { seats_total: number; max_projects: number; max_orgs: number; ai_gens_limit: number; publish_lines_limit: number }> = {
  free:           { seats_total: 1,   max_projects: 5,      max_orgs: 1,      ai_gens_limit: 10,  publish_lines_limit: 30  },
  starter:        { seats_total: 3,   max_projects: 5,      max_orgs: 999999, ai_gens_limit: 100, publish_lines_limit: 30  },
  professional:   { seats_total: 10,  max_projects: 999999, max_orgs: 999999, ai_gens_limit: 100, publish_lines_limit: 100 },
  enterprise:     { seats_total: 999, max_projects: 999999, max_orgs: 999999, ai_gens_limit: 100, publish_lines_limit: 100 },
  // legacy aliases
  pro:            { seats_total: 10,  max_projects: 999999, max_orgs: 999999, ai_gens_limit: 100, publish_lines_limit: 100 },
  agency:         { seats_total: 999, max_projects: 999999, max_orgs: 999999, ai_gens_limit: 100, publish_lines_limit: 100 },
};

export const TIER_FEATURES: Record<string, Record<string, boolean>> = {
  free: {
    custom_domains: false,
    export_code: false,
    remove_branding: false,
    analytics: false,
    api_access: false,
    invite_editors: false,
    invite_clients: false,
    ai_agent: true,
    hosting: true,
    ali_cloud: false,
    ecomgear_cloud: false,
    integration_app: false,
    auto_pilot: false,
    client_markup: false,
    priority_support: false,
    premium_templates: true,
    sso: false,
    sla: false,
    knowledge_base: false,
  },
  starter: {
    custom_domains: true,
    export_code: true,
    remove_branding: false,
    analytics: false,
    api_access: false,
    invite_editors: true,
    invite_clients: false,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: false,
    client_markup: false,
    priority_support: false,
    premium_templates: true,
    sso: false,
    sla: false,
    knowledge_base: true,
  },
  professional: {
    custom_domains: true,
    export_code: true,
    remove_branding: true,
    analytics: true,
    api_access: true,
    invite_editors: true,
    invite_clients: false,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: true,
    client_markup: false,
    priority_support: false,
    premium_templates: true,
    sso: false,
    sla: false,
    knowledge_base: true,
  },
  enterprise: {
    custom_domains: true,
    export_code: true,
    remove_branding: true,
    analytics: true,
    api_access: true,
    invite_editors: true,
    invite_clients: true,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: true,
    client_markup: true,
    priority_support: true,
    premium_templates: true,
    sso: true,
    sla: true,
    knowledge_base: true,
  },
  // legacy aliases
  pro: {
    custom_domains: true,
    export_code: true,
    remove_branding: true,
    analytics: true,
    api_access: true,
    invite_editors: true,
    invite_clients: false,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: true,
    client_markup: false,
    priority_support: false,
    premium_templates: true,
    sso: false,
    sla: false,
    knowledge_base: true,
  },
  agency: {
    custom_domains: true,
    export_code: true,
    remove_branding: true,
    analytics: true,
    api_access: true,
    invite_editors: true,
    invite_clients: true,
    ai_agent: true,
    hosting: true,
    ali_cloud: true,
    ecomgear_cloud: true,
    integration_app: true,
    auto_pilot: true,
    client_markup: true,
    priority_support: true,
    premium_templates: true,
    sso: true,
    sla: true,
    knowledge_base: true,
  },
};

function normalizeTierName(tier: OrgLimits['plan_tier'] | string | null | undefined): string {
  const normalize: Record<string, string> = {
    pro: 'professional',
    agency: 'enterprise',
  };
  if (!tier) return 'free';
  return normalize[tier] ?? tier;
}

function normalizeOrgLimits(limits: OrgLimits): OrgLimits {
  const normalizedTier = normalizeTierName(limits.plan_tier);
  const defaults = TIER_LIMITS[normalizedTier];

  if (!defaults) return limits;

  const isPaidTier = normalizedTier !== 'free';
  const stalePaidProjectLimit = isPaidTier && limits.max_projects <= 1;

  if (!stalePaidProjectLimit) return limits;

  return {
    ...limits,
    max_projects: defaults.max_projects,
  };
}

// ── Request cache — dedup concurrent calls, 2-min TTL ────────────────────────
// All components share this module-level cache, so mounting 10 components that
// all call fetchOrgLimits() for the same org fires exactly ONE network request.

const CACHE_TTL = 2 * 60 * 1000;

type CacheEntry<T> = { data: T; ts: number };
const limitsCache   = new Map<string, CacheEntry<OrgLimits | null>>();
const projectsCache = new Map<string, CacheEntry<number>>();
const inFlight      = new Map<string, Promise<unknown>>();

function cached<T>(key: string, store: Map<string, CacheEntry<T>>, fetch: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  if (inFlight.has(key)) return inFlight.get(key) as Promise<T>;
  const p = fetch().then((data) => {
    store.set(key, { data, ts: Date.now() });
    inFlight.delete(key);
    return data;
  }).catch((err) => {
    inFlight.delete(key);
    throw err;
  });
  inFlight.set(key, p);
  return p;
}

/** Invalidate cached limits for an org (call after plan changes). */
export function invalidateOrgCache(orgId: string) {
  limitsCache.delete(orgId);
  projectsCache.delete(orgId);
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Fetch the current limits for an org (via SECURITY DEFINER RPC).
 * Results are cached for 2 minutes — concurrent callers share one in-flight request.
 */
export async function fetchOrgLimits(orgId: string): Promise<OrgLimits | null> {
  return cached(`limits:${orgId}`, limitsCache, async () => {
    const { data, error } = await supabase.rpc('get_org_limits', { p_org_id: orgId });
    if (error) {
      console.warn('fetchOrgLimits error:', error.message);
      return null;
    }
    return normalizeOrgLimits(data as OrgLimits);
  });
}

/**
 * Count projects for an org (bypasses RLS).
 * Results are cached for 2 minutes — concurrent callers share one in-flight request.
 */
export async function countOrgProjects(orgId: string): Promise<number> {
  return cached(`projects:${orgId}`, projectsCache, async () => {
    const { data, error } = await supabase.rpc('count_org_projects', { p_org_id: orgId });
    if (error) return 0;
    return (data as number) || 0;
  });
}

/**
 * Check if an org can create another project.
 * Returns { allowed: true } or { allowed: false, reason, upgradeNeeded: tier }
 */
export async function canCreateProject(orgId: string | null): Promise<{
  allowed: boolean;
  reason?: string;
  upgradeNeeded?: string;
}> {
  if (!orgId) return { allowed: true }; // personal projects always allowed

  const [limits, projectCount] = await Promise.all([
    fetchOrgLimits(orgId),
    countOrgProjects(orgId),
  ]);

  if (!limits) return { allowed: true };

  if (limits.status !== 'active') {
    return { allowed: false, reason: `Organization is ${limits.status}. Contact support.` };
  }

  if (projectCount >= limits.max_projects) {
    const next = nextTier(limits.plan_tier);
    return {
      allowed: false,
      reason: `You've reached the ${limits.max_projects} project limit on the ${TIER_LABELS[limits.plan_tier]} plan.`,
      upgradeNeeded: next,
    };
  }

  return { allowed: true };
}

/**
 * Check if an org can invite another member.
 */
export async function canInviteMember(orgId: string): Promise<{
  allowed: boolean;
  reason?: string;
  upgradeNeeded?: string;
}> {
  const limits = await fetchOrgLimits(orgId);
  if (!limits) return { allowed: true };

  if (limits.seats_used >= limits.seats_total) {
    const next = nextTier(limits.plan_tier);
    return {
      allowed: false,
      reason: `You've used all ${limits.seats_total} seats on the ${TIER_LABELS[limits.plan_tier]} plan.`,
      upgradeNeeded: next,
    };
  }
  return { allowed: true };
}

/**
 * Track a usage event (fire-and-forget — won't block the UI).
 */
export function trackUsage(
  userId: string,
  action: string,
  opts: { orgId?: string | null; projectId?: string | null; metadata?: Record<string, unknown> } = {}
): void {
  supabase
    .from('usage_tracking')
    .insert({
      user_id: userId,
      org_id: opts.orgId ?? null,
      project_id: opts.projectId ?? null,
      action,
      metadata: opts.metadata ?? {},
    })
    .then(({ error }) => {
      if (error) console.warn('trackUsage error:', error.message);
    });
}

/**
 * Increment publish-lines counter. Returns false if over monthly quota.
 */
export async function checkAndIncrementPublishLines(orgId: string | null, lines: number = 1): Promise<boolean> {
  if (!orgId) return true;
  const { data, error } = await supabase.rpc('increment_publish_lines', {
    p_org_id: orgId,
    p_lines: Math.max(1, Math.floor(lines)),
  });
  if (error) {
    console.warn('increment_publish_lines error:', error.message);
    return true; // fail open
  }
  return data as boolean;
}

/**
 * Increment usage counter. Returns false if over limit.
 * Call this BEFORE sending to AI — if false, block & show upgrade prompt.
 */
export async function checkAndIncrementAIGen(orgId: string | null, usageUnits: number = 1): Promise<boolean> {
  if (!orgId) return true; // personal / no org — allow freely

  const safeUsageUnits = Math.max(0, usageUnits);
  const { data, error } = await supabase.rpc('increment_ai_gen', {
    p_org_id: orgId,
    p_tokens: safeUsageUnits,
  });

  if (error) {
    // Backward compatibility for deployments where the two-arg RPC isn't migrated yet.
    const legacy = await supabase.rpc('increment_ai_gen', { p_org_id: orgId });
    if (legacy.error) {
      console.warn('increment_ai_gen error:', legacy.error.message);
      return true; // fail open so we don't block users on DB errors
    }
    return legacy.data as boolean;
  }

  return data as boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nextTier(current: string): string {
  // Normalize legacy names to current tier names
  const tier = normalizeTierName(current);
  const order = ['free', 'starter', 'professional', 'enterprise'];
  const idx = order.indexOf(tier);
  return order[Math.min(idx + 1, order.length - 1)];
}

/** Show a toast with upgrade CTA and return false (for consumers to bail out). */
export function showLimitToast(reason: string, upgradeNeeded?: string): false {
  toast.error(reason, {
    description: upgradeNeeded
      ? `Upgrade to ${TIER_LABELS[upgradeNeeded] || upgradeNeeded} to continue.`
      : undefined,
    duration: 6000,
    action: upgradeNeeded
      ? { label: 'Upgrade', onClick: () => { window.location.href = '/dashboard/settings?section=workspace-plans'; } }
      : undefined,
  });
  return false;
}
