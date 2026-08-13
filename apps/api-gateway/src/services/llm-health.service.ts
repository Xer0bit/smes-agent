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
import { isAuthOrBillingError } from './agentProviderResolution.js';
import { AlertingService } from './alerting.service.js';

// Lifecycle audit finding (2026-08-11/12): today's ~11-hour Anthropic outage
// ("credit balance too low") went undetected by this exact health-check
// system -- testAnthropic's 400 handling only failed on "organization" +
// "disabled" text, so it reported Anthropic healthy the whole time. This repo
// already has a comprehensive, provider-agnostic billing/auth-error text
// classifier (isAuthOrBillingError, used at runtime for the retry/circuit-
// breaker path) that was never reused here -- the two classifiers had
// drifted apart. Route every ambiguous status code through the shared one
// instead of each test function re-inventing its own narrower text match.
function isBillingBodyError(body: unknown): boolean {
  const message = (body as { error?: { message?: string; code?: string | number } } | null)?.error?.message;
  const code = (body as { error?: { message?: string; code?: string | number } } | null)?.error?.code;
  if (!message && code === undefined) return false;
  return isAuthOrBillingError({ data: { error: { message, code } } });
}

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
        model: 'claude-sonnet-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 200) return { ok: true, reason: 'OK' };
    if (res.status === 401) return { ok: false, reason: 'Invalid API key (401)' };
    if (res.status === 403) return { ok: false, reason: 'Forbidden   check billing or permissions (403)' };
    if (res.status === 529) return { ok: true, reason: 'Anthropic API overloaded (529)   key valid, transient issue' };
    if (res.status === 400) {
      // 400 is normally "bad request body but key valid" -- EXCEPT when
      // Anthropic disables the org, OR (the actual incident: "credit
      // balance too low" is a 400, not a 402) any other billing/auth
      // failure the shared classifier already knows how to recognize.
      try {
        const body = await res.json() as any;
        const msg: string = body?.error?.message ?? '';
        if (isBillingBodyError(body)) {
          return { ok: false, reason: `Anthropic billing/auth error: ${msg || 'unknown'}` };
        }
      } catch {}
      return { ok: true, reason: 'HTTP 400   key accepted' };
    }
    // 5xx = server error, not a key issue
    return { ok: true, reason: `HTTP ${res.status}   key accepted` };
  } catch (err: any) {
    // Network/timeout errors at startup are transient   don't disable a valid key
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
    if (res.status === 402) return { ok: false, reason: 'Insufficient balance   top up DeepSeek account (402)' };
    if (res.status === 403) return { ok: false, reason: 'Forbidden (403)' };
    if (res.status === 400 || res.status === 429) {
      try {
        const body = await res.json() as any;
        if (isBillingBodyError(body)) {
          return { ok: false, reason: `DeepSeek billing/auth error: ${body?.error?.message ?? 'unknown'}` };
        }
      } catch {}
    }
    return { ok: true, reason: `HTTP ${res.status}   key accepted` };
  } catch (err: any) {
    return { ok: true, reason: `Network check skipped: ${err?.message ?? 'timeout'}` };
  }
}

async function testGemini(apiKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
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
      const bodyText = await res.text().catch(() => '');
      if (bodyText.includes('API key not valid') || bodyText.includes('API_KEY_INVALID')) {
        return { ok: false, reason: 'Invalid API key' };
      }
      try {
        if (isBillingBodyError(JSON.parse(bodyText))) {
          return { ok: false, reason: `Gemini billing/auth error: ${bodyText.slice(0, 200)}` };
        }
      } catch {}
      return { ok: true, reason: 'HTTP 400   key accepted' };
    }
    if (res.status === 403) return { ok: false, reason: 'Forbidden   check API key permissions (403)' };
    if (res.status === 429) {
      // Most 429s are transient rate limits, but Gemini's monthly quota
      // exhaustion ("You exceeded your current quota...") is ALSO a 429 --
      // isAuthOrBillingError already special-cases this (see its own
      // comment); a plain "429 = transient" assumption would have missed
      // it, same class of bug as the Anthropic 400 case this fix started from.
      try {
        const body = await res.json() as any;
        if (isBillingBodyError(body)) {
          return { ok: false, reason: `Gemini quota exhausted: ${body?.error?.message ?? 'unknown'}` };
        }
      } catch {}
      return { ok: true, reason: 'HTTP 429   transient rate limit, key accepted' };
    }
    // 5xx etc. are transient   key is likely valid
    return { ok: true, reason: `HTTP ${res.status}   key accepted` };
  } catch (err: any) {
    // Network/timeout errors at startup are transient   don't disable a valid key
    return { ok: true, reason: `Network check skipped: ${err?.message ?? 'timeout'}` };
  }
}

async function testZai(apiKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'glm-4.7-flash',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 200) return { ok: true, reason: 'OK' };
    if (res.status === 401) return { ok: false, reason: 'Invalid API key (401)' };
    if (res.status === 402) return { ok: false, reason: 'Insufficient balance (402)' };
    if (res.status === 403) return { ok: false, reason: 'Forbidden (403)' };
    if (res.status === 400 || res.status === 429) {
      // z.ai's own insufficient-balance/no-resource-package signal is error
      // code 1113, not a distinct HTTP status -- isAuthOrBillingError already
      // knows this pattern.
      try {
        const body = await res.json() as any;
        if (isBillingBodyError(body)) {
          return { ok: false, reason: `z.ai billing/auth error: ${body?.error?.message ?? 'unknown'}` };
        }
      } catch {}
    }
    return { ok: true, reason: `HTTP ${res.status}   key accepted` };
  } catch (err: any) {
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
  zai?: ProviderTestResult;
};

// ─── Core: test all providers ─────────────────────────────────────────────────

export async function testAllProviders(): Promise<AllProviderResults> {
  const state = await getLlmControlState();
  const now = new Date().toISOString();

  const noKey = (provider: string) =>
    Promise.resolve({ ok: false, reason: `No ${provider} API key configured` });

  const zaiKey = state.apiKeys.zai || process.env.ZAI_API_KEY || '';
  const [anthropic, deepseek, gemini, zai] = await Promise.all([
    state.apiKeys.anthropic ? testAnthropic(state.apiKeys.anthropic) : noKey('Anthropic'),
    state.apiKeys.deepseek  ? testDeepSeek(state.apiKeys.deepseek)   : noKey('DeepSeek'),
    state.apiKeys.gemini    ? testGemini(state.apiKeys.gemini)        : noKey('Gemini'),
    zaiKey                  ? testZai(zaiKey)                         : noKey('z.ai'),
  ]);

  return {
    anthropic: { ...anthropic, testedAt: now },
    deepseek:  { ...deepseek,  testedAt: now },
    gemini:    { ...gemini,    testedAt: now },
    zai:       { ...zai,       testedAt: now },
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
      logger.warn(`[LlmHealth] ✗ ${provider}: ${result.reason}   disabling`);
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
      zai: {
        enabled: results.zai?.ok ?? true,
      } as any,
    },
  });

  const passing = (Object.entries(results) as [string, ProviderTestResult][])
    .filter(([, r]) => r.ok).map(([p]) => p);
  const failing = (Object.entries(results) as [string, ProviderTestResult][])
    .filter(([, r]) => !r.ok).map(([p]) => p);

  if (passing.length > 0) logger.info(`[LlmHealth] Enabled providers: ${passing.join(', ')}`);
  if (failing.length > 0) logger.warn(`[LlmHealth] Disabled providers: ${failing.join(', ')}   admin can re-enable from Settings after fixing.`);
  if (passing.length === 0) logger.error('[LlmHealth] No LLM providers are functional. All AI features disabled.');

  // Alert only on a genuine ok->not-ok transition (or the very first check,
  // where a null baseline means "no prior state to compare against" -- a
  // server starting with a broken provider is real information, not noise).
  // A provider that was already failing last cycle must NOT re-alert here,
  // or a sustained outage would fire once per hourly cycle indefinitely.
  const previousResultsByProvider = lastResults
    ? new Map(Object.entries(lastResults) as [string, ProviderTestResult][])
    : null;
  for (const [provider, result] of Object.entries(results) as [string, ProviderTestResult][]) {
    if (result.ok) continue;
    const wasAlreadyFailing = previousResultsByProvider?.get(provider)?.ok === false;
    if (!wasAlreadyFailing) {
      await AlertingService.dispatch({ provider, reason: result.reason, severity: 'critical' });
    }
  }

  lastResults = results;
  return results;
}

// ─── Recurring loop + cached read ─────────────────────────────────────────────
// The startup check alone let mid-uptime credit exhaustion go unnoticed for
// hours (Anthropic ran dry at least 9 times Jun 12 - Jul 17 2026 and users
// found out before ops did   production audit 2026-07-21).

let lastResults: AllProviderResults | null = null;
let healthTimer: NodeJS.Timeout | null = null;
const HEALTH_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** Most recent results without triggering a new (billed) probe. */
export function getLastHealthResults(): AllProviderResults | null {
  return lastResults;
}

/** Hourly re-check loop. Idempotent; call once after the startup check. */
export function startLlmHealthLoop(): void {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    testAndAutoDisableProviders().catch((err) =>
      logger.warn('[LlmHealth] Hourly health check failed:', err?.message),
    );
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref?.();
}
