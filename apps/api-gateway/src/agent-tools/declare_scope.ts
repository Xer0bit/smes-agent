/**
 * declare_scope tool   turn-scoped file-path guard (harness redesign,
 * increment 2). Root-cause audit finding (2026-08-11): nothing in the tool
 * set restricts WHICH files a write_file/edit_file/delete_file/rename_file
 * call can target   only how many (TIER_FILE_CAPS) and a traversal guard
 * (safeJoin). A "fix the logo" request could (and did) wander into fixing
 * unrelated pre-existing bugs across the whole codebase with nothing to
 * stop it.
 *
 * This tool lets the model declare, up front, which files/directories a
 * task will touch. Calling it is OPT-IN, not required -- if it's never
 * called, ctx.declaredScope stays undefined and the scope gate in
 * agentToolSet.ts is a no-op, byte-identical to today's behavior. This is
 * deliberately turn-scoped in-memory state, not a persisted artifact   same
 * shape as ctx.activeHypothesis (root-cause-lock), not propose_plan's
 * agent_plans row: this is a per-run guardrail, not a cross-session record.
 *
 * Re-declaring supersedes the previous declaration silently, same pattern
 * propose_plan.ts already uses for a new plan superseding an old one   no
 * separate "amend scope" tool needed if the model discovers it needs to
 * touch more files mid-run.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';

/** Strip leading/trailing slashes and normalize backslashes, same convention write_file.ts uses for path comparisons. */
export function normalizeScopePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * True if targetPath is exactly a declared path, or nested under one treated
 * as a directory prefix (every declared entry works as both   "src/pages/
 * checkout" and "src/pages/checkout/" are equivalent after normalization).
 */
export function pathMatchesScope(targetPath: string, declaredScope: Set<string>): boolean {
  const target = normalizeScopePath(targetPath);
  for (const raw of declaredScope) {
    // Normalize each declared entry too, not just the target -- this tool's
    // own execute() always pre-normalizes before building the Set, but this
    // function shouldn't silently depend on every future caller doing the
    // same (e.g. a later pass seeding ctx.declaredScope directly from a
    // diagnosis result). A trailing slash left un-normalized here would
    // silently fail every match under it (found by the increment-2 test).
    const declared = normalizeScopePath(raw);
    if (target === declared) return true;
    if (target.startsWith(`${declared}/`)) return true;
  }
  return false;
}

const schema = z.object({
  paths: z.array(z.string()).min(1).max(40).describe(
    'Project-relative file paths this task will touch, OR directory prefixes ' +
    '(e.g. "src/pages/checkout" covers every file under it) for broader tasks. ' +
    'Be generous if you are not certain yet   this is a soft guide the harness warns on, not a hard limit.'
  ),
  reason: z.string().max(200).optional().describe('One short sentence on why these files/areas are in scope.'),
});

export const declareScopeTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'declare_scope',
  description:
    'Declare which files or directories this task will touch, BEFORE your first write_file/edit_file/' +
    'delete_file/rename_file call. This does not touch any project files   it only tells the harness what\'s ' +
    'in scope so it can warn you if a later write drifts outside it (a sign you\'ve wandered from the actual ' +
    'request into something unrelated). Call this once per task; if you discover you genuinely need to touch ' +
    'more files partway through, call it again with the expanded list   it replaces the previous declaration.',
  inputSchema: schema,

  execute: async (args, ctx: AgentContext) => {
    ctx.declaredScope = new Set(args.paths.map(normalizeScopePath));
    ctx.scopeViolationCount = 0;
    return (
      `Scope declared: ${args.paths.length} path${args.paths.length === 1 ? '' : 's'}/prefix${args.paths.length === 1 ? '' : 'es'}. ` +
      `Stay within these unless the task genuinely requires more   if it does, explain why and call declare_scope again with the wider set.`
    );
  },
};
