/**
 * Verifies the mutation circuit breaker's checkpoint 1 extension (2026-08
 * orchestration hardening): query_database/provision_database share
 * agentToolSet.ts's existing hard-block gate (ctx.mutationFailureStreak,
 * MUTATION_CIRCUIT_BREAKER_THRESHOLD), keyed via the new
 * deriveDbMutationKey (agent-tools/types.ts) instead of a raw path/from
 * field. Mirrors agentToolSet.scopeGate.test.ts's shape: seed ctx state
 * directly (the tracking loop that populates mutationFailureStreak lives in
 * agentLoopService.ts's onStepFinish, not under test here), then exercise
 * the real dispatch gate via buildToolSet.
 *
 * ctx.chatMode is set to 'admin' here so these admin-only tools (see
 * agentToolSet.adminMode.test.ts) are actually present to test against --
 * that gate is a separate concern from the breaker under test here.
 * confirm_database_change is no longer tested: it's excluded from every
 * chat mode unconditionally (2026-08-19, see AGENT_NEVER_CONFIRMS_TOOLS) --
 * a dangerous change now requires a human confirming via
 * POST /api/v1/database/admin-sql/:id/confirm, so the tool (and this
 * breaker path for it) is unreachable by design, not merely untested.
 *
 * Neither of these 2 tools' real execute() paths are reachable without
 * ctx.userId (each returns a fixed, deterministic "no user context" ERROR
 * string as its very first line, before touching any DB/network call) --
 * exploited here for a same-message failure with zero mocking of
 * database.service.ts.
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
import { deriveDbMutationKey } from '../../agent-tools/types.js';
import type { AgentContext } from '../../agent-tools/types.js';

const toolOpts: ToolCallOptions = { toolCallId: 'test-call', messages: [] };
const NO_USER_CTX_DB_ERROR = 'ERROR: no user context available for database access.';
const NO_USER_CTX_PROVISION_ERROR = 'ERROR: no user context available.';

describe('agentToolSet DB-action mutation circuit breaker (checkpoint 1)', () => {
  let tmpDir: string;
  let ctx: AgentContext;
  let toolSet: ReturnType<typeof buildToolSet>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomgear-db-mutation-breaker-'));
    ctx = {
      appPath: tmpDir,
      projectId: 'test-project',
      chatMode: 'admin',
      onXmlComplete: () => {},
      // userId deliberately left unset: each of the 2 DB tools short-circuits
      // to a fixed ERROR string before any real DB access when it's missing.
    };
    toolSet = buildToolSet(ctx, [], undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('query_database: 3 identical failures block the next identical call, a different SQL statement is not blocked', async () => {
    const sql = 'SELECT * FROM widgets';
    const key = deriveDbMutationKey('query_database', { sql }, ctx)!;
    expect(typeof key).toBe('string');
    ctx.mutationFailureStreak = new Map([[`query_database:${key}`, { message: NO_USER_CTX_DB_ERROR, count: 3 }]]);

    const blocked = await toolSet.query_database.execute({ sql }, toolOpts);
    expect(blocked).toContain('BLOCKED (repeated identical failure)');
    expect(blocked).toContain('query_database');

    const different = await toolSet.query_database.execute({ sql: 'SELECT * FROM gadgets' }, toolOpts);
    expect(different).not.toContain('BLOCKED');
    expect(different).toBe(NO_USER_CTX_DB_ERROR);
  });

  it('provision_database: no per-call key (fixed constant) -- 3 identical failures block the next call, below-threshold does not', async () => {
    const key = deriveDbMutationKey('provision_database', {}, ctx)!;
    expect(key).toBe('provision_database');

    ctx.mutationFailureStreak = new Map([[`provision_database:${key}`, { message: NO_USER_CTX_PROVISION_ERROR, count: 2 }]]);
    const belowThreshold = await toolSet.provision_database.execute({}, toolOpts);
    expect(belowThreshold).not.toContain('BLOCKED');
    expect(belowThreshold).toBe(NO_USER_CTX_PROVISION_ERROR);

    ctx.mutationFailureStreak.set(`provision_database:${key}`, { message: NO_USER_CTX_PROVISION_ERROR, count: 3 });
    const blocked = await toolSet.provision_database.execute({}, toolOpts);
    expect(blocked).toContain('BLOCKED (repeated identical failure)');
    expect(blocked).toContain('provision_database');
  });

  it('regression: existing file-mutation breaker (write_file) is unchanged by the DB-tool extension', async () => {
    ctx.mutationFailureStreak = new Map([
      ['write_file:src/broken.css', { message: 'ERROR: syntax error', count: 3 }],
    ]);

    const blocked = await toolSet.write_file.execute({ path: 'src/broken.css', content: 'x { color: red; }' }, toolOpts);
    expect(blocked).toContain('BLOCKED (repeated identical failure)');
    expect(blocked).toContain('"write_file" has failed on "src/broken.css" 3 times in a row');
    expect(fs.existsSync(path.join(tmpDir, 'src/broken.css'))).toBe(false);

    // A different, untracked path is unaffected.
    const ok = await toolSet.write_file.execute({ path: 'src/other.css', content: 'y { color: blue; }' }, toolOpts);
    expect(ok).not.toContain('BLOCKED');
    expect(fs.existsSync(path.join(tmpDir, 'src/other.css'))).toBe(true);
  });
});
