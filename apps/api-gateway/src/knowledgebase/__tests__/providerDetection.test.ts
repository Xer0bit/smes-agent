/**
 * Embedding provider detection, and specifically the GEMINI_API_KEY fallback.
 *
 * The embedder historically read only GOOGLE_GENERATIVE_AI_API_KEY, but the
 * platform sets the same Gemini key as GEMINI_API_KEY (the LLM's name). That
 * one-word naming drift silently dropped the whole system to bm25 -- 1883
 * real embeddings sitting unused in the DB -- with no error anywhere. This
 * test is what keeps semantic retrieval from switching itself off again the
 * next time only one of the two names is present.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getProvider, resetProviderCache } from '../embedder.js';

const saved = {
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};

function setKeys(next: { google?: string; gemini?: string; openai?: string }): void {
  for (const [name, envKey] of [
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ] as const) {
    const value = next[name];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  resetProviderCache();
}

afterEach(() => {
  setKeys(saved);
});

describe('getProvider', () => {
  it('detects google when ONLY GEMINI_API_KEY is set (the naming-drift fix)', () => {
    setKeys({ gemini: 'test-gemini-key' });
    expect(getProvider()).toBe('google');
  });

  it('detects google when the canonical GOOGLE_GENERATIVE_AI_API_KEY is set', () => {
    setKeys({ google: 'test-google-key' });
    expect(getProvider()).toBe('google');
  });

  it('falls back to bm25 only when no embedding key is present', () => {
    setKeys({});
    expect(getProvider()).toBe('bm25');
  });
});
