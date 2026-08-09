import { supabase } from '../config/database.js';
import { resetProviderCache } from '../knowledgebase/index.js';
import {
  canonicalizeModelId,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_FREE_MODEL,
} from '../config/models.js';

export type LlmProvider = 'anthropic' | 'deepseek' | 'gemini' | 'zai';

export type LlmModelEntry = {
  id: string;
  provider: LlmProvider;
  label?: string;
};

export type LlmControlState = {
  providers: {
    anthropic: { enabled: boolean; };
    deepseek: { enabled: boolean; fallbackEnabled: boolean; };
    gemini: { enabled: boolean; fallbackEnabled: boolean; };
    zai: { enabled: boolean; };
  };
  models: {
    primary: string;
    fallback: string;
    /** Model served to free-tier users. Defaults to fallback model. */
    freeModel: string;
    allowed: LlmModelEntry[];
  };
  apiKeys: {
    anthropic: string;
    deepseek: string;
    gemini: string;
    zai: string;
  };
  updatedAt: string;
};

type PersistedLlmControl = Partial<Omit<LlmControlState, 'updatedAt'>> & {
  updatedAt?: string;
};

const DEFAULT_MODELS: LlmModelEntry[] = [
  { id: 'gemini-3.1-pro-preview', provider: 'gemini', label: 'Gemini 3.1 Pro (Advanced)' },
  { id: 'gemini-2.5-pro',   provider: 'gemini',   label: 'Gemini 2.5 Pro' },
  { id: 'gemini-flash-latest', provider: 'gemini', label: 'Gemini Flash (Fast, latest)' },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5' },
  { id: 'glm-4.5-flash',    provider: 'zai',      label: 'GLM-4.5 Flash (Free tier)' },
  { id: 'glm-5.2',          provider: 'zai',      label: 'GLM-5.2' },
  { id: 'glm-5',            provider: 'zai',      label: 'GLM-5' },
  { id: 'glm-5-turbo',      provider: 'zai',      label: 'GLM-5 Turbo' },
  { id: 'glm-4.7',          provider: 'zai',      label: 'GLM-4.7' },
  { id: 'glm-4.7-flash',    provider: 'zai',      label: 'GLM-4.7 Flash' },
  { id: 'deepseek-chat',    provider: 'deepseek', label: 'DeepSeek (Everyday)' },
];

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalizeModelId(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    // Guard against accidental pasted JSON punctuation (e.g. deepseek-chat}).
    .replace(/[}\],;]+$/g, '')
    .trim();
}

function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id);
}


const isDeepSeekModel = (model: string): boolean => model.toLowerCase().includes('deepseek');
const isGeminiModel = (model: string): boolean => model.toLowerCase().includes('gemini');
const isZaiModel = (model: string): boolean => model.toLowerCase().startsWith('glm');

const inferProvider = (model: string): LlmProvider => {
  if (isZaiModel(model)) return 'zai';
  if (isDeepSeekModel(model)) return 'deepseek';
  if (isGeminiModel(model)) return 'gemini';
  return 'anthropic';
};

const dedupeModels = (models: LlmModelEntry[]): LlmModelEntry[] => {
  const deduped = new Map<string, LlmModelEntry>();
  for (const entry of models) {
    const raw = normalizeModelId(entry.id);
    if (!raw || !isValidModelId(raw)) continue;
    // Map any stale/invalid ID to its canonical replacement.
    const id = canonicalizeModelId(raw);
    deduped.set(id, { id, provider: inferProvider(id) });
  }
  return Array.from(deduped.values());
};

const getDefaults = (): LlmControlState => {
  const primary = canonicalizeModelId(process.env.AI_MODEL, DEFAULT_PRIMARY_MODEL);
  const fallback = canonicalizeModelId(process.env.AI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL);
  const freeModel = canonicalizeModelId(process.env.FREE_TIER_MODEL, DEFAULT_FREE_MODEL);
  const baseModels = [...DEFAULT_MODELS, { id: primary, provider: inferProvider(primary) }, { id: fallback, provider: inferProvider(fallback) }, { id: freeModel, provider: inferProvider(freeModel) }];

  return {
    providers: {
      anthropic: { enabled: true },
      deepseek: { enabled: true, fallbackEnabled: true },
      gemini: { enabled: true, fallbackEnabled: true },
      zai: { enabled: true },
    },
    models: {
      primary,
      fallback,
      freeModel,
      allowed: dedupeModels(baseModels),
    },
    apiKeys: {
      anthropic: process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      deepseek: process.env.DEEPSEEK_API_KEY || '',
      gemini: process.env.GEMINI_API_KEY || '',
      zai: process.env.ZAI_API_KEY || '',
    },
    updatedAt: new Date().toISOString(),
  };
};

const mergeWithDefaults = (persisted?: PersistedLlmControl | null): LlmControlState => {
  const defaults = getDefaults();
  if (!persisted) return defaults;

  // Canonicalize persisted values so stale IDs persisted in the DB
  // (e.g. claude-3-7-sonnet-latest, gemini-3-flash-preview) are corrected at load.
  const primary = canonicalizeModelId(persisted.models?.primary, defaults.models.primary);
  const fallback = canonicalizeModelId(persisted.models?.fallback, defaults.models.fallback);
  const freeModel = canonicalizeModelId(persisted.models?.freeModel, defaults.models.freeModel || fallback);

  const merged: LlmControlState = {
    providers: {
      anthropic: {
        enabled: persisted.providers?.anthropic?.enabled ?? defaults.providers.anthropic.enabled,
      },
      deepseek: {
        enabled: persisted.providers?.deepseek?.enabled ?? defaults.providers.deepseek.enabled,
        fallbackEnabled: persisted.providers?.deepseek?.fallbackEnabled ?? defaults.providers.deepseek.fallbackEnabled,
      },
      gemini: {
        enabled: persisted.providers?.gemini?.enabled ?? defaults.providers.gemini.enabled,
        fallbackEnabled: persisted.providers?.gemini?.fallbackEnabled ?? defaults.providers.gemini.fallbackEnabled,
      },
      zai: {
        enabled: (persisted.providers as any)?.zai?.enabled ?? defaults.providers.zai.enabled,
      },
    },
    models: {
      primary,
      fallback,
      freeModel,
      allowed: dedupeModels([...(persisted.models?.allowed || []), ...defaults.models.allowed]),
    },
    apiKeys: {
      anthropic: persisted.apiKeys?.anthropic || defaults.apiKeys.anthropic || '',
      deepseek: persisted.apiKeys?.deepseek || defaults.apiKeys.deepseek || '',
      gemini: persisted.apiKeys?.gemini || defaults.apiKeys.gemini || '',
      zai: (persisted.apiKeys as any)?.zai || defaults.apiKeys.zai || '',
    },
    updatedAt: persisted.updatedAt || defaults.updatedAt,
  };

  if (!merged.models.allowed.some((entry) => entry.id === merged.models.primary)) {
    merged.models.allowed.push({ id: merged.models.primary, provider: inferProvider(merged.models.primary) });
  }
  if (!merged.models.allowed.some((entry) => entry.id === merged.models.fallback)) {
    merged.models.allowed.push({ id: merged.models.fallback, provider: inferProvider(merged.models.fallback) });
  }

  merged.models.allowed = dedupeModels(merged.models.allowed);
  return merged;
};

const applyRuntimeEnv = (state: LlmControlState): void => {
  process.env.AI_MODEL = state.models.primary;
  process.env.AI_FALLBACK_MODEL = state.models.fallback;
  
  if (state.apiKeys.anthropic) process.env.AI_ANTHROPIC_API_KEY = state.apiKeys.anthropic;
  if (state.apiKeys.deepseek) process.env.DEEPSEEK_API_KEY = state.apiKeys.deepseek;
  if (state.apiKeys.zai) process.env.ZAI_API_KEY = state.apiKeys.zai;
  if (state.apiKeys.gemini) {
    process.env.GEMINI_API_KEY = state.apiKeys.gemini;
    // KB vector store uses GOOGLE_GENERATIVE_AI_API_KEY for 768-dim text-embedding-004
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = state.apiKeys.gemini;
    // Reset cached provider so embedder re-detects 'google' instead of staying on 'bm25'
    resetProviderCache();
  }
};

async function loadPersisted(): Promise<PersistedLlmControl | null> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'llm_control')
      .maybeSingle();

    if (error) {
      console.warn('[LlmControl] Failed to load from DB, using defaults:', error.message);
      return null;
    }
    return (data?.value ?? null) as PersistedLlmControl | null;
  } catch (err) {
    console.warn('[LlmControl] DB unavailable, using defaults:', err);
    return null;
  }
}

async function savePersisted(state: LlmControlState): Promise<void> {
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { key: 'llm_control', value: state as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) {
    throw new Error(`[LlmControl] Failed to save to DB: ${error.message}`);
  }
}

export async function getLlmControlState(): Promise<LlmControlState> {
  const persisted = await loadPersisted();
  const state = mergeWithDefaults(persisted);
  applyRuntimeEnv(state);
  return state;
}

export async function updateLlmControlState(input: Partial<LlmControlState>): Promise<LlmControlState> {
  const current = await getLlmControlState();
  const requestedPrimary = normalizeModelId(input.models?.primary || current.models.primary);
  const requestedFallback = normalizeModelId(input.models?.fallback || current.models.fallback);
  const requestedFreeModel = normalizeModelId(input.models?.freeModel || current.models.freeModel || current.models.fallback);
  const primary = isValidModelId(requestedPrimary)
    ? canonicalizeModelId(requestedPrimary, current.models.primary)
    : current.models.primary;
  const fallback = isValidModelId(requestedFallback)
    ? canonicalizeModelId(requestedFallback, current.models.fallback)
    : current.models.fallback;
  const freeModel = isValidModelId(requestedFreeModel)
    ? canonicalizeModelId(requestedFreeModel, fallback)
    : fallback;

  const next: LlmControlState = {
    providers: {
      anthropic: {
        enabled: input.providers?.anthropic?.enabled ?? current.providers.anthropic.enabled,
      },
      deepseek: {
        enabled: input.providers?.deepseek?.enabled ?? current.providers.deepseek.enabled,
        fallbackEnabled: input.providers?.deepseek?.fallbackEnabled ?? current.providers.deepseek.fallbackEnabled,
      },
      gemini: {
        enabled: input.providers?.gemini?.enabled ?? current.providers.gemini.enabled,
        fallbackEnabled: input.providers?.gemini?.fallbackEnabled ?? current.providers.gemini.fallbackEnabled,
      },
      zai: {
        enabled: (input.providers as any)?.zai?.enabled ?? current.providers.zai.enabled,
      },
    },
    models: {
      primary,
      fallback,
      freeModel,
      allowed: dedupeModels(input.models?.allowed || current.models.allowed),
    },
    apiKeys: {
      anthropic: input.apiKeys?.anthropic ?? current.apiKeys.anthropic,
      deepseek: input.apiKeys?.deepseek ?? current.apiKeys.deepseek,
      gemini: input.apiKeys?.gemini ?? current.apiKeys.gemini,
      zai: (input.apiKeys as any)?.zai ?? current.apiKeys.zai,
    },
    updatedAt: new Date().toISOString(),
  };

  if (!next.models.allowed.some((entry) => entry.id === next.models.primary)) {
    next.models.allowed.push({ id: next.models.primary, provider: inferProvider(next.models.primary) });
  }
  if (!next.models.allowed.some((entry) => entry.id === next.models.fallback)) {
    next.models.allowed.push({ id: next.models.fallback, provider: inferProvider(next.models.fallback) });
  }
  next.models.allowed = dedupeModels(next.models.allowed);

  await savePersisted(next);
  applyRuntimeEnv(next);
  return next;
}

export async function addLlmModel(entry: LlmModelEntry): Promise<LlmControlState> {
  const id = normalizeModelId(entry.id);
  if (!isValidModelId(id)) {
    throw new Error(`Invalid model id: ${entry.id}`);
  }
  const canonicalId = canonicalizeModelId(id);
  const current = await getLlmControlState();
  const allowed = dedupeModels([...current.models.allowed, { ...entry, id: canonicalId, provider: inferProvider(canonicalId) }]);
  return updateLlmControlState({ ...current, models: { ...current.models, allowed } });
}

export async function removeLlmModel(id: string): Promise<LlmControlState> {
  const current = await getLlmControlState();
  const canonicalId = canonicalizeModelId(id, id);
  const allowed = current.models.allowed.filter((entry) => entry.id !== canonicalId);
  return updateLlmControlState({ ...current, models: { ...current.models, allowed } });
}

export async function getLlmStatusPayload(): Promise<Record<string, unknown>> {
  const state = await getLlmControlState();
  
  // Create safe payload omitting raw API keys
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKeys, ...safeState } = state;

  return {
    ...safeState,
    providers: {
      anthropic: {
        ...state.providers.anthropic,
        keyConfigured: Boolean(state.apiKeys.anthropic),
      },
      deepseek: {
        ...state.providers.deepseek,
        keyConfigured: Boolean(state.apiKeys.deepseek),
      },
      gemini: {
        ...state.providers.gemini,
        keyConfigured: Boolean(state.apiKeys.gemini),
      },
      zai: {
        ...state.providers.zai,
        keyConfigured: Boolean(state.apiKeys.zai),
      },
    },
  };
}

/**
 * Returns 'paid' if the user belongs to at least one org with a paid plan
 * (pro / agency / professional / enterprise). Otherwise returns 'free'.
 * Defaults to 'free' on any DB error so the restrictive path is always safe.
 */
export async function getUserPlanTier(userId: string): Promise<'free' | 'paid'> {
  try {
    const { data: memberships, error: memberError } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', userId);

    if (memberError || !memberships || memberships.length === 0) return 'free';

    const orgIds = memberships.map((m: { org_id: string }) => m.org_id);

    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('plan_tier')
      .in('id', orgIds);

    if (orgError || !orgs) return 'free';

    const PAID_TIERS = ['starter', 'pro', 'agency', 'professional', 'enterprise'];
    const hasPaid = orgs.some((o: { plan_tier: string }) => PAID_TIERS.includes(o.plan_tier));
    return hasPaid ? 'paid' : 'free';
  } catch {
    return 'free';
  }
}
