/**
 * Per-model token pricing + cost math (reconstruction #3, first extraction from
 * the 5000-line _runAgentLoopInner). Pure functions, no run state — the safe
 * first cut in decomposing the monolith into named, testable stages.
 *
 * Pricing is keyed on the ACTUAL serving model, not the requested one: mid-run
 * provider fallback (Anthropic circuit open -> zai/gemini) used to price every
 * step at the requested model's Claude rates, which drifted the internal cost
 * log to 53% of the real provider invoices (production audit 2026-07-21).
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Price per 1M tokens for the given serving model id (OpenRouter rates). */
export function priceFor(mid: string): ModelPrice {
  return mid.includes('qwen')
    ? { input: 0.03,  output: 0.13,   cacheRead: 0.00,  cacheWrite: 0.00 }    // Qwen3.7 Flash (code)
    : mid.includes('gemini')
    ? { input: 0.10,  output: 0.40,   cacheRead: 0.01,  cacheWrite: 0.08333 } // Gemini 2.5 Flash Lite (small tasks)
    : { input: 0.03,  output: 0.13,   cacheRead: 0.00,  cacheWrite: 0.00 };   // fallback: code-model rate
}

/** USD cost for a token bundle at the given price. */
export function calcCost(price: ModelPrice, inp: number, out: number, cacheR: number, cacheW: number): number {
  return (inp * price.input + out * price.output + cacheR * price.cacheRead + cacheW * price.cacheWrite) / 1_000_000;
}

/** Mutable per-run token counter with derived totals. */
export interface RunTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  readonly total: number;
  readonly billableTotal: number;
}

/**
 * Per-run token accounting. `total` is every category summed; `billableTotal`
 * discounts cacheRead to ~10% of a fresh token (it bills at ~10%, and counting
 * it fully killed well-cached runs at ~30% of the cost cap -- CardPro fix run
 * 2026-08-16 aborted at 709K raw, ~400K of it cacheRead, ~$1 actual vs the
 * $1.50 cap). Cap comparisons use billableTotal, never total.
 */
export function createRunTokens(): RunTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    get total() { return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheWriteTokens; },
    get billableTotal() { return this.inputTokens + this.outputTokens + this.cacheWriteTokens + Math.round(this.cacheReadTokens * 0.1); },
  };
}

/**
 * Shape of the usage object the AI SDK hands to `onStepFinish` and the stream
 * `finish` part. Only the fields this accounting reads.
 */
export interface SdkUsage {
  inputTokens?: number;
  promptTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number };
}

/**
 * How many of a step's prompt tokens were billed at the FRESH input rate.
 *
 * `usage.inputTokens` is the TOTAL prompt -- fresh + cacheRead + cacheWrite.
 * That is explicit in ai@6's `asLanguageModelUsage`
 * (`inputTokens: usage.inputTokens.total`) and in @ai-sdk/anthropic@3's
 * `convertAnthropicMessagesUsage`, which computes that total as
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 *
 * Charging that total at the fresh rate while ALSO adding cacheRead and
 * cacheWrite bills every cached token two to three times. Observed live on
 * CardPro 2026-09-02: a six-step run costing $0.45 was billed $1.817 and killed
 * by the $1.50 cap having written nothing, four times that morning.
 *
 * The SDK reports the fresh count directly, so subtraction is only the fallback
 * for a provider that omits the detail block. Clamped at 0: a negative fresh
 * count would credit the run against its own cap.
 */
export function freshInputTokens(usage: SdkUsage | undefined, cacheRead: number, cacheWrite: number): number {
  const reported = usage?.inputTokenDetails?.noCacheTokens;
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  const total = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  return Math.max(0, total - cacheRead - cacheWrite);
}
