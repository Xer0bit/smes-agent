/**
 * The preamble's whole value is that it cannot drift from what the gates
 * enforce. These assert it is generated from the shared constants, not restated
 * prose -- a description that can go stale is worse than none, because it is
 * believed. (See the edge-function validator, which told the agent hashing was
 * impossible while two hashing primitives were available.)
 */
import { describe, expect, it } from 'vitest';
import { buildCapabilityPreamble, isSourceTruncated } from '../capabilities.js';
import { TIER_FILE_CAPS, TIER_MAX_STEPS } from '../../services/intentClassifier.js';

describe('buildCapabilityPreamble', () => {
  it('states the file cap the gate actually enforces, for every capped tier', () => {
    for (const tier of ['micro', 'edit', 'fix'] as const) {
      const cap = TIER_FILE_CAPS[tier];
      expect(cap).toBeGreaterThan(0);
      expect(buildCapabilityPreamble(tier, [])).toMatch(new RegExp(`${cap} distinct files`));
    }
  });

  it('states the step budget from the same table the loop uses', () => {
    expect(buildCapabilityPreamble('fix', [])).toMatch(new RegExp(`up to ${TIER_MAX_STEPS.fix}`));
    expect(buildCapabilityPreamble('build', [])).toMatch(new RegExp(`up to ${TIER_MAX_STEPS.build}`));
  });

  it('says uncapped rather than inventing a number for tiers with no cap', () => {
    // feature/build are absent from TIER_FILE_CAPS; claiming a cap would be a lie.
    expect(TIER_FILE_CAPS.feature).toBe(undefined);
    const p = buildCapabilityPreamble('feature', []);
    expect(p).toMatch(/no fixed cap/i);
    expect(p).not.toMatch(/distinct files\*\*/);
  });

  it('lists the tools this run actually received', () => {
    const p = buildCapabilityPreamble('edit', ['read_file', 'edit_file']);
    expect(p).toMatch(/read_file/);
    expect(p).toMatch(/edit_file/);
  });

  it('names withheld tools so the agent does not plan around them', () => {
    const p = buildCapabilityPreamble('micro', ['read_file'], ['publish_site']);
    expect(p).toMatch(/Not available on this tier/);
    expect(p).toMatch(/publish_site/);
  });

  it('warns that a write staleness-invalidates an earlier read', () => {
    // Same rule as staleViewNotice, stated before the fact rather than after.
    expect(buildCapabilityPreamble('edit', [])).toMatch(/stale/i);
  });

  it('returns nothing when there is no tier, rather than guessing', () => {
    expect(buildCapabilityPreamble(undefined, ['read_file'])).toBe('');
  });
});

/**
 * The scale guard. On 2026-09-02 a run was handed a 25-file copy of a 199-file
 * project; the tree it saw was internally consistent, so it concluded the app
 * was missing and rebuilt the UI. The agent had no reference for how big the
 * project should be -- `file_count` appeared nowhere in any prompt.
 */
describe('buildCapabilityPreamble: project scale', () => {
  it('warns loudly when the visible source is far smaller than the project history', () => {
    const p = buildCapabilityPreamble('edit', [], [], { sourceFiles: 25, expectedFiles: 199 });
    expect(p).toMatch(/STOP/);
    expect(p).toMatch(/25 files/);
    expect(p).toMatch(/199/);
    expect(p).toMatch(/[Dd]o not recreate/);
  });

  it('states the size plainly when the source looks complete', () => {
    const p = buildCapabilityPreamble('edit', [], [], { sourceFiles: 199, expectedFiles: 199 });
    expect(p).not.toMatch(/STOP/);
    expect(p).toMatch(/199 source files/);
  });

  it('tolerates a modest shortfall without crying wolf', () => {
    // Build output and untracked files legitimately differ from a revision count.
    const p = buildCapabilityPreamble('edit', [], [], { sourceFiles: 180, expectedFiles: 199 });
    expect(p).not.toMatch(/STOP/);
  });

  it('says nothing about scale when history is unknown', () => {
    const p = buildCapabilityPreamble('edit', [], [], { sourceFiles: 12, expectedFiles: 0 });
    expect(p).not.toMatch(/STOP/);
    expect(p).not.toMatch(/source files/);
  });

  it('carries the no-rebuild rule even without scale data', () => {
    expect(buildCapabilityPreamble('edit', [])).toMatch(/NEVER rebuild or replace an existing app/);
  });
});

describe('isSourceTruncated', () => {
  it('fires on the CardPro shape', () => {
    expect(isSourceTruncated(25, 199)).toBe(true);
  });

  it('does not fire on a small honest shortfall', () => {
    expect(isSourceTruncated(180, 199)).toBe(false);
  });

  it('never judges a small project', () => {
    expect(isSourceTruncated(1, 5)).toBe(false);
  });

  it('treats unknown history as no opinion, never as empty', () => {
    expect(isSourceTruncated(0, 0)).toBe(false);
  });
});
