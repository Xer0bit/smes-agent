/**
 * This decides what the model can see without spending a tool call. Measured
 * live: retrieval ranks ~199 files and returns 10, and this stage admitted 4 of
 * them while using 3.6 KB of an 8 KB budget -- so the caps here, not retrieval,
 * decided what the agent knew.
 */
import { describe, expect, it } from 'vitest';
import { capContextFiles, renderContextFiles } from '../agentContextSelection.js';

const budget = { maxFiles: 10, maxTotalChars: 8000, maxFileChars: 800, maxMentionedFileChars: 3000 };
const file = (path: string, len: number) => ({ path, content: 'x'.repeat(len) });
const none = new Set<string>();

describe('capContextFiles', () => {
  it('admits files in the order given, which is relevance order', () => {
    const r = capContextFiles([file('a.ts', 10), file('b.ts', 10), file('c.ts', 10)], none, budget);
    expect(r.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('stops at the file-count cap', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`f${i}.ts`, 10));
    expect(capContextFiles(files, none, { ...budget, maxFiles: 3 }).files).toHaveLength(3);
  });

  it('truncates a long file and labels it a peek, not silently', () => {
    const r = capContextFiles([file('big.ts', 5000)], none, budget);
    expect(r.files[0].truncated).toBe(true);
    expect(r.files[0].contextContent).toMatch(/peek only/);
    expect(r.files[0].contextContent).toMatch(/read_file\("big\.ts"\)/);
  });

  it('leaves a short file whole and unmarked', () => {
    const r = capContextFiles([file('small.ts', 100)], none, budget);
    expect(r.files[0].truncated).toBe(false);
    expect(r.files[0].contextContent).not.toMatch(/peek only/);
  });

  it('gives a directly-mentioned file the larger slice', () => {
    const mentioned = new Set(['named.ts']);
    const r = capContextFiles([file('named.ts', 2000)], mentioned, budget);
    // 2000 < maxMentionedFileChars(3000), so it is NOT truncated -- whereas the
    // ordinary 800 cap would have cut it.
    expect(r.files[0].truncated).toBe(false);
  });

  it('SKIPS an oversized file rather than ending the loop', () => {
    // One huge low-priority file must not shut out the smaller relevant files
    // behind it -- a `break` here would have.
    const files = [file('huge.ts', 100_000), file('small.ts', 50)];
    const r = capContextFiles(files, new Set(['huge.ts']), { ...budget, maxTotalChars: 1000 });
    expect(r.files.map((f) => f.path)).toEqual(['small.ts']);
  });

  it('respects the total character budget', () => {
    const files = Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`, 700));
    const r = capContextFiles(files, none, { ...budget, maxFiles: 50, maxTotalChars: 3000 });
    expect(r.totalChars).toBeLessThanOrEqual(3000);
  });

  it('admits the top file even when nothing fits, rather than sending no context', () => {
    const r = capContextFiles([file('only.ts', 50_000)], none, { ...budget, maxTotalChars: 10 });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe('only.ts');
  });

  it('returns nothing for an empty project rather than inventing a file', () => {
    expect(capContextFiles([], none, budget).files).toEqual([]);
  });
});

describe('renderContextFiles', () => {
  it('labels each file with a path header the model can cite', () => {
    const r = capContextFiles([file('src/App.tsx', 20)], none, budget);
    expect(renderContextFiles(r.files)).toMatch(/^=== src\/App\.tsx ===/);
  });

  it('renders nothing for no files', () => {
    expect(renderContextFiles([])).toBe('');
  });
});
