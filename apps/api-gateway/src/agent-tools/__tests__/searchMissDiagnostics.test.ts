/**
 * Does the SEARCH_MISS diagnosis actually DISCRIMINATE?
 *
 * The point of this instrumentation is to separate three causes that each need
 * a different fix. Fields that look informative but collapse different causes
 * to the same output would leave us as blind as before, with more log volume.
 * So each test below pins a case that must be distinguishable from the others.
 *
 * Grounded in the real audit numbers: the files that actually missed were 184,
 * 169, 140 and 63 lines -- all under the 300-line truncation threshold, which
 * is how cause (a) was ruled out.
 */
import { describe, it, expect } from 'vitest';
import { classifySearchMiss, PREVIEW_LINES, TRUNCATION_MIN_LINES } from '../searchMissDiagnostics.js';

const file = (n: number, marker?: { at: number; text: string }) =>
  Array.from({ length: n }, (_, i) => (marker && i === marker.at ? marker.text : `line ${i + 1}`)).join('\n');

describe('discriminating the causes', () => {
  it('text absent from a SHORT file -> stale/compacted view, not truncation', () => {
    // The real shape: 169-line AuthContext, full read, SEARCH text nowhere in it.
    const d = classifySearchMiss(file(169), 'const userData = result.user;', 'edit');
    expect(d.targetFoundAtLine).toBeNull();
    expect(d.readWasTruncated).toBe(false);
    expect(d.likelyCause).toBe('absent-from-file');
  });

  it('text absent from a LONG file in a truncating tier -> below-truncation', () => {
    const d = classifySearchMiss(file(TRUNCATION_MIN_LINES + 50), 'something never shown', 'edit');
    expect(d.readWasTruncated).toBe(true);
    expect(d.likelyCause).toBe('below-truncation');
  });

  it('same long file in a NON-truncating tier is NOT blamed on truncation', () => {
    // Tier decides whether truncation applies; blaming it in 'build' would
    // send the fix at the wrong mechanism.
    const d = classifySearchMiss(file(TRUNCATION_MIN_LINES + 50), 'something never shown', 'build');
    expect(d.readWasTruncated).toBe(false);
    expect(d.likelyCause).toBe('absent-from-file');
  });

  it('text present but unmatched -> formatting problem, a different fix entirely', () => {
    const d = classifySearchMiss(file(120, { at: 10, text: '  const x = 1;' }), 'const x = 1;', 'edit');
    expect(d.targetFoundAtLine).toBe(11);
    expect(d.likelyCause).toBe('present-not-matched');
  });
});

describe('the thrash split: can the model repair from the preview?', () => {
  it('target inside the preview -> the model HAS what it needs (reasoning side)', () => {
    const d = classifySearchMiss(file(184, { at: 20, text: 'const target = 1;' }), 'const target = 1;', 'edit');
    expect(d.targetInPreview).toBe(true);
  });

  it('target below the preview -> the model CANNOT repair from the error (harness side)', () => {
    // 184-line ExplorePage with the target at line 150: the 100-line preview
    // does not contain it, so repeating the same wrong SEARCH is inevitable.
    const d = classifySearchMiss(file(184, { at: 149, text: 'const target = 1;' }), 'const target = 1;', 'edit');
    expect(d.targetFoundAtLine).toBe(150);
    expect(d.targetInPreview).toBe(false);
  });

  it('absent target is never reported as being in the preview', () => {
    expect(classifySearchMiss(file(184), 'nope', 'edit').targetInPreview).toBe(false);
  });
});

describe('probe selection', () => {
  it('skips blank leading lines to find a usable probe', () => {
    const d = classifySearchMiss(file(50, { at: 5, text: 'const real = 2;' }), '\n\n  const real = 2;\n  more();', 'edit');
    expect(d.targetFoundAtLine).toBe(6);
  });

  it('an all-whitespace SEARCH yields no false location', () => {
    const d = classifySearchMiss(file(50), '\n   \n', 'edit');
    expect(d.targetFoundAtLine).toBeNull();
  });

  it('reports the real line count for aggregation', () => {
    expect(classifySearchMiss(file(184), 'x', 'edit').fileLines).toBe(184);
    expect(PREVIEW_LINES).toBe(100);
  });
});
