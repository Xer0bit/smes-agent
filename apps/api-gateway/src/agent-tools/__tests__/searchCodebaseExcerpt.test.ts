/**
 * search_codebase was called 9 times against grep's 276 across 477 runs. It
 * returned `content.slice(0, 250)` -- the top of the file, which for a TS module
 * is the import block -- so a semantically correct hit rendered as imports while
 * grep returned the matching line. Which lines get shown IS the tool's value.
 */
import { describe, expect, it } from 'vitest';
import { bestMatchingExcerpt } from '../search_codebase.js';

const FILE = [
  "import { useState } from 'react';",       // 1
  "import { api } from '@/lib/api';",        // 2
  '',                                        // 3
  'export function Cart() {',                // 4
  '  const [items, setItems] = useState([]);',// 5
  '',                                        // 6
  '  const cartTotal = items.reduce((sum, i) => sum + i.price, 0);', // 7
  '  return <div>{cartTotal}</div>;',        // 8
  '}',                                       // 9
].join('\n');

describe('bestMatchingExcerpt', () => {
  it('returns the region that matches the query, not the file head', () => {
    const out = bestMatchingExcerpt(FILE, 'where is the cart total calculated');
    expect(out).toMatch(/cartTotal = items\.reduce/);
    // The old behaviour returned the imports; they must not be what is shown.
    expect(out).not.toMatch(/import \{ useState \}/);
  });

  it('includes line numbers so the model can go straight there', () => {
    const out = bestMatchingExcerpt(FILE, 'cart total');
    expect(out).toMatch(/^\s*7: /m);
  });

  it('ignores filler words that would match every line', () => {
    // "where/is/the" are stopwords; only "cartTotal" should drive the choice.
    const out = bestMatchingExcerpt(FILE, 'where is the cartTotal');
    expect(out).toMatch(/cartTotal/);
  });

  it('prefers the line matching the most query terms', () => {
    const out = bestMatchingExcerpt(FILE, 'items price reduce');
    expect(out).toMatch(/reduce/);
  });

  it('falls back to the head when nothing matches, still numbered', () => {
    const out = bestMatchingExcerpt(FILE, 'kubernetes ingress');
    expect(out).toMatch(/^1: import/m);
  });

  it('does not run off the start or end of the file', () => {
    const oneLine = 'export const total = 1;';
    const out = bestMatchingExcerpt(oneLine, 'total');
    expect(out).toBe('1: export const total = 1;');
  });
});
