import { describe, it, expect } from 'vitest';
import { validateEdgeFunctionCode } from '../edgeFunctionValidator.js';

// 2026-08 stability review, Step 9: edgeFunctionValidator.ts is the primary
// defense-in-depth layer against sandbox-escape code reaching functionRunner
// (isolated-vm is the real boundary, but this catches obvious attempts with a
// clear error instead of a cryptic runtime failure). No test previously
// existed for it -- a future refactor could silently break the exact checks
// that matter here with nothing to catch it.

describe('validateEdgeFunctionCode', () => {
  // ── db envelope destructure (the cqjobs [] bug, 2026-08-31) ──────────────
  const msgs = (code: string) => validateEdgeFunctionCode(code).map((i) => i.message).join(' | ');

  it('rejects { data, error } destructured from db.select — always returns []', () => {
    const m = msgs("const { data, error } = await db.select('categories'); return data || [];");
    expect(m).toMatch(/Do not destructure \{ data, error \} from db\.select/);
  });

  it('catches it on db.insert/update/rpc too, not just select', () => {
    for (const method of ['insert', 'update', 'rpc']) {
      const m = msgs(`const { data, error } = await db.${method}('t', {}); return data;`);
      expect(m).toMatch(new RegExp(`db\\.${method}`));
    }
  });

  it('ALLOWS the correct form: a plain assignment from db.select', () => {
    // This is the fix, and must never be flagged.
    expect(msgs("const rows = await db.select('categories'); return rows;")).toBe('');
  });

  it('does NOT flag { data, error } destructured from something that is not db', () => {
    // A real supabase client legitimately returns { data, error }. Only db.* is wrong.
    expect(msgs("const { data, error } = await supabase.from('t').select(); return data;")).toBe('');
  });

  it('does NOT flag an ordinary object destructure', () => {
    expect(msgs("const { name, price } = await db.select('gigs'); return name;")).toBe('');
  });

  it('allows clean code', () => {
    const issues = validateEdgeFunctionCode('const x = await db.select("users"); return x;');
    expect(issues).toEqual([]);
  });

  it('blocks each banned identifier', () => {
    const cases = [
      'require("fs")',
      'process.env.SECRET',
      'global.foo',
      'globalThis.foo',
      'new Function("return 1")()',
      'eval("1+1")',
      'module.exports = {}',
      'exports.foo = 1',
      '__dirname',
      '__filename',
    ];
    for (const code of cases) {
      const issues = validateEdgeFunctionCode(code);
      expect(issues.length, `expected "${code}" to be blocked`).toBeGreaterThan(0);
    }
  });

  it('blocks .constructor access via dot notation', () => {
    const issues = validateEdgeFunctionCode('return ({}).constructor.constructor("return 1")();');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i => i.message.includes('.constructor'))).toBe(true);
  });

  it('blocks .constructor access via bracket notation with a literal key', () => {
    const issues = validateEdgeFunctionCode("return ({})['constructor']['constructor']('return 1')();");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i => i.message.includes('.constructor'))).toBe(true);
  });

  it('does not flag bracket access with a non-constructor literal key', () => {
    const issues = validateEdgeFunctionCode("return params['someKey'];");
    expect(issues).toEqual([]);
  });

  it('blocks with statements', () => {
    const issues = validateEdgeFunctionCode('with (params) { return x; }');
    expect(issues.some(i => i.message.includes('with'))).toBe(true);
  });

  it('blocks dynamic import()', () => {
    const issues = validateEdgeFunctionCode('const m = await import("fs"); return m;');
    expect(issues.some(i => i.message.includes('import'))).toBe(true);
  });

  it('rejects import/export as syntax errors (sourceType: script)', () => {
    const importIssues = validateEdgeFunctionCode('import fs from "fs"; return 1;');
    expect(importIssues.length).toBeGreaterThan(0);

    const exportIssues = validateEdgeFunctionCode('export const x = 1; return x;');
    expect(exportIssues.length).toBeGreaterThan(0);
  });

  it('surfaces a real syntax error distinctly', () => {
    const issues = validateEdgeFunctionCode('this is not valid js {{{');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toMatch(/Syntax error/);
  });
});
