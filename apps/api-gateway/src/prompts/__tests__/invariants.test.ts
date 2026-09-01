/**
 * These rules must survive section-stripping into EVERY tier. Measured before
 * this existed: edit/fix/micro had all lost the secrets rule, and micro also
 * lacked the tool-first mandate AND the no-false-completion rule that the
 * runtime enforces with an abort. If a future strip drops one again, the
 * coverage test below fails instead of shipping a tier that was never told.
 */
import { describe, it, expect } from 'vitest';
import { withInvariantCore, missingInvariants, INVARIANTS } from '../invariants.js';
import {
  MICRO_SYSTEM_PROMPT,
  getFixSystemPrompt,
  getEditSystemPrompt,
  getAppBuilderBuildSystemPrompt,
} from '../app-builder.prompt.js';

const FULL_BUILD = getAppBuilderBuildSystemPrompt({
  includeRequirementGathering: true, includeStartingNewProject: true, includeSeo: true,
  includeIntegration: true, includeErrorPatterns: true, includeCapabilities: true,
  includePreviewEnvironment: true,
});

describe('invariant core', () => {
  it('every shipped tier covers every invariant once wrapped', () => {
    for (const prompt of [FULL_BUILD, getEditSystemPrompt(), getFixSystemPrompt(), MICRO_SYSTEM_PROMPT]) {
      expect(missingInvariants(withInvariantCore(prompt))).toEqual([]);
    }
  });

  it('leaves a prompt that already states everything byte-identical', () => {
    expect(withInvariantCore(FULL_BUILD)).toBe(FULL_BUILD);
  });

  it('is idempotent — applying twice adds nothing', () => {
    const once = withInvariantCore(MICRO_SYSTEM_PROMPT);
    expect(withInvariantCore(once)).toBe(once);
  });

  it('adds only the missing rules, not the whole set', () => {
    const edit = getEditSystemPrompt();
    const missingIds = missingInvariants(edit).map((i) => i.id);
    const added = withInvariantCore(edit).slice(edit.length);
    for (const inv of INVARIANTS) {
      // A rule already present must not be re-stated in the appended block.
      expect(added.includes(inv.text)).toBe(missingIds.includes(inv.id));
    }
  });

  it("each invariant's text satisfies its own marker (or it would re-append forever)", () => {
    for (const inv of INVARIANTS) {
      expect(inv.marker.test(inv.text)).toBe(true);
    }
  });
});
