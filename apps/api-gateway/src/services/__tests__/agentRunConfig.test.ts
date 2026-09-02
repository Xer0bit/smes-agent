/**
 * First extraction from _runAgentLoopInner (#2). These four decisions governed
 * every run's step budget, token ceiling, execution mode and model, and existed
 * only as inline expressions inside a ~5,300-line function, so none of them
 * could be tested at all.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveRuntimeMode,
  resolveStepBudget,
  resolveTokenCap,
  substituteDisabledModel,
} from '../agentRunConfig.js';
import { TIER_MAX_STEPS } from '../intentClassifier.js';

describe('resolveStepBudget', () => {
  it('uses the shared tier table, not a second copy of it', () => {
    // The loop previously carried its own ladder under a comment reading
    // "Values must match TIER_MAX_STEPS in intentClassifier.ts".
    for (const tier of ['micro', 'fix', 'edit', 'feature', 'build'] as const) {
      expect(resolveStepBudget(tier, { promptLength: 10 })).toBe(TIER_MAX_STEPS[tier]);
    }
  });

  it('treats a tier-less website build as build-shaped', () => {
    expect(resolveStepBudget(undefined, { isWebsiteBuild: true, promptLength: 10 })).toBe(45);
  });

  it('treats a long tier-less prompt as build-shaped', () => {
    expect(resolveStepBudget(undefined, { promptLength: 601 })).toBe(45);
    expect(resolveStepBudget(undefined, { promptLength: 600 })).toBe(25);
  });

  it('defaults a short tier-less prompt to the edit ceiling', () => {
    expect(resolveStepBudget(undefined, { promptLength: 20 })).toBe(25);
  });
});

describe('resolveTokenCap', () => {
  it('gives each tier its own ceiling', () => {
    expect(resolveTokenCap('micro')).toBe(160_000);
    expect(resolveTokenCap('build')).toBe(1_600_000);
    expect(resolveTokenCap('edit')).toBeGreaterThan(resolveTokenCap('fix'));
  });

  it('lets the env LOWER a ceiling', () => {
    expect(resolveTokenCap('build', '50000')).toBe(50_000);
  });

  it('never lets the env RAISE one past the tier', () => {
    // A misconfigured env must not hand a micro run a build-sized budget.
    expect(resolveTokenCap('micro', '9999999')).toBe(160_000);
  });

  it('ignores a junk env value rather than collapsing the budget to NaN', () => {
    expect(resolveTokenCap('edit', 'not-a-number')).toBe(900_000);
    expect(resolveTokenCap('edit', '0')).toBe(900_000);
  });

  it('falls back to the build ceiling with no tier', () => {
    expect(resolveTokenCap(undefined)).toBe(1_600_000);
  });
});

describe('resolveRuntimeMode', () => {
  it('runs build mode as build', () => {
    expect(resolveRuntimeMode('build', 'anything')).toBe('build');
    expect(resolveRuntimeMode(undefined, 'anything')).toBe('build');
  });

  it('keeps plan mode planning for an ordinary request', () => {
    expect(resolveRuntimeMode('plan', 'add a pricing page')).toBe('plan');
  });

  it('switches plan to build when the user confirms execution', () => {
    for (const p of ['go ahead', 'do it', 'yes', 'ship it', 'proceed', 'apply', 'make the changes']) {
      expect(resolveRuntimeMode('plan', p)).toBe('build');
    }
  });

  it('does not fire on a word that merely starts similarly', () => {
    expect(resolveRuntimeMode('plan', 'yesterday the build broke')).toBe('plan');
    expect(resolveRuntimeMode('plan', 'running totals are wrong')).toBe('plan');
  });

  it('tolerates leading whitespace, since it reads raw user text', () => {
    expect(resolveRuntimeMode('plan', '  do it  ')).toBe('build');
  });
});

describe('substituteDisabledModel', () => {
  it('passes through a model that is not disabled', () => {
    const r = substituteDisabledModel('claude-sonnet-5', 'gemini-3.1-pro-preview', 'fallback');
    expect(r).toEqual({ modelId: 'claude-sonnet-5', substituted: false });
  });

  it('swaps a disabled model for the fallback', () => {
    const r = substituteDisabledModel('gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro');
    expect(r).toEqual({ modelId: 'gemini-2.5-pro', substituted: true });
  });

  it('handles a list with spacing and empty entries', () => {
    const r = substituteDisabledModel('b', ' a , b ,, ', 'fb');
    expect(r.substituted).toBe(true);
  });

  it('does nothing when nothing is disabled', () => {
    expect(substituteDisabledModel('a', undefined, 'fb').substituted).toBe(false);
    expect(substituteDisabledModel('a', '', 'fb').substituted).toBe(false);
  });
});
