import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface BillingInfo {
  organization_name: string;
  subscription_tier: string;
  stripe_customer_id: string | null;
  current_month: {
    total: number;
    projects: Array<{
      project_id: string;
      project_name: string;
      add_ons: Array<{
        name: string;
        quantity: number;
        unit_price: number;
        cost: number;
      }>;
      total: number;
    }>;
  };
  recent_invoices: Array<{
    id: string;
    invoice_number: string;
    total: number;
    status: string;
    created_at: string;
  }>;
}

export function useOrganizationBilling(organizationId: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['organization-billing', organizationId];

  const { data: billingInfo, isLoading: loading, error } = useQuery({
    queryKey,
    enabled: !!organizationId,
    queryFn: async () => {
      // Get the session from external Supabase (where the user is authenticated)
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      // Call Lovable Cloud Edge Function (where it's deployed) but pass external Supabase token
      const lovableCloudUrl = import.meta.env.VITE_SUPABASE_URL;
      const functionUrl = `${lovableCloudUrl}/functions/v1/get-billing-info?organization_id=${organizationId}`;

      const response = await fetch(functionUrl, {
        method: 'GET',
        headers: {
          'x-external-authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch billing information');
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);
      return data as BillingInfo;
    },
  });

  useEffect(() => {
    if (error) {
      toast({ title: 'Billing Error', description: (error as Error).message || 'Failed to fetch billing information', variant: 'destructive' });
    }
  }, [error]);

  return {
    billingInfo: billingInfo ?? null,
    loading,
    error: error ? (error as Error).message : null,
    refreshBilling: () => queryClient.invalidateQueries({ queryKey })
  };
}
