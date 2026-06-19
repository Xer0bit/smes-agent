import { useState, useEffect } from 'react';
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
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchBillingInfo = async () => {
    try {
      setLoading(true);
      setError(null);

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
      
      if (data.error) {
        throw new Error(data.error);
      }

      setBillingInfo(data);
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to fetch billing information';
      setError(errorMessage);
      toast({
        title: 'Billing Error',
        description: errorMessage,
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (organizationId) {
      fetchBillingInfo();
    }
  }, [organizationId]);

  return {
    billingInfo,
    loading,
    error,
    refreshBilling: fetchBillingInfo
  };
}
