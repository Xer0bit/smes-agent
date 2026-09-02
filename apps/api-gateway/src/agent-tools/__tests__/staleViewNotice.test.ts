/**
 * The largest measured cause of SEARCH misses (46%, 25 of 54 over 477 traced
 * runs) is the model editing a file using SEARCH text from before its own write
 * to that same path. The write tools returned a bare success string, so nothing
 * in context marked the earlier read stale.
 */
import { describe, expect, it } from 'vitest';
import { staleViewNotice } from '../searchMissDiagnostics.js';

describe('staleViewNotice', () => {
  it('names the path that changed, so the model knows which read to discard', () => {
    const n = staleViewNotice('src/contexts/AppContext.tsx');
    expect(n).toMatch(/src\/contexts\/AppContext\.tsx/);
  });

  it('says the earlier read is out of date and to re-read before a SEARCH block', () => {
    const n = staleViewNotice('src/lib/api.ts');
    expect(n).toMatch(/out of date/i);
    expect(n).toMatch(/re-read/i);
    expect(n).toMatch(/SEARCH/);
  });

  it('stays short: it is appended to every successful write', () => {
    // Echoing file content here would cost more context than the misses it
    // prevents. Keep it to one line.
    expect(staleViewNotice('a.ts').length).toBeLessThan(300);
  });
});
