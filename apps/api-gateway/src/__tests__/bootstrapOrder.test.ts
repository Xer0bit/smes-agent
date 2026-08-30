/**
 * The env fix is a LINE-ORDER invariant, and nothing but this test enforces it.
 *
 * ESM evaluates every static import before any top-level statement, so env
 * loading works only because bootstrap-env.js is the first import of index.ts.
 * An import re-sort (a formatter, an auto-fix, a well-meaning cleanup) that
 * moves it below './app.js' silently reintroduces the production bug: winston
 * evaluates against a bare env and freezes at 'info', and every logger.debug
 * in the codebase goes dark with no error anywhere. That exact state shipped
 * and was only proven at runtime on 2026-08-30.
 *
 * Source-text assertions are unusual, but the invariant IS source text.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => fs.readFileSync(path.join(srcDir, f), 'utf8');

const importSpecifiers = (source: string): string[] =>
  [...source.matchAll(/^import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);

describe('env bootstrap ordering', () => {
  it('bootstrap-env.js is the FIRST import of index.ts', () => {
    const first = importSpecifiers(read('index.ts'))[0];
    expect(first).toBe('./bootstrap-env.js');
  });

  it('index.ts no longer carries inline configDotenv statements', () => {
    // The inline calls were the bug: statements that ran after every import
    // had already evaluated. Their return would mean two competing load sites.
    // Comments are stripped first — the header comment legitimately NAMES the
    // old calls while explaining the mechanism, and prose is not a call site.
    const codeOnly = read('index.ts').replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toMatch(/configDotenv\(/);
  });

  it('bootstrap-env.ts imports nothing from the application', () => {
    // If it ever imports an app module, that module evaluates BEFORE the env
    // loads — the same defect, one file deeper and harder to spot.
    const appImports = importSpecifiers(read('bootstrap-env.ts')).filter(
      (s) => s.startsWith('./') || s.startsWith('../'),
    );
    expect(appImports).toEqual([]);
  });

  it('bootstrap-env.ts still loads all three env sources', () => {
    const src = read('bootstrap-env.ts');
    expect(src).toMatch(/configDotenv\(\{ override: false \}\)/);
    expect(src).toMatch(/\.env\.local/);
    expect(src).toMatch(/\.env\.production/);
  });
});
