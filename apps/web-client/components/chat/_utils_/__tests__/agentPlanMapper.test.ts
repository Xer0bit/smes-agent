import { describe, it, expect } from 'vitest';
import { applyStepToTasks, finalizeTasks } from '../agentPlanMapper';
import type { Task } from '@/components/ui/agent-plan';

describe('applyStepToTasks', () => {
  it('creates a Planning task titled with the real narration text', () => {
    const tasks = applyStepToTasks([], { tools: ['think'], statusText: 'Understanding the request' }, 0);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('planning');
    expect(tasks[0].status).toBe('in-progress');
    expect(tasks[0].subtasks[0].title).toBe('Understanding the request');
    expect(tasks[0].subtasks[0].tools).toEqual(['think']);
  });

  it('never invents placeholder text -- a step with no narration and no prior subtask creates nothing', () => {
    const tasks = applyStepToTasks([], { tools: ['write_edge_function'] }, 0);
    expect(tasks).toEqual([]);
  });

  it('a step with no narration merges into the current subtask instead of spawning a new row (collapses raw tool calls under one mission line)', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['write_file'], statusText: 'Building the homepage' }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['edit_file'] }, 1); // no fresh narration
    tasks = applyStepToTasks(tasks, { tools: ['run_command'] }, 2); // still no fresh narration

    expect(tasks[0].subtasks).toHaveLength(1);
    expect(tasks[0].subtasks[0].title).toBe('Building the homepage');
    expect(tasks[0].subtasks[0].tools).toEqual(['write_file', 'edit_file', 'run_command']);
  });

  it('a new distinct narration for the same category starts a new subtask, not a merge', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['think'], statusText: 'Reading the request' }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['think'], statusText: 'Drafting the blueprint' }, 1);

    expect(tasks[0].subtasks).toHaveLength(2);
    expect(tasks[0].subtasks.map((s) => s.title)).toEqual(['Reading the request', 'Drafting the blueprint']);
  });

  it('creates categories lazily, in first-touched order, and marks the prior one completed', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['think'], statusText: 'Understanding the request' }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['write_file'], statusText: 'Building the homepage' }, 1);

    expect(tasks.map((t) => t.id)).toEqual(['planning', 'code']);
    expect(tasks[0].status).toBe('completed'); // planning done, code now active
    expect(tasks[1].status).toBe('in-progress');
  });

  it('never shows a category the run never touched (e.g. no database work = no Database task)', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['think'], statusText: 'Understanding the request' }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['write_file'], statusText: 'Building the homepage' }, 1);
    tasks = applyStepToTasks(tasks, { tools: ['get_build_errors'], statusText: 'Checking the app compiles' }, 2);

    expect(tasks.some((t) => t.id === 'database')).toBe(false);
    expect(tasks.some((t) => t.id === 'edge-functions')).toBe(false);
  });

  it('prioritizes the more significant category when a step mixes tool types', () => {
    const tasks = applyStepToTasks([], { tools: ['read_file', 'query_database'], statusText: 'Setting up the database' }, 0);
    expect(tasks[0].id).toBe('database');
  });

  it('marks a subtask failed on hadFailedEdits and propagates to the task', () => {
    const tasks = applyStepToTasks([], { tools: ['edit_file'], statusText: 'Fixing the header', hadFailedEdits: true }, 0);
    expect(tasks[0].subtasks[0].status).toBe('failed');
    expect(tasks[0].status).toBe('failed');
  });

  it('marks a subtask need-help when the step flags it (e.g. a pending confirmation)', () => {
    const tasks = applyStepToTasks([], { tools: ['query_database'], statusText: 'Waiting on a confirmation', needsAttention: true }, 0);
    expect(tasks[0].subtasks[0].status).toBe('need-help');
  });

  it('a no-narration step after a failure still merges and can flip that subtask back via a later failure state', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['edit_file'], statusText: 'Fixing the header', hadFailedEdits: true }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['edit_file'] }, 1); // no narration, merges, succeeds this time

    expect(tasks[0].subtasks).toHaveLength(1);
    expect(tasks[0].subtasks[0].status).toBe('completed');
    expect(tasks[0].status).toBe('in-progress');
  });

  it('re-activates a category revisited later in the run instead of duplicating it', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['write_file'], statusText: 'Building the homepage' }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['get_build_errors'], statusText: 'Checking the app compiles' }, 1);
    tasks = applyStepToTasks(tasks, { tools: ['edit_file'], statusText: 'Fixing a build error' }, 2); // back to code after a failed build check

    expect(tasks.filter((t) => t.id === 'code')).toHaveLength(1);
    expect(tasks.find((t) => t.id === 'code')!.subtasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === 'code')!.status).toBe('in-progress');
    expect(tasks.find((t) => t.id === 'testing')!.status).toBe('completed');
  });

  it('recovers a category back to in-progress after a transient failure, once a later step in it succeeds', () => {
    let tasks: Task[] = [];
    tasks = applyStepToTasks(tasks, { tools: ['edit_file'], statusText: 'Fixing the header', hadFailedEdits: true }, 0);
    expect(tasks.find((t) => t.id === 'code')!.status).toBe('failed');

    tasks = applyStepToTasks(tasks, { tools: ['get_build_errors'], statusText: 'Checking the app compiles' }, 1); // code no longer active
    tasks = applyStepToTasks(tasks, { tools: ['edit_file'], statusText: 'Fixing it properly this time' }, 2); // back to code, this time it works

    expect(tasks.find((t) => t.id === 'code')!.status).toBe('in-progress');
  });

  it('ignores a step with no tools', () => {
    const tasks = applyStepToTasks([], { tools: [] }, 0);
    expect(tasks).toEqual([]);
  });
});

describe('finalizeTasks', () => {
  it('flips the currently in-progress task to completed', () => {
    const tasks = applyStepToTasks([], { tools: ['write_file'], statusText: 'Building the homepage' }, 0);
    const finalized = finalizeTasks(tasks, false);
    expect(finalized[0].status).toBe('completed');
  });

  it('flips the currently in-progress task to failed when the run failed', () => {
    const tasks = applyStepToTasks([], { tools: ['write_file'], statusText: 'Building the homepage' }, 0);
    const finalized = finalizeTasks(tasks, true);
    expect(finalized[0].status).toBe('failed');
  });

  it('leaves already-completed tasks untouched', () => {
    let tasks = applyStepToTasks([], { tools: ['think'], statusText: 'Understanding the request' }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['write_file'], statusText: 'Building the homepage' }, 1);
    const finalized = finalizeTasks(tasks, false);
    expect(finalized.find((t) => t.id === 'planning')!.status).toBe('completed');
    expect(finalized.find((t) => t.id === 'code')!.status).toBe('completed');
  });

  it('clears a stale failed/in-progress category back to completed once the overall run succeeds -- no ugly stuck UI', () => {
    let tasks = applyStepToTasks([], { tools: ['edit_file'], statusText: 'Fixing the header', hadFailedEdits: true }, 0);
    tasks = applyStepToTasks(tasks, { tools: ['get_build_errors'], statusText: 'Checking the app compiles' }, 1);
    const finalized = finalizeTasks(tasks, false);

    expect(finalized.find((t) => t.id === 'code')!.status).toBe('completed');
    expect(finalized.find((t) => t.id === 'testing')!.status).toBe('completed');
  });
});
