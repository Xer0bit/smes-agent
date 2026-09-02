/**
 * Verifies CP4a retrieval-consult telemetry (measurement only, no gate --
 * see docs/spec/agent-orchestration-stability.md): agentToolSet.ts's
 * generic tool-dispatch point sets ctx.retrievalConsulted the first time
 * search_codebase/grep/glob_files runs this run, and the read-before-write
 * guard's existing existsSync check is reused to count net-new write_file
 * calls (and the subset of those with no prior retrieval consult). Exercised
 * through the real buildToolSet dispatch path, not a reimplementation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCallOptions } from 'ai';

// agentToolSet.ts -> propose_plan.ts -> config/database.js throws at module
// load if SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY are unset -- not
// exercised by anything under test here, same stub pattern
// agentToolSet.scopeGate.test.ts uses.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

import { buildToolSet } from '../agentToolSet.js';
import type { AgentContext } from '../../agent-tools/types.js';

const toolOpts: ToolCallOptions = { toolCallId: 'test-call', messages: [] };

describe('agentToolSet retrieval-consult telemetry (CP4a)', () => {
  let tmpDir: string;
  let ctx: AgentContext;
  let toolSet: ReturnType<typeof buildToolSet>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomgear-retrieval-telemetry-'));
    ctx = {
      appPath: tmpDir,
      projectId: 'test-project',
      onXmlComplete: () => {},
      readFiles: new Set<string>(),
    };
    toolSet = buildToolSet(ctx, [], undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) a net-new write with zero prior retrieval calls increments both counters, result unchanged', async () => {
    expect(ctx.netNewWriteCount).toBeUndefined();
    expect(ctx.netNewWriteWithoutRetrievalCount).toBeUndefined();

    const result = await toolSet.write_file.execute(
      { path: 'src/NewComponent.tsx', content: 'export default function NewComponent() { return null; }' },
      toolOpts,
    );

    expect(result.split('\n')[0]).toBe('Successfully wrote src/NewComponent.tsx');
    expect(ctx.netNewWriteCount).toBe(1);
    expect(ctx.netNewWriteWithoutRetrievalCount).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'src/NewComponent.tsx'))).toBe(true);
  });

  it('(b) a net-new write preceded by glob_files increments only netNewWriteCount', async () => {
    const searchResult = await toolSet.glob_files.execute({ pattern: '**/*.tsx' }, toolOpts);
    expect(typeof searchResult).toBe('string');
    expect(ctx.retrievalConsulted).toBe(true);

    const result = await toolSet.write_file.execute(
      { path: 'src/AnotherComponent.tsx', content: 'export default function AnotherComponent() { return null; }' },
      toolOpts,
    );

    expect(result.split('\n')[0]).toBe('Successfully wrote src/AnotherComponent.tsx');
    expect(ctx.netNewWriteCount).toBe(1);
    expect(ctx.netNewWriteWithoutRetrievalCount).toBeUndefined();
  });

  it('(c) editing an existing (already-read) file touches neither counter, result unchanged', async () => {
    const relPath = 'src/Existing.tsx';
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const original = 'function a() {\n  return 1;\n}\n';
    fs.writeFileSync(path.join(tmpDir, relPath), original);
    ctx.readFiles!.add(relPath);

    const result = await toolSet.edit_file.execute(
      {
        path: relPath,
        diff: '<<<<<<< SEARCH\nfunction a() {\n  return 1;\n}\n=======\nfunction a() {\n  return 2;\n}\n>>>>>>> REPLACE',
      },
      toolOpts,
    );

    expect(result.split('\n')[0]).toBe(`Successfully edited ${relPath}`);
    expect(ctx.netNewWriteCount).toBeUndefined();
    expect(ctx.netNewWriteWithoutRetrievalCount).toBeUndefined();
    expect(fs.readFileSync(path.join(tmpDir, relPath), 'utf8')).toBe('function a() {\n  return 2;\n}\n');
  });

  it('(d) tool return values are byte-identical to current (untelemetered) behavior', async () => {
    const netNewResult = await toolSet.write_file.execute(
      { path: 'src/Plain.tsx', content: 'export default function Plain() { return null; }' },
      toolOpts,
    );
    expect(netNewResult.split('\n')[0]).toBe('Successfully wrote src/Plain.tsx');
    expect(netNewResult).not.toMatch(/retriev|telemetry|net-new/i);
  });
});
