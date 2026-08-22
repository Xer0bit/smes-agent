/**
 * Database-tool availability in the agent's toolset.
 *
 * These tools were briefly gated on AgentContext.chatMode === 'admin'
 * (2026-08-19). That gate was removed on 2026-08-22 because it was not a
 * security boundary and did real damage:
 *
 *   - chatMode is read verbatim off the /agent-stream request body with no
 *     authorization check, so any caller could send {"chatMode":"admin"} and
 *     self-grant the tools. It gated the UI toggle, not the capability.
 *   - Meanwhile a normal-mode run -- the default for every user -- could write
 *     an edge function but could not CREATE the table it queried, and could not
 *     provision a database at all. Provisioning is what supplies the frontend's
 *     VITE_FUNCTIONS_API_URL / VITE_DB_ANON_KEY, so generated apps had no way to
 *     call their own backend. The prompt still instructed the agent to call
 *     provision_database, a tool that was no longer in its toolset.
 *
 * What actually protects the tenant database is statement-level and human-
 * enforced, and these tests pin it: query_database STAGES schema-mutating SQL
 * into admin_sql_pending_changes, and confirm_database_change is absent from
 * every tier, so nothing the agent can call executes a staged change.
 *
 * Guests stay excluded: they are the one caller class that never passes a
 * project access check (ai.routes.ts runs getProject() and the viewer/client
 * role check only on the authenticated branch), so for them the request-body
 * projectId is unvalidated input.
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

const DB_TOOL_NAMES = ['query_database', 'test_database_function', 'provision_database'];

function baseCtx(chatMode?: 'normal' | 'admin', userId = 'test-user'): AgentContext {
  return {
    appPath: '/tmp/does-not-matter',
    projectId: 'test-project',
    userId,
    chatMode,
    onXmlComplete: () => {},
  } as AgentContext;
}

describe('database tool availability', () => {
  it('includes DB tools by default (chatMode undefined)', () => {
    const tools = buildToolSet(baseCtx(undefined), [], 'fix');
    for (const name of DB_TOOL_NAMES) expect(tools[name]).toBeDefined();
  });

  it('includes DB tools in normal mode -- the regression this replaced', () => {
    // The specific break: normal mode could write an edge function but not
    // create the table it queried, and could not provision a database at all.
    const tools = buildToolSet(baseCtx('normal'), [], 'fix');
    for (const name of DB_TOOL_NAMES) expect(tools[name]).toBeDefined();
  });

  it('includes DB tools in admin mode', () => {
    const tools = buildToolSet(baseCtx('admin'), [], 'fix');
    for (const name of DB_TOOL_NAMES) expect(tools[name]).toBeDefined();
  });

  it('gives normal and admin mode the identical toolset', () => {
    // chatMode is client-supplied and unauthenticated, so it must not decide
    // capability. If a future change makes the two modes differ again, that is
    // a self-granted privilege boundary and this fails.
    const normal = Object.keys(buildToolSet(baseCtx('normal'), [], 'fix')).sort();
    const admin = Object.keys(buildToolSet(baseCtx('admin'), [], 'fix')).sort();
    expect(normal).toEqual(admin);
  });

  it('excludes DB tools for guests, who are never project-access-checked', () => {
    // ai.routes.ts assigns `guest:<fingerprint>` when there is no authenticated
    // req.user, and skips getProject()/role checks entirely on that branch.
    const tools = buildToolSet(baseCtx('admin', 'guest:abc123'), [], 'fix');
    for (const name of DB_TOOL_NAMES) expect(tools[name]).toBeUndefined();
  });

  it('still gives guests the non-database tools', () => {
    // The guest exclusion must be surgical, not a blanket downgrade.
    const tools = buildToolSet(baseCtx('normal', 'guest:abc123'), [], 'fix');
    expect(tools['write_file']).toBeDefined();
    expect(tools['read_file']).toBeDefined();
  });

  it('never includes confirm_database_change, in any mode', () => {
    // The one gate that is real: only a human clicking confirm in the chat UI
    // can execute a staged dangerous statement.
    expect(buildToolSet(baseCtx('normal'), [], 'fix')['confirm_database_change']).toBeUndefined();
    expect(buildToolSet(baseCtx('admin'), [], 'fix')['confirm_database_change']).toBeUndefined();
  });

  it('keeps DB tools out of the micro tier regardless of mode', () => {
    for (const mode of ['normal', 'admin'] as const) {
      const tools = buildToolSet(baseCtx(mode), [], 'micro');
      for (const name of DB_TOOL_NAMES) expect(tools[name]).toBeUndefined();
    }
  });
});
