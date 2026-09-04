/**
 * Verifies the declared-scope guard (harness redesign increment 2,
 * 2026-08-11): declare_scope.ts's normalizeScopePath/pathMatchesScope and
 * agentToolSet.ts's warn-then-block gate on write_file/edit_file/
 * delete_file/rename_file, seeded either directly (this file) or from the
 * fix-tier diagnosis pass (see agentLoopService.scopeSeeding.test.ts).
 * Never tested end-to-end before this checkpoint -- this is the fixture the
 * spec's Checkpoint 3 success criteria describe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCallOptions } from 'ai';

// agentToolSet.ts -> propose_plan.ts -> config/database.js throws at module
// load if SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY are unset -- not
// exercised by anything under test here, same stub pattern database.service.test.ts uses.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { buildToolSet } from '../agentToolSet.js';
import { normalizeScopePath, pathMatchesScope } from '../../agent-tools/declare_scope.js';
import type { AgentContext } from '../../agent-tools/types.js';

const toolOpts: ToolCallOptions = { toolCallId: 'test-call', messages: [] };

describe('pathMatchesScope / normalizeScopePath', () => {
  it('matches an exact declared file and a file nested under a declared directory prefix, trailing-slash-insensitive', () => {
    const scope = new Set(['src/assets/logo.svg', 'src/pages/checkout/']);
    expect(pathMatchesScope('src/assets/logo.svg', scope)).toBe(true);
    expect(pathMatchesScope('src/pages/checkout/Success.tsx', scope)).toBe(true);
    expect(pathMatchesScope('src/pages/checkout', scope)).toBe(true); // the prefix itself, no trailing slash
    expect(pathMatchesScope('src/pages/Home.tsx', scope)).toBe(false);
  });

  it('normalizes leading/trailing slashes and backslashes the same way on both sides', () => {
    expect(normalizeScopePath('/src\\pages\\Home.tsx/')).toBe('src/pages/Home.tsx');
    expect(pathMatchesScope('/src/pages/checkout/Success.tsx', new Set(['src/pages/checkout/']))).toBe(true);
  });
});

describe('agentToolSet declared-scope gate (fixture: logo incident)', () => {
  let tmpDir: string;
  let ctx: AgentContext;
  let toolSet: ReturnType<typeof buildToolSet>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'SMEsAgent-scope-gate-'));
    ctx = {
      appPath: tmpDir,
      projectId: 'test-project',
      onXmlComplete: () => {},
    };
    toolSet = buildToolSet(ctx, [], undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns on the 1st and 2nd out-of-scope write (write still lands), blocks the 3rd (write does NOT land)', async () => {
    await toolSet.declare_scope.execute({ paths: ['src/assets/logo.css'] }, toolOpts);
    expect(ctx.declaredScope).toEqual(new Set(['src/assets/logo.css']));

    const r1 = await toolSet.write_file.execute(
      { path: 'src/pages/Home.css', content: 'body { color: red; }' }, toolOpts,
    );
    expect(r1).toContain('WARNING (out of declared scope)');
    expect(fs.existsSync(path.join(tmpDir, 'src/pages/Home.css'))).toBe(true);

    const r2 = await toolSet.write_file.execute(
      { path: 'src/pages/About.css', content: 'body { color: blue; }' }, toolOpts,
    );
    expect(r2).toContain('WARNING (out of declared scope)');
    expect(fs.existsSync(path.join(tmpDir, 'src/pages/About.css'))).toBe(true);

    const r3 = await toolSet.write_file.execute(
      { path: 'src/pages/Contact.css', content: 'body { color: green; }' }, toolOpts,
    );
    expect(r3).toContain('BLOCKED (out of declared scope)');
    expect(fs.existsSync(path.join(tmpDir, 'src/pages/Contact.css'))).toBe(false);
  });

  it('a legit multi-file edit fully within declared scope produces zero warnings and zero blocks', async () => {
    const declared = ['src/components/Header.css', 'src/components/Footer.css', 'src/components/Nav.css'];
    await toolSet.declare_scope.execute({ paths: declared }, toolOpts);

    for (const p of declared) {
      const result = await toolSet.write_file.execute({ path: p, content: '.x { color: red; }' }, toolOpts);
      expect(result).not.toMatch(/WARNING|BLOCKED/);
      expect(fs.existsSync(path.join(tmpDir, p))).toBe(true);
    }
  });

  it('opt-in no-op: declare_scope never called -> ctx.declaredScope stays undefined, writes anywhere succeed with no warning/block text', async () => {
    expect(ctx.declaredScope).toBeUndefined();

    const result = await toolSet.write_file.execute(
      { path: 'src/anywhere/random-file.css', content: '.y { color: pink; }' }, toolOpts,
    );

    expect(ctx.declaredScope).toBeUndefined();
    expect(result).not.toMatch(/WARNING|BLOCKED/);
    expect(result.split('\n')[0]).toBe('Successfully wrote src/anywhere/random-file.css');
    expect(fs.existsSync(path.join(tmpDir, 'src/anywhere/random-file.css'))).toBe(true);
  });
});
