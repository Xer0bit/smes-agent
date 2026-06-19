import { useEffect, useState, useCallback } from 'react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { fetchOrgLimits, countOrgProjects, type OrgLimits, TIER_FEATURES, TIER_LABELS } from '@/services/subscriptionService';

/** Normalize legacy tier names to canonical form */
export function normalizeTier(tier: string | null | undefined): string {
  const map: Record<string, string> = {
    pro: 'professional', agency: 'enterprise',
    free: 'free', starter: 'starter', professional: 'professional', enterprise: 'enterprise',
  };
  return map[tier ?? 'free'] ?? 'free';
}

interface SubscriptionState {
  limits: OrgLimits | null;
  projectCount: number;
  loading: boolean;
  /** Reload limits from DB */
  refresh: () => Promise<void>;
  /** True if the org can create another project */
  canCreateProject: boolean;
  /** True if the org can invite another member */
  canInviteMember: boolean;
  /** Check a named feature flag for the current plan tier */
  hasFeature: (feature: string) => boolean;
  /** 0-100 percentage of AI eco units used in the current monthly window */
  aiGenPercent: number;
  /** 0-100 percentage of monthly publish lines used */
  publishLinesPercent: number;
  /** Canonical tier name */
  tier: string;
  /** Human-readable plan label */
  tierLabel: string;
  /** True if on any paid plan */
  subscribed: boolean;
  /** Canonical tier name (alias for tier) */
  planTier: string;
}

export function useSubscription(): SubscriptionState {
  const { currentOrganizationId } = useOrganization();
  const [limits, setLimits] = useState<OrgLimits | null>(null);
  const [projectCount, setProjectCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrganizationId) {
      setLimits(null);
      setProjectCount(0);
      return;
    }
    setLoading(true);
    const [l, pc] = await Promise.all([
      fetchOrgLimits(currentOrganizationId),
      countOrgProjects(currentOrganizationId),
    ]);
    setLimits(l);
    setProjectCount(pc);
    setLoading(false);
  }, [currentOrganizationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const canCreateProject = !limits || limits.status === 'active' && projectCount < limits.max_projects;
  const canInviteMember  = !limits || limits.status === 'active' && limits.seats_used < limits.seats_total;

  const hasFeature = useCallback((feature: string): boolean => {
    const tier = normalizeTier(limits?.plan_tier);
    return TIER_FEATURES[tier]?.[feature] ?? false;
  }, [limits]);

  const aiGenPercent = limits && limits.ai_gens_limit > 0
    ? Math.min(100, Math.round((limits.ai_gens_used / limits.ai_gens_limit) * 100))
    : 0;

  const publishLinesPercent = limits && limits.publish_lines_limit > 0
    ? Math.min(100, Math.round(((limits.publish_lines_used ?? 0) / limits.publish_lines_limit) * 100))
    : 0;

  const tier = normalizeTier(limits?.plan_tier);
  const tierLabel = TIER_LABELS[tier] ?? 'Free';
  const subscribed = !!limits && limits.status === 'active' && tier !== 'free';

  return { limits, projectCount, loading, refresh, canCreateProject, canInviteMember, hasFeature, aiGenPercent, publishLinesPercent, tier, tierLabel, subscribed, planTier: tier };
}
