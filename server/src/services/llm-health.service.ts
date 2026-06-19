/**
 * LLM Health Service
 *
 * Tests each configured LLM provider with a minimal API call on startup.
 * Providers that fail (bad key, no credits, network error) are automatically
 * disabled in the LLM control state so the agent never tries to call them.
 *
 * Admin can re-enable any provider from the Settings panel after resolving
 * the issue, or trigger a re-test via POST /api/v1/ai/test-providers.
 */

import { getLlmControlState, updateLlmControlState } from './llm-control.service.js';
import { logger } from '../utils/logger.js';

// ─── Per-provider test functions ─────────────────────────────────────────────

async function testAnthropic(apiKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 200) return { ok: true, reason: 'OK' };
    if (res.status === 401) return { ok: false, reason: 'Invalid API key (401)' };
    if (res.status === 403) return { ok: false, reason: 'Forbidden — check billing or permissions (403)' };
    if (res.status === 529) return { ok: true, reason: 'Anthropic API overloaded (529) — key valid, transient issue' };
    if (res.status === 400) {
      // 400 is normally "bad request body but key valid", EXCEPT when Anthropic disables the org
      try {
        const body = await res.json() as any;
        const msg: string = body?.error?.message ?? '';
        if (msg.toLowerCase().includes('organization') && msg.toLowerCase().includes('disabled')) {
          return { ok: false, reason: `Anthropic organization disabled: ${msg}` };
        }
      } catch {}
      return { ok: true, reason: 'HTTP 400 — key accepted' };
    }
    // 5xx = server error, not a key issue
    return { ok: true, reason: `HTTP ${res.status} — key accepted` };
  } catch (err: any) {
    // Network/timeout errors at startup are transient — don't disable a valid key
    return { ok: true, reason: `Network check skipped: ${err?.message ?? 'timeout'}` };
  }
}

async function testDeepSeek(apiKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 200) return { ok: true, reason: 'OK' };
    if (res.status === 401) return { ok: false, reason: 'Invalid API key (401)' };
    if (res.status === 402) return { ok: false, reason: 'Insufficient balance — top up DeepSeek account (402)' };
    if (res.status === 403) return { ok: false, reason: 'Forbidden (403)' };
    return { ok: true, reason: `HTTP ${res.status} — key accepted` };
  } catch (err: any) {
    return { ok: true, reason: `Network check skipped: ${err?.message ?? 'timeout'}` };
  }
}

async function testGemini(apiKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (res.status === 200) return { ok: true, reason: 'OK' };
    if (res.status === 400) {
      const body = await res.text().catch(() => '');
      if (body.includes('API key not valid') || body.includes('API_KEY_INVALID')) {
        return { ok: false, reason: 'Invalid API key' };
      }
      return { ok: true, reason: 'HTTP 400 — key accepted' };
    }
    if (res.status === 403) return { ok: false, reason: 'Forbidden — check API key permissions (403)' };
    // 5xx, 429, etc. are transient — key is likely valid
    return { ok: true, reason: `HTTP ${res.status} — key accepted` };
  } catch (err: any) {
    // Network/timeout errors at startup are transient — don't disable a valid key
    return { ok: true, reason: `Network check skipped: ${err?.message ?? 'timeout'}` };
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type ProviderTestResult = {
  ok: boolean;
  reason: string;
  testedAt: string;
};

export type AllProviderResults = {
  anthropic: ProviderTestResult;
  deepseek: ProviderTestResult;
  gemini: ProviderTestResult;
};

// ─── Core: test all providers ─────────────────────────────────────────────────

export async function testAllProviders(): Promise<AllProviderResults> {
  const state = await getLlmControlState();
  const now = new Date().toISOString();

  const noKey = (provider: string) =>
    Promise.resolve({ ok: false, reason: `No ${provider} API key configured` });

  const [anthropic, deepseek, gemini] = await Promise.all([
    state.apiKeys.anthropic ? testAnthropic(state.apiKeys.anthropic) : noKey('Anthropic'),
    state.apiKeys.deepseek  ? testDeepSeek(state.apiKeys.deepseek)   : noKey('DeepSeek'),
    state.apiKeys.gemini    ? testGemini(state.apiKeys.gemini)        : noKey('Gemini'),
  ]);

  return {
    anthropic: { ...anthropic, testedAt: now },
    deepseek:  { ...deepseek,  testedAt: now },
    gemini:    { ...gemini,    testedAt: now },
  };
}

// ─── Startup: test + auto-disable failing providers ───────────────────────────

export async function testAndAutoDisableProviders(): Promise<AllProviderResults> {
  logger.info('[LlmHealth] Testing all configured LLM providers...');

  const results = await testAllProviders();

  // Log every result
  for (const [provider, result] of Object.entries(results) as [string, ProviderTestResult][]) {
    if (result.ok) {
      logger.info(`[LlmHealth] ✓ ${provider}: ${result.reason}`);
    } else {
      logger.warn(`[LlmHealth] ✗ ${provider}: ${result.reason} — disabling`);
    }
  }

  // Apply results: enable providers that pass, disable those that fail.
  // This runs regardless of the current DB state so the live health check
  // always reflects reality after a key change or billing issue.
  await updateLlmControlState({
    providers: {
      anthropic: {
        enabled: results.anthropic.ok,
      },
      deepseek: {
        enabled:         results.deepseek.ok,
        fallbackEnabled: results.deepseek.ok,
      },
      gemini: {
        enabled:         results.gemini.ok,
        fallbackEnabled: results.gemini.ok,
      },
    },
  });

  const passing = (Object.entries(results) as [string, ProviderTestResult][])
    .filter(([, r]) => r.ok).map(([p]) => p);
  const failing = (Object.entries(results) as [string, ProviderTestResult][])
    .filter(([, r]) => !r.ok).map(([p]) => p);

  if (passing.length > 0) logger.info(`[LlmHealth] Enabled providers: ${passing.join(', ')}`);
  if (failing.length > 0) logger.warn(`[LlmHealth] Disabled providers: ${failing.join(', ')} — admin can re-enable from Settings after fixing.`);
  if (passing.length === 0) logger.error('[LlmHealth] No LLM providers are functional. All AI features disabled.');

  return results;
}
