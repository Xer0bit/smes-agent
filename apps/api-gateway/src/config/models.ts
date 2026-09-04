/**
 * Canonical LLM model registry.
 *
 * Single provider (OpenRouter, OpenAI-compatible endpoint) with exactly two
 * models, chosen by task shape rather than user/billing tier:
 *   - CODE_MODEL:  code generation, edits, fixes, builds   anything that
 *     touches project files.
 *   - CHEAP_MODEL: small tasks   chit-chat, follow-up suggestions,
 *     reranking, narration   anything intentClassifier's isCheapTier flags.
 *
 * `canonicalizeModelId` maps any stale/unknown ID (old picker choice, DB
 * leftover) to one of these two rather than letting a bad value reach the
 * provider.
 */

export type LlmProvider = 'openrouter';

export interface ModelDef {
  id: string;
  provider: LlmProvider;
  label: string;
}

export const CODE_MODEL = 'google/gemini-2.5-flash';
export const CHEAP_MODEL = 'anthropic/claude-3-haiku';

export const CANONICAL_MODELS: ModelDef[] = [
  { id: CODE_MODEL, provider: 'openrouter', label: 'Gemini 2.5 Flash (code)' },
  { id: CHEAP_MODEL, provider: 'openrouter', label: 'Claude 3 Haiku (small tasks)' },
];

export const DEFAULT_PRIMARY_MODEL = CODE_MODEL;
export const DEFAULT_FREE_MODEL = CHEAP_MODEL;
export const DEFAULT_FALLBACK_MODEL = CHEAP_MODEL;

const VALID_IDS = new Set<string>(CANONICAL_MODELS.map((m) => m.id));

export function inferProvider(_model: string): LlmProvider {
  return 'openrouter';
}

/**
 * Normalize any model ID to one of the two canonical ones. Anything that
 * looks like a request for a small/cheap task maps to CHEAP_MODEL; anything
 * else (the common case: code generation) maps to CODE_MODEL.
 */
export function canonicalizeModelId(input: unknown, fallback: string = DEFAULT_PRIMARY_MODEL): string {
  if (typeof input !== 'string') return fallback;

  const id = input.trim().replace(/[}\],;]+$/g, '').trim();
  if (!id) return fallback;

  if (VALID_IDS.has(id)) return id;

  const lower = id.toLowerCase();
  if (lower.includes('flash-lite') || lower.includes('cheap') || lower.includes('mini') || lower.includes('haiku') || lower.includes('flash')) {
    return CHEAP_MODEL;
  }
  return CODE_MODEL;
}
