/**
 * BM25-ish local scorer coverage.
 *
 * With no embedding key set in production, detectProvider() returns 'bm25', so
 * scoreFilesLocally is THE retrieval engine for every non-micro agent run (the
 * agentLoopService KB block now includes fix/edit tiers). It decides which
 * files land in the model's initial working set, so its ranking is load-bearing
 * -- a regression here silently degrades every run to path-heuristic ordering.
 */
import { describe, it, expect } from 'vitest';
import { scoreFilesLocally, type WorkspaceFile } from '../retrieval.js';

const files: WorkspaceFile[] = [
  { path: 'src/pages/Checkout.tsx', content: 'export default function Checkout() { return <Cart/>; }' },
  { path: 'src/components/Footer.tsx', content: 'export function Footer() { return <footer/>; }' },
  { path: 'src/lib/format.ts', content: 'export const formatPrice = (n: number) => `$${n}`;' },
];

describe('scoreFilesLocally', () => {
  it('ranks a filename match to the top', () => {
    const top = scoreFilesLocally('fix the checkout page', files, 3)[0];
    expect(top.path).toBe('src/pages/Checkout.tsx');
    expect(top.score).toBeGreaterThan(0);
  });

  it('weights a path match above a body-only match for the same term', () => {
    // "checkout" is a filename in one file and only a body word in the other.
    const twoFiles: WorkspaceFile[] = [
      { path: 'src/pages/Checkout.tsx', content: 'export default function Page() { return <div/>; }' },
      { path: 'src/lib/helpers.ts', content: 'export const total = () => 0; // checkout total helper' },
    ];
    const ranked = scoreFilesLocally('checkout', twoFiles, 2);
    const byPath = ranked.find(r => r.path.endsWith('Checkout.tsx'))!;
    const byBody = ranked.find(r => r.path.endsWith('helpers.ts'))!;
    expect(byPath.score).toBeGreaterThan(byBody.score);
  });

  it('respects the limit', () => {
    expect(scoreFilesLocally('checkout footer format', files, 1)).toHaveLength(1);
  });

  it('falls back to the first files (score 0) when the prompt has no usable tokens', () => {
    const out = scoreFilesLocally('   ', files, 2);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.score === 0)).toBe(true);
  });
});
