/**
 * Increment-3 diagnose-before-fix invariants.
 *
 * The pass's entire safety claim is structural: it runs with a READ-ONLY tool
 * set, so it cannot mutate a project however the model behaves. That claim is
 * only true as long as no mutation tool leaks into DIAGNOSIS_TOOL_NAMES -- this
 * test is what turns "we were careful" into "CI fails if anyone adds one".
 *
 * The other two helpers decide what the pass DID: which files it read (from
 * tool-call args, not prose) and whether that's a usable enough result to seed
 * scope. Both feed the scope gate, so a wrong `<= 10` or a dropped `.trim()`
 * would either lock the wrong files or seed on an empty diagnosis.
 */
import { describe, it, expect } from 'vitest';
import {
  DIAGNOSIS_TOOL_NAMES,
  MUTATION_TOOL_NAMES,
  extractImplicatedFiles,
  shouldSeedScope,
} from '../agentGating.js';

describe('DIAGNOSIS_TOOL_NAMES is read-only by construction', () => {
  it('contains no mutation tool', () => {
    for (const mut of MUTATION_TOOL_NAMES) {
      expect(DIAGNOSIS_TOOL_NAMES.has(mut)).toBe(false);
    }
  });

  it('is exactly the expected read-only set (adding/removing one is a deliberate change)', () => {
    expect([...DIAGNOSIS_TOOL_NAMES].sort()).toEqual(
      ['get_build_errors', 'glob_files', 'grep', 'list_files', 'read_file', 'read_files', 'think'],
    );
  });
});

describe('extractImplicatedFiles', () => {
  it('collects read_file.path and every read_files.paths entry', () => {
    const steps = [
      { toolCalls: [{ toolName: 'read_file', input: { path: 'src/App.tsx' } }] },
      { toolCalls: [{ toolName: 'read_files', input: { paths: ['src/a.ts', 'src/b.ts'] } }] },
    ];
    expect([...extractImplicatedFiles(steps)].sort()).toEqual(['src/App.tsx', 'src/a.ts', 'src/b.ts']);
  });

  it('ignores non-read tool calls and malformed args, and handles no steps', () => {
    const steps = [
      { toolCalls: [{ toolName: 'grep', input: { pattern: 'x' } }] },
      { toolCalls: [{ toolName: 'read_file', input: { path: 42 } }] },
      { toolCalls: [{ toolName: 'read_files', input: { paths: 'not-an-array' } }] },
    ];
    expect(extractImplicatedFiles(steps).size).toBe(0);
    expect(extractImplicatedFiles(undefined).size).toBe(0);
  });
});

describe('shouldSeedScope', () => {
  it('seeds on a focused, non-empty result with real text', () => {
    expect(shouldSeedScope(new Set(['a.ts']), 'the navbar file needs the import fixed')).toBe(true);
  });

  it('does not seed on empty files, an over-broad set (>10), or blank text', () => {
    expect(shouldSeedScope(new Set(), 'text')).toBe(false);
    const eleven = new Set(Array.from({ length: 11 }, (_, i) => `f${i}.ts`));
    expect(shouldSeedScope(eleven, 'text')).toBe(false);
    expect(shouldSeedScope(new Set(['a.ts']), '   ')).toBe(false);
    expect(shouldSeedScope(new Set(['a.ts']), undefined)).toBe(false);
  });
});
