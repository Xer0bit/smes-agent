/**
 * The map is what stops the agent discovering the codebase by reading files one
 * at a time. The old flat 40-file cap is the regression these guard against.
 */
import { describe, it, expect } from 'vitest';
import { buildSignatureMap } from '../agentSignatureMap.js';

const extract = (content: string) =>
  content.split('\n').filter(Boolean).map((name) => ({ name, kind: 'function' }));

describe('buildSignatureMap', () => {
  it('lists symbols for code files and bare paths for everything else', () => {
    const r = buildSignatureMap(
      [{ path: 'src/a.ts', content: 'foo\nbar' }, { path: 'public/logo.png', content: '' }],
      { extract },
    );
    expect(r.lines[0]).toBe('src/a.ts   foo:function, bar:function');
    expect(r.lines[1]).toBe('public/logo.png');
    expect(r.omitted).toBe(0);
  });

  it('covers far more than the old 40-file cap within budget', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x' }));
    const r = buildSignatureMap(files, { extract });
    expect(r.included).toBeGreaterThan(200);
    expect(r.chars).toBeLessThanOrEqual(20_000);
  });

  it('stops at the character budget and reports the remainder', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/file${i}.ts`, content: '' }));
    const r = buildSignatureMap(files, { extract, charBudget: 60 });
    expect(r.included).toBeLessThan(100);
    expect(r.included + r.omitted).toBe(100);
    expect(r.chars).toBeLessThanOrEqual(60);
  });

  it('elides a symbol-heavy file instead of letting it eat the budget', () => {
    const content = Array.from({ length: 50 }, (_, i) => `s${i}`).join('\n');
    const r = buildSignatureMap([{ path: 'src/big.ts', content }], { extract, maxSymbolsPerFile: 3 });
    expect(r.lines[0]).toContain('+47 more');
  });

  it('still emits the path when symbol extraction throws', () => {
    const boom = () => { throw new Error('unparseable'); };
    const r = buildSignatureMap([{ path: 'src/broken.ts', content: 'x' }], { extract: boom });
    expect(r.lines).toEqual(['src/broken.ts']);
  });
});
