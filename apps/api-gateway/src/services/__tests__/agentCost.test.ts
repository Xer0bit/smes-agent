/**
 * Pricing/cost math extracted from the agent loop (reconstruction #3). The cost
 * log once drifted to 53% of real invoices by pricing fallback-provider steps
 * at Claude rates, so these assert the serving-model keying stays correct.
 */
import { describe, it, expect } from 'vitest';
import { priceFor, calcCost } from '../agentCost.js';

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
