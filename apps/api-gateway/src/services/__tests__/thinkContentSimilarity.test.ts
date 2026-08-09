import { describe, it, expect } from 'vitest';
import { thinkContentSimilarity } from '../agentLoopService.js';

describe('thinkContentSimilarity', () => {
  it('scores near-identical restated reasoning highly', () => {
    const a = 'I need to check the Button component to see why the color prop is not applying correctly.';
    const b = 'Let me check the Button component again to see why the color prop is not applying.';
    expect(thinkContentSimilarity(a, b)).toBeGreaterThanOrEqual(0.55);
  });

  it('scores genuinely different reasoning low', () => {
    const a = 'I need to check the Button component for the color prop issue.';
    const b = 'The database schema is missing a foreign key on the orders table, let me add a migration.';
    expect(thinkContentSimilarity(a, b)).toBeLessThan(0.3);
  });

  it('returns 0 for empty input', () => {
    expect(thinkContentSimilarity('', 'something here')).toBe(0);
    expect(thinkContentSimilarity('something here', '')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'read the file and check imports';
    const b = 'check imports and read the file again';
    expect(thinkContentSimilarity(a, b)).toBeCloseTo(thinkContentSimilarity(b, a), 10);
  });
});
