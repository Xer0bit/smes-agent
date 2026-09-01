/**
 * The cheap, fast model used for small side-questions the main loop should not
 * pay for: status narration, request-tier disambiguation, and anything else that
 * needs a sentence rather than reasoning.
 *
 * Extracted so there is exactly one provider-fallback chain. Two copies would
 * drift on the AI_DISABLE_* switches, and a side-call that ignores those
 * switches keeps hitting a provider ops has deliberately turned off.
 */
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

export interface CheapProvider {
  model: LanguageModel;
  priceTag: string;
}

export function getCheapProvider(): CheapProvider {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && process.env.AI_DISABLE_GEMINI !== '1') {
    return { model: createGoogleGenerativeAI({ apiKey: geminiKey })('gemini-flash-latest'), priceTag: 'gemini-flash-latest' };
  }
  const zaiKey = process.env.ZAI_API_KEY;
  if (zaiKey && process.env.AI_DISABLE_ZAI !== '1') {
    return { model: createOpenAI({ apiKey: zaiKey, baseURL: 'https://api.z.ai/api/paas/v4' }).chat('glm-4.5-flash'), priceTag: 'glm-4.5-flash' };
  }
  const anthropicKey = process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && process.env.AI_DISABLE_ANTHROPIC !== '1') {
    return { model: createAnthropic({ apiKey: anthropicKey })('claude-haiku-4-5-20251001'), priceTag: 'claude-haiku-4-5-20251001' };
  }
  // Nothing configured: hand back the Gemini shape so callers fail on the call
  // itself (which every caller already handles) rather than on a null model.
  return { model: createGoogleGenerativeAI({ apiKey: geminiKey || 'missing' })('gemini-flash-latest'), priceTag: 'gemini-flash-latest' };
}
