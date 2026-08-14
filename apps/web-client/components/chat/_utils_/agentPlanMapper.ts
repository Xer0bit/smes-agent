import type { Task, Subtask } from '@/components/ui/agent-plan';

/**
 * Turns the agent loop's real per-step events (real tool names from
 * onStepFinish -- write_file, query_database, write_edge_function,
 * get_build_errors, think, etc, see apps/api-gateway/src/agent-tools/)
 * into the Task/Subtask tree agent-plan.tsx renders. No fake/demo data,
 * no random status -- every task/subtask here corresponds to a real step
 * the agent actually took.
 */

export interface PlanStepInput {
  /** Real tool names used in this step, from StepFinishData.tools. */
  tools: string[];
  /** The real status/narration text active when this step finished, if any. */
  statusText?: string;
  /** StepFinishData.failedEdits > 0 for this step. */
  hadFailedEdits?: boolean;
  /** True when the step's own tool result text signals a blocked/pending-confirmation state. */
  needsAttention?: boolean;
}

interface CategoryDef {
  key: string;
  title: string;
  tools: Set<string>;
}

// Ordered by display priority when a single step mixes tool categories
// (e.g. a step that both reads a file and calls query_database) -- the
// more significant action wins the category for that step.
const CATEGORIES: CategoryDef[] = [
  {
    key: 'edge-functions',
    title: 'Edge Functions',
    tools: new Set(['write_edge_function', 'confirm_edge_function_deploy', 'delete_edge_function']),
  },
  {
    key: 'database',
    title: 'Database',
    tools: new Set(['get_database_schema', 'query_database', 'confirm_database_change', 'provision_database', 'test_database_function']),
  },
  {
    key: 'publishing',
    title: 'Publishing',
    tools: new Set(['publish_site', 'push_to_github']),
  },
  {
    key: 'testing',
    title: 'Testing & Verification',
    tools: new Set(['get_build_errors']),
  },
  {
    key: 'code',
    title: 'Writing Code',
    tools: new Set([
      'write_file', 'edit_file', 'delete_file', 'rename_file', 'run_command',
      'place_asset', 'replace_asset_references', 'read_file', 'read_files',
      'list_files', 'glob_files', 'grep', 'set_secret', 'list_secrets', 'sanitize',
    ]),
  },
  {
    key: 'planning',
    title: 'Planning',
    tools: new Set(['think', 'propose_plan', 'declare_scope', 'search_codebase', 'find_symbol_usages', 'search_org_knowledge']),
  },
];

const TOOL_TO_CATEGORY = new Map<string, CategoryDef>();
for (const cat of CATEGORIES) {
  for (const tool of cat.tools) TOOL_TO_CATEGORY.set(tool, cat);
}

function categorize(tools: string[]): CategoryDef {
  for (const cat of CATEGORIES) {
    if (tools.some((t) => cat.tools.has(t))) return cat;
  }
  // Unknown/new tool not yet in the map -- fall back to Code rather than
  // silently dropping the step.
  return CATEGORIES.find((c) => c.key === 'code')!;
}

/**
 * Apply one real agent step to the running task list. Pure function --
 * returns a new array, safe to use directly in a React state updater.
 * Tasks are created lazily, in first-touched order, so a run that never
 * touches the database never shows a "Database" row at all.
 *
 * No hardcoded status text anywhere: a subtask's title is always the real
 * LLM-written narration for that step (step.statusText, from
 * narration.service.ts). A step that finished with no narration yet
 * doesn't invent a generic label and doesn't get its own row -- it merges
 * into the current subtask (accumulating tools, updating status) instead.
 * This also keeps the list from ballooning into one row per raw tool call:
 * several tool calls covered by the same narration collapse into one
 * "mission" line with a growing tools list, matching what the agent is
 * actually telling the user it's doing, not every individual call it makes.
 */
export function applyStepToTasks(tasks: Task[], step: PlanStepInput, stepIndex: number): Task[] {
  if (!step.tools || step.tools.length === 0) return tasks;

  const category = categorize(step.tools);
  const narration = step.statusText?.trim();
  const subtaskStatus = step.hadFailedEdits ? 'failed' : step.needsAttention ? 'need-help' : 'completed';

  const next = tasks.map((t) => ({ ...t, subtasks: [...t.subtasks] }));
  const existingIdx = next.findIndex((t) => t.id === category.key);

  if (existingIdx !== -1 && !narration) {
    // No fresh narration for this step -- fold it into the category's
    // current subtask rather than inventing a title for a new one.
    const task = next[existingIdx];
    const current = task.subtasks.at(-1);
    if (current) {
      current.tools = [...new Set([...(current.tools ?? []), ...step.tools])];
      current.status = subtaskStatus;
      task.status = subtaskStatus === 'failed' ? 'failed' : 'in-progress';
      for (const t of next) {
        if (t.id !== category.key && t.status === 'in-progress') {
          t.status = t.subtasks.some((s) => s.status === 'failed') ? 'failed' : 'completed';
        }
      }
      return next;
    }
  }

  if (!narration) {
    // Brand-new category but no narration text yet to title it with --
    // wait for the real narration (arrives moments later) instead of
    // showing a placeholder the agent never actually said.
    return tasks;
  }

  const newSubtask: Subtask = {
    id: `${category.key}-${stepIndex}`,
    title: narration,
    description: '',
    status: subtaskStatus,
    priority: 'medium',
    tools: [...new Set(step.tools)],
  };

  if (existingIdx === -1) {
    // Newly touched category: mark every previously-active task completed
    // (unless it currently has a failed subtask), then add this one as the
    // new in-progress task.
    for (const t of next) {
      if (t.status === 'in-progress') t.status = t.subtasks.some((s) => s.status === 'failed') ? 'failed' : 'completed';
    }
    next.push({
      id: category.key,
      title: category.title,
      description: '',
      status: subtaskStatus === 'failed' ? 'failed' : 'in-progress',
      priority: 'medium',
      level: 0,
      dependencies: [],
      subtasks: [newSubtask],
    });
  } else {
    const task = next[existingIdx];
    task.subtasks.push(newSubtask);
    // A transient failure (e.g. one edit conflict that got auto-retried)
    // should NOT permanently pin this category red for the rest of the run
    // -- a later successful step in the same category recovers it back to
    // in-progress, same as if the failure never happened. finalizeTasks is
    // what decides the true final color once the whole run settles.
    task.status = subtaskStatus === 'failed' ? 'failed' : 'in-progress';
    for (const t of next) {
      if (t.id !== category.key && t.status === 'in-progress') {
        t.status = t.subtasks.some((s) => s.status === 'failed') ? 'failed' : 'completed';
      }
    }
  }

  return next;
}

/**
 * Call once the whole run finishes. A successful run means every category
 * that was touched genuinely worked out -- even one that hit a transient
 * failure mid-run and recovered -- so nothing should still be showing red
 * or a spinner once the generated app is actually live; that reads as
 * broken/stuck even though it isn't. A failed run marks every not-yet-
 * completed category failed, since the run genuinely didn't finish --
 * already-completed categories (superseded earlier in the run) keep that
 * status, since that work really did land before the later failure.
 */
export function finalizeTasks(tasks: Task[], runFailed: boolean): Task[] {
  return tasks.map((t) => {
    if (t.status === 'completed') return t;
    return { ...t, status: runFailed ? 'failed' : 'completed' };
  });
}
