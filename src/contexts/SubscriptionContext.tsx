import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/contexts/OrganizationContext';
import { fetchOrgLimits, type OrgLimits, TIER_FEATURES, TIER_LABELS } from '@/services/subscriptionService';
import { normalizeTier } from '@/hooks/useSubscription';

type PlanTier = string | null;

const PLAN_PRODUCT_IDS: Record<string, string> = {
  starter: 'starter',
  professional: 'professional',
  enterprise: 'enterprise',
  // legacy
  pro: 'professional',
  agency: 'enterprise',
};

interface SubscriptionContextType {
  subscribed: boolean;
  planTier: PlanTier;
  tier: string;
  tierLabel: string;
  status: OrgLimits['status'] | null;
  productId: string | null;
  subscriptionEnd: string | null;
  loading: boolean;
  limits: OrgLimits | null;
  /** 0-100 percentage of monthly publish lines used */
  publishLinesPercent: number;
  hasFeature: (feature: string) => boolean;
  refreshSubscription: () => Promise<void>;
  createCheckout: (priceId: string) => Promise<void>;
  openCustomerPortal: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionContextType | undefined>(undefined);

export const SubscriptionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentOrganizationId } = useOrganization();
  const [subscribed, setSubscribed] = useState(false);
  const [planTier, setPlanTier] = useState<PlanTier>(null);
  const [status, setStatus] = useState<OrgLimits['status'] | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [subscriptionEnd, setSubscriptionEnd] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [limits, setLimits] = useState<OrgLimits | null>(null);
  const { toast } = useToast();

  const resetState = useCallback(() => {
    setSubscribed(false);
    setPlanTier(null);
    setStatus(null);
    setProductId(null);
    setSubscriptionEnd(null);
  }, []);

  const refreshSubscription = useCallback(async () => {
    try {
      setLoading(true);

      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        resetState();
        return;
      }

      if (!currentOrganizationId) {
        resetState();
        return;
      }

      const fetchedLimits = await fetchOrgLimits(currentOrganizationId);
      const nextPlanTier = normalizeTier(fetchedLimits?.plan_tier);
      const nextStatus = fetchedLimits?.status ?? 'active';
      const isPaidOrg = nextStatus === 'active' && nextPlanTier !== 'free';

      setLimits(fetchedLimits);
      setSubscribed(isPaidOrg);
      setPlanTier(nextPlanTier);
      setStatus(nextStatus);
      setProductId(isPaidOrg ? (PLAN_PRODUCT_IDS[nextPlanTier] ?? null) : null);
      setSubscriptionEnd(null);
    } catch (error) {
      console.error('Error checking subscription:', error);
      resetState();
    } finally {
      setLoading(false);
    }
  }, [currentOrganizationId, resetState]);

  const tier = normalizeTier(planTier);
  const tierLabel = TIER_LABELS[tier] ?? 'Free';
  const hasFeature = useCallback((feature: string): boolean => {
    return TIER_FEATURES[tier]?.[feature] ?? false;
  }, [tier]);
  const publishLinesPercent = limits && limits.publish_lines_limit > 0
    ? Math.min(100, Math.round((limits.publish_lines_used / limits.publish_lines_limit) * 100))
    : 0;

  const createCheckout = async (priceId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      if (!currentOrganizationId) throw new Error('No organization selected');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-create-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-external-authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ priceId, organization_id: currentOrganizationId }),
      });

      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(data?.error || 'Failed to create checkout session');

      if (data.url) {
        window.open(data.url, '_blank');
      }
    } catch (error) {
      console.error('Error creating checkout:', error);
      toast({
        title: 'Error',
        description: 'Failed to create checkout session',
        variant: 'destructive',
      });
    }
  };

  const openCustomerPortal = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      if (!currentOrganizationId) throw new Error('No organization selected');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-customer-portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-external-authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrganizationId }),
      });

      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(data?.error || 'Failed to open customer portal');

      if (data.url) {
        window.open(data.url, '_blank');
      }
    } catch (error) {
      console.error('Error opening customer portal:', error);
      toast({
        title: 'Error',
        description: 'Failed to open customer portal',
        variant: 'destructive',
      });
    }
  };

  useEffect(() => {
    refreshSubscription();

    // Re-check on sign-in/sign-out, and on a background 5-minute heartbeat.
    // IMPORTANT: Do NOT call supabase.auth.getSession() (or any auth method) directly
    // inside the onAuthStateChange callback   it can trigger a TOKEN_REFRESHED event
    // which would call refreshSubscription() again, creating an infinite refresh loop.
    // Use setTimeout(0) to defer the call outside the callback execution context.
    const { data: { subscription: authListener } } = supabase.auth.onAuthStateChange(
      (event) => {
        if (event === 'SIGNED_IN') {
          // Defer to next tick so getSession() runs outside the auth callback scope
          setTimeout(() => void refreshSubscription(), 0);
        }
        if (event === 'SIGNED_OUT') {
          resetState();
          setLoading(false);
        }
        // TOKEN_REFRESHED: intentionally not handled   subscription data doesn't change
        // when the JWT rotates, and handling it would call getSession() inside the
        // callback, which is the root cause of the refresh-token loop on the admin page.
      }
    );

    // Background heartbeat every 5 minutes (not 60s   reduces unnecessary edge-fn calls)
    const interval = setInterval(() => void refreshSubscription(), 5 * 60 * 1000);

    return () => {
      authListener.unsubscribe();
      clearInterval(interval);
    };
  }, [refreshSubscription, resetState]);

  return (
    <SubscriptionContext.Provider
      value={{
        subscribed,
        planTier,
        tier,
        tierLabel,
        status,
        productId,
        subscriptionEnd,
        loading,
        limits,
        publishLinesPercent,
        hasFeature,
        refreshSubscription,
        createCheckout,
        openCustomerPortal
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
};

export const useSubscription = () => {
  const context = useContext(SubscriptionContext);
  if (context === undefined) {
    throw new Error('useSubscription must be used within a SubscriptionProvider');
  }
  return context;
};
