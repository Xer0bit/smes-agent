/**
 * LLM Health Service
 *
 * Tests the configured OpenRouter key with a minimal API call on startup and
 * hourly thereafter. If it fails (bad key, no credits, network error), the
 * provider is automatically disabled in the LLM control state so the agent
 * never tries to call it.
 *
 * Admin can re-enable from the Settings panel after resolving the issue, or
 * trigger a re-test via POST /api/v1/ai/test-providers.
 */

import { getLlmControlState, updateLlmControlState } from './llm-control.service.js';
import { logger } from '../utils/logger.js';
import { isAuthOrBillingError } from './agentProviderResolution.js';
import { CHEAP_MODEL } from '../config/models.js';
import { AlertingService } from './alerting.service.js';

function isBillingBodyError(body: unknown): boolean {
  const message = (body as { error?: { message?: string; code?: string | number } } | null)?.error?.message;
  const code = (body as { error?: { message?: string; code?: string | number } } | null)?.error?.code;
  if (!message && code === undefined) return false;
  return isAuthOrBillingError({ data: { error: { message, code } } });
}

async function testOpenRouter(apiKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CHEAP_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 200) return { ok: true, reason: 'OK' };
    if (res.status === 401) return { ok: false, reason: 'Invalid API key (401)' };
    if (res.status === 402) return { ok: false, reason: 'Insufficient balance   top up OpenRouter account (402)' };
    if (res.status === 403) return { ok: false, reason: 'Forbidden (403)' };
    if (res.status === 400 || res.status === 429) {
      try {
        const body = await res.json() as any;
        if (isBillingBodyError(body)) {
          return { ok: false, reason: `OpenRouter billing/auth error: ${body?.error?.message ?? 'unknown'}` };
        }
      } catch {}
    }
    return { ok: true, reason: `HTTP ${res.status}   key accepted` };
  } catch (err: any) {
    // Network/timeout errors at startup are transient   don't disable a valid key
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
  openrouter: ProviderTestResult;
};

// ─── Core: test the provider ───────────────────────────────────────────────────

export async function testAllProviders(): Promise<AllProviderResults> {
  const state = await getLlmControlState();
  const now = new Date().toISOString();

  const openrouter = state.apiKeys.openrouter
    ? await testOpenRouter(state.apiKeys.openrouter)
    : { ok: false, reason: 'No OpenRouter API key configured' };

  return { openrouter: { ...openrouter, testedAt: now } };
}

// ─── Startup: test + auto-disable failing provider ────────────────────────────

export async function testAndAutoDisableProviders(): Promise<AllProviderResults> {
  logger.info('[LlmHealth] Testing OpenRouter...');

  const results = await testAllProviders();

  if (results.openrouter.ok) {
    logger.info(`[LlmHealth] ✓ openrouter: ${results.openrouter.reason}`);
  } else {
    logger.warn(`[LlmHealth] ✗ openrouter: ${results.openrouter.reason}   disabling`);
  }

  await updateLlmControlState({
    providers: {
      openrouter: { enabled: results.openrouter.ok },
    },
  });

  if (!results.openrouter.ok) {
    logger.error('[LlmHealth] OpenRouter is not functional. All AI features disabled.');
  }

  // Alert only on a genuine ok->not-ok transition (or the very first check,
  // where a null baseline means "no prior state to compare against" -- a
  // server starting with a broken provider is real information, not noise).
  const wasAlreadyFailing = lastResults?.openrouter.ok === false;
  if (!results.openrouter.ok && !wasAlreadyFailing) {
    try {
      await AlertingService.dispatch({ provider: 'openrouter', reason: results.openrouter.reason, severity: 'critical' });
    } catch (alertErr) {
      logger.warn('[LlmHealth] Alert dispatch threw unexpectedly for openrouter (non-fatal):', alertErr);
    }
  }

  lastResults = results;
  return results;
}

// ─── Recurring loop + cached read ─────────────────────────────────────────────

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
