/**
 * Verifies the 2026-08-19 admin-mode gate: query_database/
 * test_database_function/provision_database (arbitrary SQL, service-role,
 * against a real customer's tenant database) are only present in the
 * agent's toolset when the chat session explicitly opted into admin mode
 * (AgentContext.chatMode === 'admin'). confirm_database_change must NEVER
 * appear -- a dangerous change staged by query_database can only be
 * executed by a human via POST /api/v1/database/admin-sql/:id/confirm, not
 * by the agent confirming its own pending change in the same run.
 */
import { describe, it, expect, vi } from 'vitest';

// agentToolSet.ts -> propose_plan.ts -> config/database.js throws at module
// load if SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY are unset --
// same stub pattern agentToolSet.dbMutationBreaker.test.ts uses.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { buildToolSet } from '../agentToolSet.js';
import type { AgentContext } from '../../agent-tools/types.js';

const ADMIN_TOOL_NAMES = ['query_database', 'test_database_function', 'provision_database'];

function baseCtx(chatMode?: 'normal' | 'admin'): AgentContext {
  return {
    appPath: '/tmp/does-not-matter',
    projectId: 'test-project',
    userId: 'test-user',
    chatMode,
    onXmlComplete: () => {},
  } as AgentContext;
}

describe('admin-mode tool gating', () => {
  it('excludes admin-only DB tools when chatMode is undefined (default)', () => {
    const tools = buildToolSet(baseCtx(undefined), [], 'fix');
    for (const name of ADMIN_TOOL_NAMES) expect(tools[name]).toBeUndefined();
  });

  it('excludes admin-only DB tools when chatMode is explicitly normal', () => {
    const tools = buildToolSet(baseCtx('normal'), [], 'fix');
    for (const name of ADMIN_TOOL_NAMES) expect(tools[name]).toBeUndefined();
  });

  it('includes admin-only DB tools when chatMode is admin', () => {
    const tools = buildToolSet(baseCtx('admin'), [], 'fix');
    for (const name of ADMIN_TOOL_NAMES) expect(tools[name]).toBeDefined();
  });

  it('never includes confirm_database_change, in any mode', () => {
    expect(buildToolSet(baseCtx('normal'), [], 'fix')['confirm_database_change']).toBeUndefined();
    expect(buildToolSet(baseCtx('admin'), [], 'fix')['confirm_database_change']).toBeUndefined();
  });

  it('admin mode does not leak DB tools into the micro tier (still excluded there)', () => {
    const tools = buildToolSet(baseCtx('admin'), [], 'micro');
    for (const name of ADMIN_TOOL_NAMES) expect(tools[name]).toBeUndefined();
  });
});
