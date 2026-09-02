/**
 * This becomes the answer to "what did the agent change?", which today is
 * answered two ways and both are wrong: a whole-directory walk (so the answer is
 * the project, not the change) and a parse of the model's closing narration (so
 * an aborted run that wrote six files reports zero).
 */
import { describe, expect, it } from 'vitest';
import { RunChangeSet, isTrackedMutation } from '../runChangeSet.js';

describe('RunChangeSet', () => {
  it('starts empty', () => {
    const cs = new RunChangeSet();
    expect(cs.isEmpty).toBe(true);
    expect(cs.touchedCount).toBe(0);
  });

  it('records each mutation kind under its own bucket', () => {
    const cs = new RunChangeSet();
    cs.record('write_file', 'src/App.tsx');
    cs.record('edit_file', 'src/lib/api.ts');
    cs.record('delete_file', 'src/old.ts');
    cs.record('rename_file', 'src/new.ts');

    const s = cs.summary();
    expect(s.written).toEqual(['src/App.tsx']);
    expect(s.edited).toEqual(['src/lib/api.ts']);
    expect(s.deleted).toEqual(['src/old.ts']);
    expect(s.renamed).toEqual(['src/new.ts']);
  });

  it('counts DISTINCT paths, not calls -- five edits to one file is one file', () => {
    const cs = new RunChangeSet();
    for (let i = 0; i < 5; i++) cs.record('edit_file', 'src/contexts/AppContext.tsx');
    expect(cs.touchedCount).toBe(1);
    expect(cs.summary().edited).toEqual(['src/contexts/AppContext.tsx']);
  });

  it('counts a path once even when both written and edited', () => {
    const cs = new RunChangeSet();
    cs.record('write_file', 'src/App.tsx');
    cs.record('edit_file', 'src/App.tsx');
    expect(cs.touchedCount).toBe(1);
    // but each kind still remembers it, so the push knows it was both
    expect(cs.summary().written).toEqual(['src/App.tsx']);
    expect(cs.summary().edited).toEqual(['src/App.tsx']);
  });

  it('ignores tools that do not mutate files', () => {
    const cs = new RunChangeSet();
    cs.record('read_file', 'src/App.tsx');
    cs.record('grep', 'src/App.tsx');
    cs.record('get_build_errors', '');
    expect(cs.isEmpty).toBe(true);
  });

  it('ignores a mutation with no path rather than recording an empty one', () => {
    const cs = new RunChangeSet();
    cs.record('write_file', '');
    expect(cs.isEmpty).toBe(true);
  });

  it('treats place_asset as a write, since it puts a file on disk', () => {
    const cs = new RunChangeSet();
    cs.record('place_asset', 'public/assets/logo.png');
    expect(cs.summary().written).toEqual(['public/assets/logo.png']);
  });
});

describe('isTrackedMutation', () => {
  it('accepts the file-mutating tools', () => {
    for (const t of ['write_file', 'edit_file', 'delete_file', 'rename_file', 'place_asset']) {
      expect(isTrackedMutation(t)).toBe(true);
    }
  });

  it('rejects read-only tools and undefined', () => {
    for (const t of ['read_file', 'grep', 'think', 'get_build_errors']) {
      expect(isTrackedMutation(t)).toBe(false);
    }
    expect(isTrackedMutation(undefined)).toBe(false);
  });
});
