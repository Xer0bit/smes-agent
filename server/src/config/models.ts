/**
 * Canonical LLM model registry.
 *
 * Single source of truth for valid model IDs across the whole server.
 * Historically, invalid IDs (gemini-3-flash-preview, claude-3-7-sonnet-latest, ...)
 * were hardcoded in 6+ places and persisted to the DB, causing `not_found_error` /
 * 400s at call time. `canonicalizeModelId` maps any known-stale or unknown ID to a
 * valid one so a bad value can never reach a provider.
 *
 * gemini-3.1-pro-preview is a thinking model — it always reasons before responding.
 * Never pass thinkingBudget: 0 to it; it requires maxOutputTokens >= 8000.
 */

export type LlmProvider = 'anthropic' | 'deepseek' | 'gemini';

export interface ModelDef {
  id: string;
  provider: LlmProvider;
  label: string;
}

/** Models surfaced to users (admin settings, model picker). */
export const CANONICAL_MODELS: ModelDef[] = [
  { id: 'gemini-3.1-pro-preview',   provider: 'gemini',    label: 'Gemini 3.1 Pro (Advanced)' },
  { id: 'gemini-2.5-pro',           provider: 'gemini',    label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash',         provider: 'gemini',    label: 'Gemini 2.5 Flash (Fast)' },
  { id: 'deepseek-chat',            provider: 'deepseek',  label: 'DeepSeek (Everyday)' },
  { id: 'claude-sonnet-4-6',        provider: 'anthropic', label: 'Claude (EcomSmart)' },
];

export const DEFAULT_PRIMARY_MODEL = 'gemini-3.1-pro-preview';
export const DEFAULT_FREE_MODEL = 'gemini-2.5-flash';
export const DEFAULT_FALLBACK_MODEL = 'deepseek-chat';

/**
 * IDs that are valid but not shown in the picker.
 */
const EXTRA_VALID_IDS = new Set<string>();

const VALID_IDS = new Set<string>([
  ...CANONICAL_MODELS.map((m) => m.id),
  ...EXTRA_VALID_IDS,
]);

/** Known-stale or invalid IDs → their canonical replacement. */
const STALE_ID_MAP: Record<string, string> = {
  'gemini-2.5-flash-preview':          'gemini-2.5-flash',
  'gemini-3-flash-preview':            'gemini-2.5-flash',
  'gemini-3-flash':                    'gemini-2.5-flash',
  'gemini-3-pro':                      'gemini-3.1-pro-preview',
  'gemini-1.5-flash':                  'gemini-2.5-flash',
  'gemini-1.5-pro':                    'gemini-2.5-pro',
  'claude-3-7-sonnet-latest':          'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022':        'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022-latest': 'claude-sonnet-4-6',
  'claude-sonnet-4-5':                 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514':          'claude-sonnet-4-6',
  'deepseek-reasoner':                 'deepseek-chat',
};

export function inferProvider(model: string): LlmProvider {
  const lower = model.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('gemini')) return 'gemini';
  return 'anthropic';
}

export function isCanonicalModel(id: string): boolean {
  return VALID_IDS.has(id);
}

/**
 * Normalize any model ID to a known-valid one. Returns `fallback` when the
 * input is empty/garbage and can't be mapped by provider family.
 */
export function canonicalizeModelId(input: unknown, fallback: string = DEFAULT_PRIMARY_MODEL): string {
  if (typeof input !== 'string') return fallback;

  // Strip accidental pasted JSON punctuation (e.g. "deepseek-chat}").
  const id = input.trim().replace(/[}\],;]+$/g, '').trim();
  if (!id) return fallback;

  if (VALID_IDS.has(id)) return id;
  if (STALE_ID_MAP[id]) return STALE_ID_MAP[id];

  // Unknown ID — map by provider family to a safe default.
  const lower = id.toLowerCase();
  if (lower.includes('gemini')) {
    return lower.includes('flash') ? DEFAULT_FREE_MODEL : DEFAULT_PRIMARY_MODEL;
  }
  if (lower.includes('deepseek')) return 'deepseek-chat';
  if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('haiku') || lower.includes('opus')) {
    return 'claude-sonnet-4-6';
  }
  return fallback;
}
