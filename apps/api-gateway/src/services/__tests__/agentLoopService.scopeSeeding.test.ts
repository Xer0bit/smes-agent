/**
 * Verifies the diagnose-before-fix scope-seeding integration (harness
 * redesign increment 3, 2026-08-11): on a fix-tier build run,
 * agentLoopService.ts's read-only diagnosis pass (~line 1684) extracts
 * implicated files from the diagnosis's own tool-call arguments and seeds
 * `ctx.declaredScope` (line ~1741) BEFORE the main loop's first write-family
 * tool call. Never tested before this checkpoint.
 *
 * The main `streamText` loop is not driven end-to-end here (that's the AI
 * SDK's own machinery, not what's under test) -- only `generateText` (the
 * diagnosis pass's call) and `streamText` (the main loop's call) are
 * replaced. The streamText replacement invokes the REAL toolSet built with
 * the REAL run ctx (same object the diagnosis pass seeds), proving the seed
 * is visible to the gate at the exact point the main loop would first call
 * a write-family tool -- via the real gate code in agentToolSet.ts, not a
 * reimplementation of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AI_ANTHROPIC_API_KEY = process.env.AI_ANTHROPIC_API_KEY || 'test-anthropic-key';

// agentLoopService.ts -> agentToolSet.ts -> propose_plan.ts -> config/database.js
// throws at module load if SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY
// are unset -- not exercised by anything under test here (agentLoopService.ts's
// own `supabase` client is separately null-guarded on SUPABASE_URL directly).
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

let diagnosisCallCount = 0;
let seededDeleteAttempted = false;
let scopeGateResultPromise: Promise<string> | null = null;

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      diagnosisCallCount++;
      // Shape matches how agentLoopService.ts extracts implicatedFiles: from
      // steps[].toolCalls[].input, not from parsing `text` -- see the real
      // extraction logic at ~line 1729-1738.
      return {
        text: 'Root cause: Logo.tsx references a stale asset path.',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [
          { toolCalls: [{ toolName: 'read_file', input: { path: 'src/components/Logo.tsx' } }] },
        ],
      };
    }),
    streamText: vi.fn((streamParams: any) => {
      // First (and only) invocation that sees a real `tools.delete_file`
      // drives the assertion; every retry/fallback attempt after it is a
      // no-op so a single scope violation is captured, not a pile of them.
      if (!seededDeleteAttempted && streamParams?.tools?.delete_file) {
        seededDeleteAttempted = true;
        scopeGateResultPromise = streamParams.tools.delete_file.execute(
          { path: 'src/pages/Unrelated.css' },
          { toolCallId: 'seed-test', messages: [] },
        );
      }
      throw new Error('streamText intentionally unimplemented in this fixture -- only diagnosis-seeding is under test');
    }),
  };
});

import { runAgentLoop, type AgentEventSink } from '../agentLoopService.js';

describe('agentLoopService diagnose-before-fix scope seeding (fix tier, build mode)', () => {
  let tmpDir: string;
  const originalKeys = {
    AI_ANTHROPIC_API_KEY: process.env.AI_ANTHROPIC_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  beforeEach(() => {
    diagnosisCallCount = 0;
    seededDeleteAttempted = false;
    scopeGateResultPromise = null;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomgear-scope-seed-'));
    fs.mkdirSync(path.join(tmpDir, 'src/components'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/components/Logo.tsx'), 'export default function Logo() { return null; }\n', 'utf8');
    // No competing provider keys -- keeps fallback candidates to anthropic-only,
    // which all route through the same mocked streamText above.
    delete process.env.ZAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('seeds ctx.declaredScope from the diagnosis pass before the main loop\'s first write-family tool call', async () => {
    const sink: AgentEventSink = { emit: () => {}, heartbeat: () => {} };

    await runAgentLoop({
      prompt: 'The logo is broken, please fix it',
      projectId: 'scope-seed-test-project',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'fix' },
      sink,
    }).catch(() => {
      // The mocked streamText always throws (see above) -- the run is
      // expected to fail end-to-end. Only the independently-captured
      // scopeGateResultPromise is under test.
    });

    expect(diagnosisCallCount).toBe(1);
    expect(seededDeleteAttempted).toBe(true);
    expect(scopeGateResultPromise).not.toBeNull();

    const gateResult = await scopeGateResultPromise!;
    // delete_file on a non-existent path returns "Warning: File does not
    // exist: <path>" (no ERROR/BLOCKED prefix) -- the scope-gate WARNING gets
    // appended to it. Seeing that WARNING text proves ctx.declaredScope was
    // already populated (from the diagnosis pass) by the time this call ran;
    // if the seed were absent (ctx.declaredScope undefined), the gate is a
    // no-op and no WARNING text would appear at all.
    expect(gateResult).toContain('WARNING (out of declared scope)');
    expect(gateResult).toContain('src/pages/Unrelated.css');
  }, 20_000);

  // 2026-08-13: extended to edit tier after a near-identical incident recurred
  // on an edit-tier request ("use the real logos in the project") that never
  // hit FIX_RE, so the fix-only diagnosis pass never ran and the model wandered
  // into unrelated files (deleted/renamed pre-existing duplicate type files).
  it('also seeds ctx.declaredScope on an edit-tier run (not just fix)', async () => {
    const sink: AgentEventSink = { emit: () => {}, heartbeat: () => {} };

    await runAgentLoop({
      prompt: 'Use the real logos in the project',
      projectId: 'scope-seed-test-project-edit',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'edit' },
      sink,
    }).catch(() => {});

    expect(diagnosisCallCount).toBe(1);
    expect(seededDeleteAttempted).toBe(true);
    const gateResult = await scopeGateResultPromise!;
    expect(gateResult).toContain('WARNING (out of declared scope)');
  }, 20_000);

  // Regression guard: tiers outside {fix, edit} (feature/build/micro) must
  // stay unscoped -- this increment was deliberately not generalized further.
  // The delete_file tool still exists in a feature-tier toolset (scope
  // seeding controls ctx.declaredScope, not tool availability), so the mock
  // still invokes it -- what proves the diagnosis pass itself didn't run is
  // diagnosisCallCount staying 0, and the gate having nothing to warn about
  // since ctx.declaredScope was never seeded.
  it('does NOT run the diagnosis pass on a feature-tier run', async () => {
    const sink: AgentEventSink = { emit: () => {}, heartbeat: () => {} };

    await runAgentLoop({
      prompt: 'Build a full checkout flow with cart, payment, and order history',
      projectId: 'scope-seed-test-project-feature',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'feature' },
      sink,
    }).catch(() => {});

    expect(diagnosisCallCount).toBe(0);
    expect(seededDeleteAttempted).toBe(true);
    const gateResult = await scopeGateResultPromise!;
    expect(gateResult).not.toContain('WARNING (out of declared scope)');
  }, 20_000);
});
