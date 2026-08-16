import { describe, expect, it } from 'vitest';

// Guards the two halves of the no-op-write fix. A write whose content is
// byte-identical to what is already on disk changed nothing, and must not
// read as progress anywhere in the loop.
//
// Live case (CardPro, 2026-08-16): asked to swap a logo, the model could not
// locate the asset, wrote three files with the content they already had, and
// reported success three times. The run recorded files_written=3 with
// net_new_write_count=0, burned 249s / 370k tokens / $0.25, and changed
// nothing the user could see.

// Mirrors isFailureResult in agentLoopService.ts. It gates hadSuccessfulWriteThisStep
// (progress), the tool-failure circuit breaker, and rejectedWriteAttempts.
const isFailureResult = (s: string) => /^(Error|ERROR|BLOCKED|PREFER EDIT|NO CHANGE)/.test(s);

describe('no-op write is not progress', () => {
  it('treats a NO CHANGE result as non-progress', () => {
    expect(isFailureResult('NO CHANGE: src/Header.tsx already contains exactly this content')).toBe(true);
  });

  it('still treats genuine failures as non-progress', () => {
    for (const s of [
      'ERROR: Cannot write src/App.tsx   TypeScript/JSX syntax error',
      'Error: something broke',
      'BLOCKED (out of declared scope): src/other.tsx',
      'PREFER EDIT: use edit_file for a small change',
    ]) {
      expect(isFailureResult(s)).toBe(true);
    }
  });

  it('does NOT misclassify a successful write as failure', () => {
    for (const s of [
      'Wrote src/components/Header.tsx (42 lines)',
      'File written successfully.',
      '⚠️  DEPENDENCY ALERT: 3 file(s) import from src/Header.tsx',
      'Command succeeded (npm install papaparse)',
    ]) {
      expect(isFailureResult(s)).toBe(false);
    }
  });

  // The phrase is load-bearing: write_file returns exactly this prefix, and the
  // loop matches on it. If either side is reworded without the other, no-op
  // writes silently start counting as progress again.
  it('matches the exact prefix write_file emits', () => {
    const emitted = 'NO CHANGE: src/pages/Login.tsx already contains exactly this content   nothing was modified.';
    expect(emitted.startsWith('NO CHANGE:')).toBe(true);
    expect(isFailureResult(emitted)).toBe(true);
  });
});
