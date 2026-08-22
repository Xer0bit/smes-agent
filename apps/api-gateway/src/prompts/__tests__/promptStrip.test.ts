/**
 * Prompt section-stripping is done by matching heading TEXT, so renaming a
 * heading silently turns its strip into a no-op: the prompt just gets bigger
 * and nothing reports it.
 *
 * That is a real, shipped regression, not a hypothetical. 'Integration And
 * Database Guidance' was never an actual heading, so fix tier carried the
 * full ~16.6K-char hosted-database section on EVERY request until someone
 * measured the rendered output (2026-08-11/12) -- silently paying for it on
 * every single agent run in between.
 *
 * These tests make the next rename fail here instead.
 */
import { describe, it, expect } from 'vitest';
import {
  auditPromptStrips,
  getEditSystemPrompt,
  getFixSystemPrompt,
  getAppBuilderBuildSystemPrompt,
} from '../app-builder.prompt.js';

describe('prompt strip integrity', () => {
  it('every strip title still matches a real heading', () => {
    const misses = auditPromptStrips();
    const detail = [...misses.entries()]
      .map(([ctx, titles]) => `${ctx}: ${titles.join(' | ')}`)
      .join('\n');
    expect(
      misses.size,
      `Strip titles that matched nothing (a heading was renamed, so its section is now\n` +
      `silently shipping in every affected run):\n${detail}`,
    ).toBe(0);
  });

  // Guards the specific section whose silent no-op caused the original
  // incident. Cheap, and states the intent in a way a rename cannot satisfy
  // accidentally.
  it('the hosted-database section is actually absent from the small tiers', () => {
    for (const [tier, prompt] of [
      ['edit', getEditSystemPrompt()],
      ['fix', getFixSystemPrompt()],
    ] as const) {
      expect(prompt.includes('Hosted database (paid plans only):'), `${tier} still carries it`).toBe(false);
    }
  });

  it('small tiers stay materially smaller than the full build prompt', () => {
    const full = getAppBuilderBuildSystemPrompt({
      includeRequirementGathering: true, includeStartingNewProject: true, includeSeo: true,
      includeIntegration: true, includeErrorPatterns: true, includeCapabilities: true,
      includePreviewEnvironment: true,
    });
    // Not a fixed byte budget -- that would fail on every legitimate prompt
    // edit. This asserts the RELATIONSHIP: if stripping breaks, the small
    // tiers converge on the full prompt and this catches it.
    expect(getEditSystemPrompt().length).toBeLessThan(full.length * 0.75);
    expect(getFixSystemPrompt().length).toBeLessThan(full.length * 0.75);
  });
});
