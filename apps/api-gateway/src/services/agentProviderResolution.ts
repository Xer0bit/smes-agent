import { createOpenAI } from '@ai-sdk/openai';
import { CHEAP_MODEL, CODE_MODEL, DEFAULT_FREE_MODEL, DEFAULT_PRIMARY_MODEL } from '../config/models.js';

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

// Cross-worker propagation (2026-08-22, gap register G15). This Map is
// per-process, and PM2 runs 2 workers: worker A tripping the circuit did
// nothing for worker B, which kept hammering a provider known to be out of
// quota for the full 15-minute TTL. Observed cost: sustained failed spend
// through an 11-hour Anthropic outage.
//
// Redis is the shared store because it is already a live dependency here
// (agentProjectLock.ts's client, same connect/degrade posture) -- no new
// infrastructure. Reads stay SYNCHRONOUS against the local Map rather than
// awaiting Redis: isBillingCircuitOpen is called from inside the sync
// provider fallback chain below, and making it async would ripple through
// five call sites of selection logic for no real benefit. A worker instead
// pulls peer state on an interval, so the worst case degrades from "never
// learns" to "learns within BILLING_CIRCUIT_SYNC_MS" -- 20s against a 15min
// TTL. If Redis is unreachable, every path below falls back to exactly the
// old per-process behavior rather than failing.
const BILLING_CIRCUIT_REDIS_PREFIX = 'ecg:billing-circuit:';
const BILLING_CIRCUIT_SYNC_MS = 20_000;

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
  const resetAt = Date.now() + BILLING_CIRCUIT_TTL_MS;
  billingFailedProviders.set(provider, resetAt);
  // Fire-and-forget: this runs on an error path that is already degraded, and
  // a Redis hiccup must never turn a provider failure into a thrown request.
  void shareBillingTrip(provider, resetAt);
}

async function shareBillingTrip(provider: string, resetAt: number): Promise<void> {
  try {
    const { redisClient } = await import('./agentProjectLock.js');
    // PX so the key self-expires on the same clock as the local entry -- no
    // sweeper needed, and a worker that reads it late still sees a correct
    // remaining window rather than a stale-forever block (the exact failure
    // the 2026-07-14 no-expiry incident above produced in-process).
    await redisClient.set(`${BILLING_CIRCUIT_REDIS_PREFIX}${provider}`, String(resetAt), 'PX', BILLING_CIRCUIT_TTL_MS);
  } catch {
    // Redis down/absent: local Map still holds the trip, which is the
    // pre-2026-08-22 behavior. Degraded, not broken.
  }
}

/** Pull peer workers' trips into this process's Map. Exported for testing. */
export async function syncBillingCircuitFromPeers(providers: string[]): Promise<void> {
  try {
    const { redisClient } = await import('./agentProjectLock.js');
    const keys = providers.map((p) => `${BILLING_CIRCUIT_REDIS_PREFIX}${p}`);
    const values = await redisClient.mget(...keys);
    values.forEach((raw, i) => {
      if (!raw) return;
      const resetAt = Number(raw);
      if (!Number.isFinite(resetAt) || Date.now() > resetAt) return;
      const existing = billingFailedProviders.get(providers[i]);
      // Never shorten a local trip with a peer's earlier expiry.
      if (existing === undefined || resetAt > existing) {
        billingFailedProviders.set(providers[i], resetAt);
      }
    });
  } catch {
    // Same posture as shareBillingTrip: absent Redis means local-only.
  }
}

const CIRCUIT_PROVIDERS = ['openrouter'];

// unref() so this never holds the process open (matters for tests and for a
// clean PM2 shutdown). Skipped under test to keep runs deterministic.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  setInterval(() => { void syncBillingCircuitFromPeers(CIRCUIT_PROVIDERS); }, BILLING_CIRCUIT_SYNC_MS).unref();
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
  //
  // Post-OpenRouter-migration: every call now goes out via @ai-sdk/openai's
  // createOpenAI pointed at OpenRouter, so providerMetadata never carries an
  // `anthropic` or `google` key   both branches below are dead until/unless
  // OpenRouter's own cache-usage shape (if any) gets read explicitly. Falls
  // through to {cacheRead: 0, cacheWrite: 0}, which just means cost dashboards
  // report zero cache savings rather than crediting a discount that may not
  // actually apply the same way through OpenRouter's proxy.
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

/**
 * Single provider (OpenRouter, 2 models: CODE_MODEL + CHEAP_MODEL) means the
 * only real fallback left is "try the other one" -- there's no more
 * provider-diversity ladder to climb. Still worth one retry: a transient
 * failure on the code model shouldn't hard-fail a run when the cheap model
 * can at least attempt it.
 */
export function buildFallbackCandidates(_primaryProviderName: string, primaryModelId?: string): string[] {
  const other = primaryModelId === CODE_MODEL ? CHEAP_MODEL : CODE_MODEL;
  if (other === primaryModelId) return [];
  if (isBillingCircuitOpen('openrouter')) return [];
  return [other];
}

/** Create an AI SDK provider from a model ID. Returns null if API key is missing. */
export function createProviderForModel(mid: string): { provider: any; providerName: string } | null {
  if (process.env.AI_DISABLE_OPENROUTER === '1') return null;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  return {
    provider: createOpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' }).chat(mid),
    providerName: 'openrouter',
  };
}

export function resolveProviderWithFallback(requestedModelId: string): { provider: any; providerName: string; modelId: string } {
  const normalizedRequested = requestedModelId || process.env.AI_MODEL || DEFAULT_PRIMARY_MODEL;
  const candidates = Array.from(new Set([
    normalizedRequested,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FREE_MODEL,
  ]));

  if (isBillingCircuitOpen('openrouter')) {
    throw new Error(
      `OpenRouter is temporarily circuit-broken after a recent billing/auth error. Tried models: ${candidates.join(', ')}.`
    );
  }

  for (const candidate of candidates) {
    const resolved = createProviderForModel(candidate);
    if (resolved) {
      if (candidate !== normalizedRequested) {
        console.warn(`[AgentLoop] Model fallback: requested=${normalizedRequested}, using=${candidate} (${resolved.providerName})`);
      }
      return { ...resolved, modelId: candidate };
    }
  }

  throw new Error(
    `No configured AI provider is available. Tried models: ${candidates.join(', ')}. ` +
    `Missing environment variable: OPENROUTER_API_KEY. Add it in Admin settings.`
  );
}
