import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useOrganization } from './OrganizationContext';
import { checkAndIncrementAIGen, fetchOrgLimits } from '@/services/subscriptionService';
import { supabase } from '@/integrations/supabase/client';

interface UsageRecord {
  org_id: string;
  plan_tier: 'free' | 'starter' | 'professional' | 'enterprise' | 'pro' | 'agency';
  status: 'active' | 'pending_approval' | 'suspended' | 'cancelled';
  ai_gens_used: number;
  ai_gens_limit: number;
  ai_gens_reset_at: string | null;
}

interface UsageContextType {
  usageRecord: UsageRecord | null;
  loading: boolean;
  refreshUsage: () => Promise<void>;
  applyUsageDelta: (units: number) => void;
  ensureWithinLimit: () => Promise<boolean>;
  trackUsage: (units: number) => Promise<boolean>;
  isWithinLimit: () => boolean;
  getUsagePercentage: () => number;
  getUsageLimit: () => number;
}

const UsageContext = createContext<UsageContextType | undefined>(undefined);

const isBlockedStatus = (status: UsageRecord['status']) =>
  status === 'suspended' || status === 'cancelled';

export const UsageProvider = ({ children }: { children: ReactNode }) => {
  const [usageRecord, setUsageRecord] = useState<UsageRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const { currentOrganizationId } = useOrganization();
  // Track which thresholds we've already alerted this session so we don't spam
  const alertedThresholds = useRef<Set<string>>(new Set());

  const sendQuotaAlert = useCallback(async (used: number, limit: number, level: '80' | '100') => {
    const key = `${currentOrganizationId}-${level}`;
    if (alertedThresholds.current.has(key)) return;
    alertedThresholds.current.add(key);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) return;
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();

      supabase.functions.invoke('quota-alert', {
        body: {
          email: user.email,
          user_name: profile?.full_name || user.email.split('@')[0],
          used,
          limit,
          level,
          plan: usageRecord?.plan_tier ?? 'free',
        },
      }).catch(() => {});
    } catch { /* non-critical */ }
  }, [currentOrganizationId, usageRecord?.plan_tier]);

  const normalizeLimit = useCallback((planTier: UsageRecord['plan_tier'], limit: number): number => {
    // Product policy: free is fixed at 10 eco/month, paid tiers at 100 eco/month.
    const fixed: Record<string, number> = {
      free: 10,
      starter: 100,
      professional: 100,
      enterprise: 100,
      pro: 100,
      agency: 100,
    };
    return fixed[planTier] ?? 10;
  }, []);

  const getUsageLimit = (): number => {
    if (!usageRecord) return 0;
    return normalizeLimit(usageRecord.plan_tier, usageRecord.ai_gens_limit);
  };

  const refreshUsage = useCallback(async () => {
    try {
      setLoading(true);

      if (!currentOrganizationId) {
        setUsageRecord(null);
        return;
      }

      const limits = await fetchOrgLimits(currentOrganizationId);
      if (!limits) {
        setUsageRecord(null);
        return;
      }

      setUsageRecord({
        org_id: currentOrganizationId,
        plan_tier: limits.plan_tier,
        status: limits.status,
        ai_gens_used: limits.ai_gens_used,
        ai_gens_limit: normalizeLimit(limits.plan_tier, limits.ai_gens_limit),
        ai_gens_reset_at: limits.ai_gens_reset_at,
      });
    } catch (error) {
      console.error('Error in refreshUsage:', error);
    } finally {
      setLoading(false);
    }
  }, [currentOrganizationId, normalizeLimit]);

  const applyUsageDelta = useCallback((units: number) => {
    const safeUnits = Number.isFinite(units) ? Math.max(0, units) : 0;
    if (safeUnits <= 0) return;

    setUsageRecord((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        ai_gens_used: prev.ai_gens_used + safeUnits,
      };
    });
  }, []);

  const trackUsage = useCallback(async (units: number = 1): Promise<boolean> => {
    try {
      // 1 eco = 1 code-action request, 0.5 eco = 1 general question.
      const ecoUnits = Math.max(0, units);

      if (!currentOrganizationId) return true;

      const allowed = await checkAndIncrementAIGen(currentOrganizationId, ecoUnits);
      // Refresh local state so the usage bar updates immediately
      await refreshUsage();

      // Fire quota alert emails at 80% and 100% thresholds
      const rec = usageRecord;
      if (rec && rec.ai_gens_limit > 0) {
        const pct = ((rec.ai_gens_used + ecoUnits) / rec.ai_gens_limit) * 100;
        if (pct >= 100) sendQuotaAlert(rec.ai_gens_used + ecoUnits, rec.ai_gens_limit, '100');
        else if (pct >= 80) sendQuotaAlert(rec.ai_gens_used + ecoUnits, rec.ai_gens_limit, '80');
      }

      return allowed;
    } catch (error) {
      console.error('Error in trackUsage:', error);
      // Fail open on transient/network errors so users are not incorrectly blocked.
      return true;
    }
  }, [currentOrganizationId, refreshUsage]);

  const ensureWithinLimit = useCallback(async (): Promise<boolean> => {
    try {
      if (!currentOrganizationId) return true;

      const limits = await fetchOrgLimits(currentOrganizationId);
      if (!limits) return true;

      setUsageRecord({
        org_id: currentOrganizationId,
        plan_tier: limits.plan_tier,
        status: limits.status,
        ai_gens_used: limits.ai_gens_used,
        ai_gens_limit: normalizeLimit(limits.plan_tier, limits.ai_gens_limit),
        ai_gens_reset_at: limits.ai_gens_reset_at,
      });

      if (isBlockedStatus(limits.status as UsageRecord['status'])) return false;
      const effectiveLimit = normalizeLimit(limits.plan_tier, limits.ai_gens_limit);
      if (effectiveLimit < 0) return true;
      return limits.ai_gens_used < effectiveLimit;
    } catch (error) {
      console.error('Error in ensureWithinLimit:', error);
      return true;
    }
  }, [currentOrganizationId, normalizeLimit]);

  const isWithinLimit = (): boolean => {
    if (!usageRecord) return true; // Allow if no record yet
    if (isBlockedStatus(usageRecord.status)) return false;
    if (usageRecord.ai_gens_limit < 0) return true;
    return usageRecord.ai_gens_used < usageRecord.ai_gens_limit;
  };

  const getUsagePercentage = (): number => {
    if (!usageRecord) return 0;
    const effectiveLimit = normalizeLimit(usageRecord.plan_tier, usageRecord.ai_gens_limit);
    if (effectiveLimit <= 0) return 0;
    return Math.min((usageRecord.ai_gens_used / effectiveLimit) * 100, 100);
  };

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  return (
    <UsageContext.Provider
      value={{
        usageRecord,
        loading,
        refreshUsage,
        applyUsageDelta,
        ensureWithinLimit,
        trackUsage,
        isWithinLimit,
        getUsagePercentage,
        getUsageLimit,
      }}
    >
      {children}
    </UsageContext.Provider>
  );
};

export const useUsage = () => {
  const context = useContext(UsageContext);
  if (!context) {
    throw new Error('useUsage must be used within UsageProvider');
  }
  return context;
};
