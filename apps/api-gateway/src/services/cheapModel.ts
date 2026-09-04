/**
 * The cheap, fast model used for small side-tasks the main loop should not
 * pay code-model rates for: status narration, request-tier disambiguation,
 * reranking, follow-up suggestions, and anything else that needs a sentence
 * rather than reasoning over project files.
 *
 * Extracted so there is exactly one place this is defined. Two copies would
 * drift on which model/key is actually in use.
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { CHEAP_MODEL } from '../config/models.js';

export interface CheapProvider {
  model: LanguageModel;
  priceTag: string;
}

export function getCheapProvider(): CheapProvider {
  const key = process.env.OPENROUTER_API_KEY || 'missing';
  return {
    model: createOpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' }).chat(CHEAP_MODEL),
    priceTag: CHEAP_MODEL,
  };
}
