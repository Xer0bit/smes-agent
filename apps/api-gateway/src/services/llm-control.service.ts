import { supabase } from '../config/database.js';
import {
  canonicalizeModelId,
  CODE_MODEL,
  CHEAP_MODEL,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_FREE_MODEL,
} from '../config/models.js';

export type LlmProvider = 'openrouter';

export type LlmModelEntry = {
  id: string;
  provider: LlmProvider;
  label?: string;
};

export type LlmControlState = {
  providers: {
    openrouter: { enabled: boolean };
  };
  models: {
    /** Code-generation model (edits/fixes/builds). */
    primary: string;
    /** Kept for API-shape compatibility with the picker/admin UI; same as freeModel. */
    fallback: string;
    /** Small-task model (chit-chat, suggestions, reranking, narration). */
    freeModel: string;
    allowed: LlmModelEntry[];
  };
  apiKeys: {
    openrouter: string;
  };
  updatedAt: string;
};

type PersistedLlmControl = Partial<Omit<LlmControlState, 'updatedAt'>> & {
  updatedAt?: string;
};

const DEFAULT_MODELS: LlmModelEntry[] = [
  { id: CODE_MODEL, provider: 'openrouter', label: 'Qwen3.7 Flash (code)' },
  { id: CHEAP_MODEL, provider: 'openrouter', label: 'Gemini 2.5 Flash Lite (small tasks)' },
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

const inferProvider = (_model: string): LlmProvider => 'openrouter';

const dedupeModels = (models: LlmModelEntry[]): LlmModelEntry[] => {
  const deduped = new Map<string, LlmModelEntry>();
  for (const entry of models) {
    const raw = normalizeModelId(entry.id);
    if (!raw || !isValidModelId(raw)) continue;
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
      openrouter: { enabled: true },
    },
    models: {
      primary,
      fallback,
      freeModel,
      allowed: dedupeModels(baseModels),
    },
    apiKeys: {
      openrouter: process.env.OPENROUTER_API_KEY || '',
    },
    updatedAt: new Date().toISOString(),
  };
};

const mergeWithDefaults = (persisted?: PersistedLlmControl | null): LlmControlState => {
  const defaults = getDefaults();
  if (!persisted) return defaults;

  // Canonicalize persisted values so stale IDs persisted in the DB
  // (from before the OpenRouter migration) are corrected at load.
  const primary = canonicalizeModelId(persisted.models?.primary, defaults.models.primary);
  const fallback = canonicalizeModelId(persisted.models?.fallback, defaults.models.fallback);
  const freeModel = canonicalizeModelId(persisted.models?.freeModel, defaults.models.freeModel || fallback);

  const merged: LlmControlState = {
    providers: {
      openrouter: {
        enabled: persisted.providers?.openrouter?.enabled ?? defaults.providers.openrouter.enabled,
      },
    },
    models: {
      primary,
      fallback,
      freeModel,
      allowed: dedupeModels([...(persisted.models?.allowed || []), ...defaults.models.allowed]),
    },
    apiKeys: {
      openrouter: persisted.apiKeys?.openrouter || defaults.apiKeys.openrouter || '',
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
  if (state.apiKeys.openrouter) process.env.OPENROUTER_API_KEY = state.apiKeys.openrouter;
  // Embeddings (knowledgebase/embedder.ts) still read GEMINI_API_KEY directly
  // for Google's text-embedding-004 -- that's a retrieval concern, not a chat
  // LLM one, and is no longer piped through this admin panel. Set it directly
  // in the environment if embeddings should use Google.
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
      openrouter: {
        enabled: input.providers?.openrouter?.enabled ?? current.providers.openrouter.enabled,
      },
    },
    models: {
      primary,
      fallback,
      freeModel,
      allowed: dedupeModels(input.models?.allowed || current.models.allowed),
    },
    apiKeys: {
      openrouter: input.apiKeys?.openrouter ?? current.apiKeys.openrouter,
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKeys, ...safeState } = state;

  return {
    ...safeState,
    providers: {
      openrouter: {
        ...state.providers.openrouter,
        keyConfigured: Boolean(state.apiKeys.openrouter),
      },
    },
  };
}
