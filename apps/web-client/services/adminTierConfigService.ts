import { getApiServerUrl } from '@/config/external-api';
import { supabase } from '@/integrations/supabase/adminClient';

export interface TierFeatures {
  custom_domains: boolean;
  remove_branding: boolean;
  export_code: boolean;
  analytics: boolean;
  api_access: boolean;
  invite_editors: boolean;
  invite_clients: boolean;
  ai_agent: boolean;
  hosting: boolean;
  ali_cloud: boolean;
  SMEsAgent_cloud: boolean;
  integration_app: boolean;
  auto_pilot: boolean;
  client_markup: boolean;
  priority_support: boolean;
  sso: boolean;
  sla: boolean;
}

export interface TierLimits {
  ai_gens_limit: number;
  publish_lines_limit: number;
  seats_total: number;
  max_projects: number;
}

export interface TierConfig {
  features: {
    free: TierFeatures;
    pro: TierFeatures;
    agency: TierFeatures;
  };
  limits: {
    free: TierLimits;
    pro: TierLimits;
    agency: TierLimits;
  };
  updatedAt: string;
}

const getAuthHeader = async (): Promise<HeadersInit> => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Admin session missing');
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
};

const readJson = async <T>(response: Response): Promise<T> => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as any)?.error || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
};

export const adminTierConfigService = {
  async getConfig(): Promise<TierConfig> {
    const headers = await getAuthHeader();
    const response = await fetch(getApiServerUrl('/api/v1/system/tier-config'), { headers });
    const payload = await readJson<{ success: boolean; data: TierConfig }>(response);
    return payload.data;
  },

  async saveConfig(input: Partial<TierConfig>): Promise<TierConfig> {
    const headers = await getAuthHeader();
    const response = await fetch(getApiServerUrl('/api/v1/system/tier-config'), {
      method: 'PUT',
      headers,
      body: JSON.stringify(input),
    });
    const payload = await readJson<{ success: boolean; data: TierConfig }>(response);
    return payload.data;
  },
};
