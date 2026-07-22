import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { DEFAULT_FREE_MODEL, DEFAULT_PRIMARY_MODEL } from '../config/models.js';

// Circuit breaker: providers that returned a credit/billing error recently.
// Avoids hammering a provider that's genuinely out of quota   but MUST expire,
// not block forever. Confirmed live 2026-07-14: a single transient Gemini 429
// tripped this, and with no expiry Gemini stayed permanently disabled for the
// rest of the process's uptime even though a direct call moments later (and
// the account's own $0.82/$42 spend dashboard) confirmed real quota was
// available the whole time   same lazy-expiry pattern as knowledgebase/
// embedder.ts's isGoogleCircuitOpen/tripGoogleCircuit (30 min TTL).
const BILLING_CIRCUIT_TTL_MS = 15 * 60 * 1000; // shorter than the embedder's 30min   this blocks a whole model, not just embeddings
const billingFailedProviders = new Map<string, number>(); // provider -> resetAt timestamp
export function isBillingCircuitOpen(provider: string): boolean {
  const resetAt = billingFailedProviders.get(provider);
  if (resetAt === undefined) return false;
  if (Date.now() > resetAt) {
    billingFailedProviders.delete(provider);
    return false;
  }
  return true;
}
export function tripBillingCircuit(provider: string): void {
  billingFailedProviders.set(provider, Date.now() + BILLING_CIRCUIT_TTL_MS);
}

// Reads prompt-cache usage out of AI SDK v6's providerMetadata shape, for
// whichever provider actually served this step. Was Anthropic-only (a prior
// bug there   reading a nonexistent `experimental_providerMetadata` field  
// made every step log cacheR=0/cacheW=0 regardless of whether caching ran).
// Extended to Google/Gemini: `providerMetadata.google.usageMetadata.
// cachedContentTokenCount` is a real field (@ai-sdk/google's
// GoogleGenerativeAIProviderMetadata) we never read   meaning if Gemini's
// automatic *implicit* caching (on by default for 2.5+ models, zero config
// needed, distinct from the explicit `cachedContents` API disabled elsewhere
// in this file) has been triggering, we had zero visibility into it and were
// crediting it $0 savings in every cost estimate.
export function extractCacheUsage(providerMetadata: any): { cacheRead: number; cacheWrite: number } {
  // Detect from the shape of providerMetadata itself, not an external
  // providerName variable   a run can fall back between providers mid-stream,
  // and this must reflect whichever provider actually served THIS step.
  const anth = providerMetadata?.anthropic;
  if (anth) {
    const rawUsage = anth.usage ?? {};
    const cacheRead = Number(rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens ?? 0) || 0;
    const cacheWrite = Number(
      anth.cacheCreationInputTokens ?? rawUsage.cache_creation_input_tokens ?? rawUsage.cacheCreationInputTokens ?? 0
    ) || 0;
    return { cacheRead, cacheWrite };
  }
  const google = providerMetadata?.google;
  if (google) {
    const cacheRead = Number(google?.usageMetadata?.cachedContentTokenCount ?? 0) || 0;
    // Gemini's implicit caching has no separate "cache write" concept billed
    // to the caller   cache population is Google-side and free; only reads
    // (cachedContentTokenCount) show up as a real discount.
    return { cacheRead, cacheWrite: 0 };
  }
  return { cacheRead: 0, cacheWrite: 0 };
}

// ─── LLM retry / fallback helpers ─────────────────────────────────────────────

/** Check if an error is retryable (rate limit, overloaded, server error). */
export function isRetryableError(err: any): boolean {
  // Google errors use data.error.code (numeric) while err.status may be the string "UNAVAILABLE"
  const status = err?.status ?? err?.statusCode ?? err?.data?.error?.code ?? err?.data?.error?.status;
  const numericStatus = typeof status === 'number' ? status : parseInt(String(status), 10);
  if (numericStatus === 429 || numericStatus === 529 || (numericStatus >= 500 && numericStatus < 600)) return true;
  const msg = [
    err?.message,
    err?.cause?.message,
    err?.data?.error?.message,
    err?.responseBody,
    err?.error?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return (
    msg.includes('overloaded') ||
    msg.includes('overloaded_error') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('capacity') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('service unavailable') ||
    msg.includes('currently unavailable') ||
    msg.includes('unavailable') ||
    msg.includes('ai_nooutputgeneratederror') ||
    msg.includes('no output generated') ||
    msg.includes('stream terminated')
  );
}

/** Check if an error is specifically a rate limit (429). Needs longer backoff. */
export function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.data?.error?.status;
  if (status === 429) return true;
  const msg = [
    err?.message,
    err?.cause?.message,
    err?.data?.error?.message,
    err?.responseBody,
  ].filter(Boolean).join(' ').toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429');
}

/** Strip raw API details from error messages before sending to users. */
export function sanitizeErrorMessage(err: any): string {
  const msg = (err?.message ?? String(err));
  if (isRateLimitError(err)) return 'The AI model is temporarily busy. Please wait a moment and try again.';
  if (isAuthOrBillingError(err)) return 'AI service authentication issue   switching to backup model.';
  if (isNetworkError(err)) return 'Connection to AI service failed. Trying backup model...';
  // Strip long API error details (org IDs, URLs, etc.)
  const cleaned = msg.replace(/\(org:\s*[^)]+\)/gi, '').replace(/For details.*$/i, '').replace(/You can see.*$/i, '').replace(/You may also.*$/i, '').trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '...' : cleaned;
}

export function isAuthOrBillingError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.data?.error?.status;
  if (status === 401 || status === 403) return true;
  const msg = [err?.message, err?.cause?.message, err?.error?.message].filter(Boolean).join(' ').toLowerCase();
  let bodyMsg = '';
  let parsedBody: any = null;
  if (err?.data?.error?.message) {
    bodyMsg = err.data.error.message.toLowerCase();
  } else if (err?.responseBody) {
    try { parsedBody = JSON.parse(err.responseBody); bodyMsg = parsedBody?.error?.message?.toLowerCase() ?? ''; } catch {}
  }
  // z.ai error code 1113 = insufficient balance / no resource package
  const zaiCode = String(parsedBody?.error?.code ?? err?.data?.error?.code ?? '');
  if (zaiCode === '1113') return true;
  const combined = `${msg} ${bodyMsg}`;
  return (
    combined.includes('organization') && combined.includes('disabled') ||
    combined.includes('balance too low') ||
    combined.includes('balance is too low') ||
    combined.includes('insufficient balance') ||
    combined.includes('no resource package') ||
    combined.includes('please recharge') ||
    combined.includes('credit balance') ||
    combined.includes('insufficient') && combined.includes('credit') ||
    combined.includes('billing') && (combined.includes('inactive') || combined.includes('error')) ||
    combined.includes('exceeded') && combined.includes('spending cap') ||
    combined.includes('usage limits') ||
    combined.includes('api usage limit') ||
    combined.includes('regain access') ||
    // Gemini monthly quota exhaustion ("You exceeded your current quota,
    // please check your plan and billing details")   a 429 by status, but a
    // billing condition in practice: it does not clear until the quota
    // resets, so it must open the billing circuit, not be retried as
    // "temporarily busy". Observed in production 2026-07-17.
    combined.includes('exceeded your current quota') ||
    combined.includes('invalid.*api.*key') ||
    combined.includes('invalid api key') ||
    combined.includes('invalid x-api-key') ||
    combined.includes('authentication') && combined.includes('failed')
  );
}

/**
 * Check if an error is a network-level failure that should immediately trigger
 * the fallback provider rather than retrying the same unreachable endpoint.
 * EAI_AGAIN = DNS temporary failure, ENOTFOUND = DNS not found,
 * ECONNREFUSED = port closed, ECONNRESET / ETIMEDOUT = transport level.
 */
export function isNetworkError(err: any): boolean {
  const msg = [
    err?.message,
    err?.cause?.message,
    err?.error?.message,
    err?.responseBody,
  ].filter(Boolean).join(' ').toLowerCase();
  return (
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('terminated') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('cannot connect to api') ||
    msg.includes('getaddrinfo')
  );
}

/** Returns true for transient mid-stream drops (ECONNRESET, terminated) vs true connectivity failures. */
export function isTransientStreamDrop(err: any): boolean {
  const msg = [
    err?.message,
    err?.cause?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return msg.includes('econnreset') || msg.includes('terminated') || msg.includes('socket hang up');
}

/** Extract retry-after duration in milliseconds from a rate-limit error's response headers. */
export function getRetryAfterMs(err: any): number | null {
  const headers = err?.responseHeaders ?? err?.headers ?? {};
  const retryAfterStr = headers['retry-after'] ?? headers['Retry-After'];
  if (retryAfterStr) {
    const seconds = parseInt(retryAfterStr, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  // Fallback: compute from the reset timestamp Anthropic includes
  const resetStr = headers['anthropic-ratelimit-input-tokens-reset'] ?? headers['anthropic-ratelimit-requests-reset'];
  if (resetStr) {
    const ms = new Date(resetStr).getTime() - Date.now();
    if (!isNaN(ms) && ms > 0) return ms;
  }
  return null;
}

export function getDefaultAgentTimeoutMs(_providerName: string): number {
  // 8 minutes default to reduce false timeouts on long multi-file runs,
  // especially when provider fallback and repair loops are active.
  return 480_000;
}

export function isLikelyFixRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(fix|broken|bug|issue|error|failing|fails|not working|doesn't work|does not work|crash|blank|repair)\b/.test(text)
    || text.includes('build error')
    || text.includes('preview error')
    || text.includes('runtime error');
}

export function buildFallbackCandidates(primaryProviderName: string, primaryModelId?: string): string[] {
  // Same fix as resolveProviderWithFallback above: an unset AI_FALLBACK_MODEL
  // used to resolve straight to DEFAULT_FREE_MODEL (glm-4.5-flash), so this
  // list tried THREE glm variants before ever reaching the stronger,
  // typically-healthy claude/deepseek/gemini-2.5-pro candidates. Only use
  // configuredFallback here if the operator actually set AI_FALLBACK_MODEL  
  // otherwise let the strong candidates go first and treat glm as the
  // last-resort options they're meant to be.
  const configuredFallback = process.env.AI_FALLBACK_MODEL || undefined;
  const candidates = Array.from(new Set([
    configuredFallback,
    'claude-sonnet-4-6',
    'deepseek-chat',
    'gemini-2.5-pro',
    DEFAULT_FREE_MODEL,
    'glm-4.5',
    'glm-4.5-air',
  ].filter(Boolean) as string[]));
  return candidates.filter((mid) => {
    // Never retry the exact same model that just failed
    if (mid === primaryModelId) return false;
    if (mid.toLowerCase().startsWith('glm')) {
      // Allow GLM-to-GLM fallback for transient errors   but not if ZAI is billing-failed
      return Boolean(process.env.ZAI_API_KEY)
        && process.env.AI_DISABLE_ZAI !== '1'
        && !isBillingCircuitOpen('zai');
    }
    if (mid.includes('deepseek')) {
      return Boolean(process.env.DEEPSEEK_API_KEY)
        && process.env.AI_DISABLE_DEEPSEEK !== '1'
        && primaryProviderName !== 'deepseek'
        && !isBillingCircuitOpen('deepseek');
    }
    if (mid.includes('gemini')) {
      // Allow same-provider (gemini) fallback to a different model   e.g. 2.5-pro → 2.0-flash
      return Boolean(process.env.GEMINI_API_KEY)
        && process.env.AI_DISABLE_GEMINI !== '1'
        && !isBillingCircuitOpen('gemini');
    }
    const hasAnthropic = Boolean(process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) && process.env.AI_DISABLE_ANTHROPIC !== '1';
    return hasAnthropic && primaryProviderName !== 'anthropic' && !isBillingCircuitOpen('anthropic');
  });
}

/** Create an AI SDK provider from a model ID. Returns null if API key is missing. */
export function createProviderForModel(mid: string): { provider: any; providerName: string } | null {
  if (mid.toLowerCase().startsWith('glm')) {
    if (process.env.AI_DISABLE_ZAI === '1') return null;
    const key = process.env.ZAI_API_KEY;
    if (!key) return null;
    return { provider: createOpenAI({ apiKey: key, baseURL: 'https://api.z.ai/api/paas/v4' }).chat(mid), providerName: 'zai' };
  } else if (mid.includes('deepseek')) {
    if (process.env.AI_DISABLE_DEEPSEEK === '1') return null;
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return null;
    return { provider: createOpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com/v1' }).chat(mid), providerName: 'deepseek' };
  } else if (mid.includes('gemini')) {
    if (process.env.AI_DISABLE_GEMINI === '1') return null;
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    return { provider: createGoogleGenerativeAI({ apiKey: key })(mid), providerName: 'gemini' };
  } else {
    if (process.env.AI_DISABLE_ANTHROPIC === '1') return null;
    const key = process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    return { provider: createAnthropic({ apiKey: key })(mid), providerName: 'anthropic' };
  }
}

export function resolveProviderWithFallback(requestedModelId: string): { provider: any; providerName: string; modelId: string } {
  const normalizedRequested = requestedModelId || process.env.AI_MODEL || DEFAULT_FREE_MODEL;
  // DEFAULT_FREE_MODEL is glm-4.5-flash   a genuinely weaker model, meant for
  // free-tier requests, not an emergency substitute for a paid request. The
  // old chain used `env-var || DEFAULT_FREE_MODEL` for BOTH the AI_MODEL and
  // AI_FALLBACK_MODEL slots, so whenever those env vars were unset (the
  // normal case), glm became the literal 2nd/3rd candidate   landing there
  // the instant Gemini's circuit tripped, before ever trying Claude or
  // DeepSeek, even though both were confirmed healthy at the same moment
  // (observed in production: "Skipping gemini" x2 → straight to glm-4.5-flash,
  // with anthropic/deepseek never attempted at all). Try the two strong,
  // already-configured providers first; glm is the last resort now, not the
  // second guess.
  const candidates = [
    normalizedRequested,
    process.env.AI_MODEL || undefined,
    'claude-sonnet-4-6',
    'deepseek-chat',
    process.env.AI_FALLBACK_MODEL || undefined,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FREE_MODEL,
  ].filter((c): c is string => Boolean(c));

  const uniqueCandidates = Array.from(new Set(candidates));
  const triedProviders: string[] = [];
  for (const candidate of uniqueCandidates) {
    const providerGuess = candidate.toLowerCase().startsWith('glm') ? 'zai'
      : candidate.includes('deepseek') ? 'deepseek'
      : candidate.includes('gemini') ? 'gemini' : 'anthropic';
    // Skip providers circuit-broken by a billing/credit error this session
    if (isBillingCircuitOpen(providerGuess)) {
      console.warn(`[AgentLoop] Skipping ${providerGuess} (billing circuit open)   trying next candidate`);
      continue;
    }
    const resolved = createProviderForModel(candidate);
    if (resolved) {
      if (candidate !== normalizedRequested) {
        console.warn(`[AgentLoop] Model fallback: requested=${normalizedRequested}, using=${candidate} (${resolved.providerName})`);
      }
      return { ...resolved, modelId: candidate };
    }
    // Track why this candidate was skipped
    const provider = candidate.toLowerCase().startsWith('glm') ? 'zai'
      : candidate.includes('deepseek') ? 'deepseek'
      : candidate.includes('gemini') ? 'gemini' : 'anthropic';
    if (!triedProviders.includes(provider)) triedProviders.push(provider);
  }

  // Build actionable error message listing which keys are missing
  const missingKeys: string[] = [];
  if (!process.env.DEEPSEEK_API_KEY) missingKeys.push('DEEPSEEK_API_KEY');
  if (!process.env.GEMINI_API_KEY) missingKeys.push('GEMINI_API_KEY');
  if (!(process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)) missingKeys.push('ANTHROPIC_API_KEY');
  if (process.env.AI_DISABLE_ANTHROPIC === '1') missingKeys.push('(Anthropic disabled via AI_DISABLE_ANTHROPIC=1)');

  throw new Error(
    `No configured AI provider is available. Tried models: ${uniqueCandidates.join(', ')}. ` +
    `Missing environment variables: ${missingKeys.join(', ')}. ` +
    `Add at least one API key in Admin settings.`
  );
}
