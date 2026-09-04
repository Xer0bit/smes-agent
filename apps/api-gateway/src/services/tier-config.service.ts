import { supabase } from '../config/database.js';

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

const DEFAULT_CONFIG: TierConfig = {
  features: {
    free: {
      custom_domains: false, remove_branding: false, export_code: false,
      analytics: false, api_access: false, invite_editors: false,
      invite_clients: false, ai_agent: true, hosting: true,
      ali_cloud: false, SMEsAgent_cloud: false, integration_app: false,
      auto_pilot: false, client_markup: false, priority_support: false,
      sso: false, sla: false,
    },
    pro: {
      custom_domains: true, remove_branding: true, export_code: true,
      analytics: true, api_access: true, invite_editors: true,
      invite_clients: false, ai_agent: true, hosting: true,
      ali_cloud: true, SMEsAgent_cloud: true, integration_app: true,
      auto_pilot: true, client_markup: false, priority_support: false,
      sso: false, sla: false,
    },
    agency: {
      custom_domains: true, remove_branding: true, export_code: true,
      analytics: true, api_access: true, invite_editors: true,
      invite_clients: true, ai_agent: true, hosting: true,
      ali_cloud: true, SMEsAgent_cloud: true, integration_app: true,
      auto_pilot: true, client_markup: true, priority_support: true,
      sso: true, sla: true,
    },
  },
  limits: {
    free:   { ai_gens_limit: 10,  publish_lines_limit: 30,  seats_total: 1,  max_projects: 1      },
    pro:    { ai_gens_limit: 100, publish_lines_limit: 100, seats_total: 5,  max_projects: 999999 },
    agency: { ai_gens_limit: 100, publish_lines_limit: 100, seats_total: 20, max_projects: 999999 },
  },
  updatedAt: new Date().toISOString(),
};

function normalizeTierConfig(config: TierConfig): TierConfig {
  // Product policy: free tier eco is fixed at 10/month; paid tiers are 100/month.
  return {
    ...config,
    limits: {
      ...config.limits,
      free: {
        ...config.limits.free,
        ai_gens_limit: 10,
      },
      pro: {
        ...config.limits.pro,
        ai_gens_limit: 100,
      },
      agency: {
        ...config.limits.agency,
        ai_gens_limit: 100,
      },
    },
  };
}

export async function getTierConfig(): Promise<TierConfig> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'tier_config')
      .maybeSingle();

    if (error || !data?.value) return normalizeTierConfig(DEFAULT_CONFIG);

    const persisted = data.value as Partial<TierConfig>;
    return normalizeTierConfig({
      features: {
        free:   { ...DEFAULT_CONFIG.features.free,   ...(persisted.features?.free   || {}) },
        pro:    { ...DEFAULT_CONFIG.features.pro,    ...(persisted.features?.pro    || {}) },
        agency: { ...DEFAULT_CONFIG.features.agency, ...(persisted.features?.agency || {}) },
      },
      limits: {
        free:   { ...DEFAULT_CONFIG.limits.free,   ...(persisted.limits?.free   || {}) },
        pro:    { ...DEFAULT_CONFIG.limits.pro,    ...(persisted.limits?.pro    || {}) },
        agency: { ...DEFAULT_CONFIG.limits.agency, ...(persisted.limits?.agency || {}) },
      },
      updatedAt: persisted.updatedAt || DEFAULT_CONFIG.updatedAt,
    });
  } catch {
    return normalizeTierConfig(DEFAULT_CONFIG);
  }
}

export async function saveTierConfig(input: Partial<TierConfig>): Promise<TierConfig> {
  const current = await getTierConfig();
  const next = normalizeTierConfig({
    features: {
      free:   { ...current.features.free,   ...(input.features?.free   || {}) },
      pro:    { ...current.features.pro,    ...(input.features?.pro    || {}) },
      agency: { ...current.features.agency, ...(input.features?.agency || {}) },
    },
    limits: {
      free:   { ...current.limits.free,   ...(input.limits?.free   || {}) },
      pro:    { ...current.limits.pro,    ...(input.limits?.pro    || {}) },
      agency: { ...current.limits.agency, ...(input.limits?.agency || {}) },
    },
    updatedAt: new Date().toISOString(),
  });

  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { key: 'tier_config', value: next as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) throw new Error(`Failed to save tier config: ${error.message}`);
  return next;
}
