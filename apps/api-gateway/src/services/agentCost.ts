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

/** Price per 1M tokens for the given serving model id. */
export function priceFor(mid: string): ModelPrice {
  return mid.includes('claude')
    ? { input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  }  // Claude Sonnet 5
    : mid.includes('gemini-3.1-pro-preview')
    ? { input: 1.25,   output: 10.00,  cacheRead: 0.31,  cacheWrite: 0.00  }  // Gemini 3.1 Pro (thinking)
    : mid.includes('gemini-2.5-pro')
    ? { input: 1.25,   output: 10.00,  cacheRead: 0.31,  cacheWrite: 0.00  }  // Gemini 2.5 Pro
    : mid.includes('gemini')
    // "gemini-flash-latest" is a Google-managed alias that silently moved
    // 2.5 Flash -> 3.5 Flash -> 3.6 Flash (2026-07-21) while this price stayed
    // frozen at the original 2.5 Flash rate, a ~20x undercount on every
    // narration call and 'micro'-tier run. Verified current rate.
    ? { input: 1.50,   output: 7.50,   cacheRead: 0.375, cacheWrite: 0.00 }   // Gemini Flash (latest, currently 3.6)
    : mid.includes('deepseek')
    ? { input: 0.27,   output: 1.10,   cacheRead: 0.07,  cacheWrite: 0.00  }  // DeepSeek Chat
    : mid.toLowerCase().startsWith('glm')
    ? { input: 0.60,   output: 2.20,   cacheRead: 0.11,  cacheWrite: 0.00  }  // z.ai GLM-4.5
    : { input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  }; // fallback: Claude
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
