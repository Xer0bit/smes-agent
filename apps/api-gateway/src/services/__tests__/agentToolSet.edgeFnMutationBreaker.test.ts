/**
 * Verifies the mutation circuit breaker's edge-function extension (re-added
 * 2026-08-13): write_edge_function/delete_edge_function now share
 * agentToolSet.ts's existing hard-block gate (ctx.mutationFailureStreak,
 * MUTATION_CIRCUIT_BREAKER_THRESHOLD), keyed by the function's `name` arg --
 * same shape as write_file's `path`, no fingerprinting needed.
 *
 * A prior attempt at this exact extension was made earlier the same night
 * but never actually landed in a commit (lost between edit and `git add`),
 * so live production ran with the gap this test guards against for several
 * hours: write_edge_function retrying an identical failure indefinitely with
 * no hard block (project dfe41091, 10+ consecutive failed steps across two
 * runs, real cost burned, nothing landed). This test is what makes that
 * regression loud instead of silent next time.
 *
 * Mirrors agentToolSet.dbMutationBreaker.test.ts's shape: seed ctx state
 * directly, exercise the real dispatch gate via buildToolSet. Both tools'
 * real execute() paths short-circuit to a fixed ERROR string as their first
 * line when ctx.userId is unset, before touching any DB/network call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCallOptions } from 'ai';

vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { buildToolSet } from '../agentToolSet.js';
import type { AgentContext } from '../../agent-tools/types.js';

const toolOpts: ToolCallOptions = { toolCallId: 'test-call', messages: [] };
const NO_USER_CTX_ERROR = 'ERROR: no user context available.';

describe('agentToolSet edge-function mutation circuit breaker', () => {
  let tmpDir: string;
  let ctx: AgentContext;
  let toolSet: ReturnType<typeof buildToolSet>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomgear-edgefn-mutation-breaker-'));
    ctx = {
      appPath: tmpDir,
      projectId: 'test-project',
      onXmlComplete: () => {},
      // userId deliberately left unset: write_edge_function/delete_edge_function
      // short-circuit to a fixed ERROR string before any real DB access when it's missing.
    };
    toolSet = buildToolSet(ctx, [], undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write_edge_function: 3 identical failures on the same function name block the next identical call, a different name is not blocked', async () => {
    ctx.mutationFailureStreak = new Map([
      ['write_edge_function:pm-auth', { message: NO_USER_CTX_ERROR, count: 3 }],
    ]);

    const blocked = await toolSet.write_edge_function.execute(
      { name: 'pm-auth', code: 'return new Response("{}")' },
      toolOpts,
    );
    expect(blocked).toContain('BLOCKED (repeated identical failure)');
    expect(blocked).toContain('write_edge_function');
    expect(blocked).toContain('pm-auth');

    const different = await toolSet.write_edge_function.execute(
      { name: 'other-fn', code: 'return new Response("{}")' },
      toolOpts,
    );
    expect(different).not.toContain('BLOCKED');
    expect(different).toBe(NO_USER_CTX_ERROR);
  });

  it('write_edge_function: below-threshold streak is not blocked', async () => {
    ctx.mutationFailureStreak = new Map([
      ['write_edge_function:pm-auth', { message: NO_USER_CTX_ERROR, count: 2 }],
    ]);

    const result = await toolSet.write_edge_function.execute(
      { name: 'pm-auth', code: 'return new Response("{}")' },
      toolOpts,
    );
    expect(result).not.toContain('BLOCKED');
    expect(result).toBe(NO_USER_CTX_ERROR);
  });

  it('delete_edge_function: 3 identical failures on the same function name block the next identical call', async () => {
    ctx.mutationFailureStreak = new Map([
      ['delete_edge_function:pm-auth', { message: NO_USER_CTX_ERROR, count: 3 }],
    ]);

    const blocked = await toolSet.delete_edge_function.execute({ name: 'pm-auth' }, toolOpts);
    expect(blocked).toContain('BLOCKED (repeated identical failure)');
    expect(blocked).toContain('delete_edge_function');
  });

  it('regression: existing file-mutation and DB-mutation breakers are unaffected by the edge-function extension', async () => {
    ctx.mutationFailureStreak = new Map([
      ['write_file:src/broken.css', { message: 'ERROR: syntax error', count: 3 }],
    ]);

    const blocked = await toolSet.write_file.execute({ path: 'src/broken.css', content: 'x { color: red; }' }, toolOpts);
    expect(blocked).toContain('BLOCKED (repeated identical failure)');
    expect(blocked).toContain('"write_file" has failed on "src/broken.css" 3 times in a row');
  });
});
