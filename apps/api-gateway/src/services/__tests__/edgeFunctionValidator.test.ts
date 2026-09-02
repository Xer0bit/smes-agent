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

// ── The pm-auth unsatisfiable-trap regression (2026-08-25 → fixed 2026-09-02) ──
//
// The plaintext-password rejection used to tell the agent that "this
// database/sandbox has no hashing primitive available (no pgcrypto, no Web
// Crypto, no npm packages)" and to route auth through the platform Auth
// connection. Both claims were false:
//   - pgcrypto is installed in the `extensions` schema (see sqlPreflight.ts)
//   - runEdgeFunction.js injects `crypto: webcrypto`, and `crypto` is not banned
// So a rejected function could not be repaired by following the message. The
// agent retried and tripped the edge-function circuit breaker at 3.
//
// These assert the two halves that matter: correct code PASSES (so the trap
// cannot re-form), and genuinely unhashed passwords are still REJECTED, now
// with guidance that names primitives that exist.
describe('password handling: guidance must be satisfiable', () => {
  const issues = (code: string) => validateEdgeFunctionCode(code);
  const text = (code: string) => issues(code).map((i) => i.message).join(' | ');

  it('ACCEPTS pgcrypto hashing via schema-qualified extensions.crypt', () => {
    const code = `
      const { email, password } = params;
      const rows = await db.rpc('hash_password', { pw: password });
      await db.insert('users', { email, password_hash: rows[0].hash });
      return { ok: true };
    `;
    expect(text(code)).not.toMatch(/raw password|without a hash call/);
  });

  it('ACCEPTS a SQL path that calls extensions.crypt directly', () => {
    const code = `
      const { email, password } = params;
      const hashed = await db.rpc('crypt_password', { pw: password });
      await db.insert('users', { email, password_hash: hashed });
      return { ok: true };
    `;
    expect(text(code)).not.toMatch(/raw password|without a hash call/);
  });

  it('ACCEPTS Web Crypto PBKDF2 in the sandbox', () => {
    const code = `
      const { email, password } = params;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, key, 256);
      await db.insert('users', { email, password_hash: bits });
      return { ok: true };
    `;
    expect(text(code)).not.toMatch(/raw password|without a hash call/);
  });

  it('still REJECTS a genuinely unhashed password', () => {
    const code = `
      const { email, password } = params;
      await db.insert('users', { email, password_hash: password });
      return { ok: true };
    `;
    expect(text(code)).toMatch(/doesn't pass through a hash call/);
  });

  it('still REJECTS comparing a stored hash against a raw password', () => {
    const code = `
      const user = await db.select('users');
      if (user.password_hash !== password) { return { error: 'bad' }; }
      return { ok: true };
    `;
    expect(text(code)).toMatch(/without a hash call in the comparison/);
  });

  it('the rejection names primitives that actually exist, and no longer claims they do not', () => {
    const m = text("await db.insert('users', { password_hash: password });");
    // Names the real primitives
    expect(m).toMatch(/extensions\.crypt/);
    expect(m).toMatch(/gen_salt/);
    expect(m).toMatch(/crypto\.subtle/);
    // And no longer asserts the falsehoods that made it unsatisfiable
    expect(m).not.toMatch(/no pgcrypto/);
    expect(m).not.toMatch(/no Web Crypto/);
    expect(m).not.toMatch(/has no hashing primitive available/);
  });

  it('warns against bare SHA-256 digest for passwords rather than recommending it', () => {
    const m = text("await db.insert('users', { password_hash: password });");
    expect(m).toMatch(/Do NOT use a bare crypto\.subtle\.digest/);
  });
});
