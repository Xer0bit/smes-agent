/**
 * Pricing/cost math extracted from the agent loop (reconstruction #3). The cost
 * log once drifted to 53% of real invoices by pricing fallback-provider steps
 * at Claude rates, so these assert the serving-model keying stays correct.
 */
import { describe, it, expect } from 'vitest';
import { priceFor, calcCost, freshInputTokens } from '../agentCost.js';

describe('priceFor', () => {
  it('keys on the serving model, not a requested default', () => {
    expect(priceFor('claude-sonnet-5').input).toBe(3.0);
    expect(priceFor('deepseek-chat').input).toBe(0.27);
    expect(priceFor('glm-4.5').output).toBe(2.2);
    expect(priceFor('gemini-flash-latest').cacheRead).toBe(0.375);
  });

  it('falls back to Claude rates for an unknown model', () => {
    expect(priceFor('some-unknown-model')).toEqual({ input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 });
  });
});

describe('calcCost', () => {
  it('computes USD per the given price (per-1M-token rates)', () => {
    const price = priceFor('claude-sonnet-5');
    // 1M input @ $3 = $3.00 exactly.
    expect(calcCost(price, 1_000_000, 0, 0, 0)).toBeCloseTo(3.0, 6);
    // cacheRead is far cheaper than fresh input.
    expect(calcCost(price, 0, 0, 1_000_000, 0)).toBeCloseTo(0.3, 6);
    expect(calcCost(price, 0, 0, 0, 0)).toBe(0);
  });
});

/**
 * `usage.inputTokens` is the TOTAL prompt (fresh + cacheRead + cacheWrite), and
 * billing that total at the fresh rate while separately adding cacheRead and
 * cacheWrite charged every cached token two to three times. The fixture below
 * is the real per-step trace of CardPro run f45dc53b (2026-09-02 09:29), which
 * the old arithmetic billed at $1.817 -- over the $1.50 cap, so the run was
 * killed at step 6 with nothing written and told the user the request was
 * "bigger than I could finish in one go".
 */
describe('freshInputTokens', () => {
  const RUN = [
    { inputTokens: 60067, out: 450,  cacheRead: 0,     cacheWrite: 57196 },
    { inputTokens: 71220, out: 873,  cacheRead: 57196, cacheWrite: 13879 },
    { inputTokens: 72627, out: 119,  cacheRead: 71075, cacheWrite: 1292 },
    { inputTokens: 72812, out: 334,  cacheRead: 72367, cacheWrite: 185 },
    { inputTokens: 74899, out: 1068, cacheRead: 72552, cacheWrite: 2069 },
    { inputTokens: 90300, out: 494,  cacheRead: 74621, cacheWrite: 15319 },
  ];

  it('reads the fresh remainder, not the whole prompt, on every cached step', () => {
    for (const step of RUN) {
      expect(freshInputTokens(step, step.cacheRead, step.cacheWrite)).toBeLessThan(3000);
    }
  });

  it('keeps a real run under the cost cap that the double-count breached', () => {
    const price = priceFor('claude-sonnet-5');
    const billedBefore = RUN.reduce((sum, s) =>
      sum + calcCost(price, s.inputTokens, s.out, s.cacheRead, s.cacheWrite), 0);
    const billedAfter = RUN.reduce((sum, s) =>
      sum + calcCost(price, freshInputTokens(s, s.cacheRead, s.cacheWrite), s.out, s.cacheRead, s.cacheWrite), 0);

    expect(billedBefore).toBeCloseTo(1.817, 2); // matches the production abort log
    expect(billedBefore).toBeGreaterThan(1.5);
    expect(billedAfter).toBeLessThan(0.6);
  });

  it('prefers the SDK fresh count over subtraction', () => {
    expect(freshInputTokens({ inputTokens: 1000, inputTokenDetails: { noCacheTokens: 42 } }, 900, 58)).toBe(42);
  });

  it('subtracts only as a fallback, and never reports a negative', () => {
    expect(freshInputTokens({ inputTokens: 1000 }, 900, 58)).toBe(42);
    expect(freshInputTokens({ inputTokens: 100 }, 900, 58)).toBe(0);
    expect(freshInputTokens(undefined, 0, 0)).toBe(0);
  });
});
