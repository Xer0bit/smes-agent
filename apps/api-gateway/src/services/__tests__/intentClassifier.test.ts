import { describe, it, expect } from 'vitest';
import { classifyRequest, classifyRequestDetailed, resolveRequestTier } from '../intentClassifier.js';

describe('classifyRequest', () => {
  it('empty project always builds, regardless of prompt', () => {
    expect(classifyRequest('change the button color', true)).toBe('build');
  });

  describe('fix vs micro compound requests (the ordered-regex misclassification bug)', () => {
    it('routes an explicit defect + cosmetic-word compound to fix, not micro', () => {
      // MICRO_RE alone would match "color"; FIX_STRONG_RE must win.
      expect(classifyRequest('fix the broken button color', false)).toBe('fix');
      expect(classifyRequest('the background color is broken on mobile', false)).toBe('fix');
    });

    it('still classifies a pure cosmetic request as micro', () => {
      expect(classifyRequest('change the button color to blue', false)).toBe('micro');
      expect(classifyRequest('make the heading bold', false)).toBe('micro');
    });

    it('does not let weak can\'t/won\'t phrasing override a cosmetic-only request', () => {
      // "can't"/"won't" are common casual filler, not defect reports --
      // must not promote this to fix tier over the plain color-change intent.
      expect(classifyRequest("can't you also change the color while you're at it", false)).toBe('micro');
    });

    it('still routes a can\'t/won\'t-only complaint (no cosmetic word) to fix via the fallback', () => {
      expect(classifyRequest("the site won't load, please help", false)).toBe('fix');
    });
  });

  it('routes build-error language to fix, not build', () => {
    expect(classifyRequest('I am getting a build error', false)).toBe('fix');
  });

  it('routes explicit new-project language to build', () => {
    expect(classifyRequest('build a website for my bakery from scratch', false)).toBe('build');
  });

  it('routes adding a substantial element to feature', () => {
    expect(classifyRequest('add a pricing section to the landing page', false)).toBe('feature');
  });

  it('routes broad-scope redesign language to feature', () => {
    expect(classifyRequest('redesign the whole dashboard', false)).toBe('feature');
  });

  it('routes a targeted single-thing change to edit', () => {
    expect(classifyRequest('remove the newsletter signup form', false)).toBe('edit');
  });

  it('falls back to feature for long prompts with no other signal, edit for short ones', () => {
    const longPrompt = 'x'.repeat(401);
    expect(classifyRequest(longPrompt, false)).toBe('feature');
    expect(classifyRequest('tweak this', false)).toBe('edit');
  });
});

/**
 * Confidence does not change any routing above -- every case in the suite above
 * must still pass. It only records how much evidence the matching rule carried,
 * so the resolver knows which verdicts are worth a second opinion.
 */
describe('classifyRequestDetailed: confidence', () => {
  it('marks specific evidence high', () => {
    for (const p of ['change the button color', 'add a pricing section', 'build a new website', 'fix the crash']) {
      expect(classifyRequestDetailed(p, false).confidence).toBe('high');
    }
  });

  it('marks a bare verb low, which is the "logo" shape', () => {
    const d = classifyRequestDetailed('change the logo', false);
    expect(d.tier).toBe('edit');           // unchanged answer
    expect(d.rule).toBe('edit-generic');
    expect(d.confidence).toBe('low');      // but no longer pretends to be sure
  });

  it("marks a can't/won't-only complaint low rather than certain", () => {
    const d = classifyRequestDetailed("the site won't load, please help", false);
    expect(d.tier).toBe('fix');            // same tier the suite above asserts
    expect(d.confidence).toBe('low');
  });

  it('marks the length fallback low in both directions', () => {
    expect(classifyRequestDetailed('tweak this', false).confidence).toBe('low');
    expect(classifyRequestDetailed('x'.repeat(401), false).confidence).toBe('low');
  });
});

describe('resolveRequestTier', () => {
  it('never calls the model when the rules are confident', async () => {
    let calls = 0;
    const r = await resolveRequestTier('change the button color', false, async () => { calls++; return 'build'; });
    expect(calls).toBe(0);
    expect(r.tier).toBe('micro');
    expect(r.source).toBe('rules');
  });

  it('consults the model on the low-confidence band and takes its answer', async () => {
    const r = await resolveRequestTier('change the logo', false, async () => 'feature');
    expect(r.tier).toBe('feature');
    expect(r.source).toBe('llm');
    expect(r.rule).toBe('edit-generic->llm');
  });

  it('tolerates the answer arriving with punctuation or casing', async () => {
    const r = await resolveRequestTier('change the logo', false, async () => '  Micro.\n');
    expect(r.tier).toBe('micro');
  });

  it('keeps the rules verdict when the model answers with nonsense', async () => {
    const r = await resolveRequestTier('change the logo', false, async () => 'probably an edit?');
    expect(r.tier).toBe('edit');
    expect(r.source).toBe('rules');
  });

  it('keeps the rules verdict when the model errors or times out', async () => {
    const r = await resolveRequestTier('change the logo', false, async () => { throw new Error('timeout'); });
    expect(r.tier).toBe('edit');
    expect(r.source).toBe('rules');
  });

  it('never asks about an empty project, which is build by definition', async () => {
    let calls = 0;
    const r = await resolveRequestTier('do something', true, async () => { calls++; return 'micro'; });
    expect(calls).toBe(0);
    expect(r.tier).toBe('build');
  });
});

/**
 * Error payloads and explicit no-modify requests.
 *
 * Measured over 477 real prompts: 42 (9%) carried a pasted error or log body and
 * routed AWAY from fix, at a median of 8 steps and $13.42 of spend; several
 * opened with "DO NOT modify code yet" and were handed an editing agent.
 * FIX_RE matched "build error"/"console error" but not the shape errors actually
 * arrive in from this product's own edge-function console.
 */
describe('classifyRequestDetailed: pasted error payloads', () => {
  it('routes a JSON error body to fix even with no defect vocabulary', () => {
    const d = classifyRequestDetailed('{ "result": null, "logs": [], "error": "Invalid credentials or inactive account." } I still got the same issue', false);
    expect(d.tier).toBe('fix');
    expect(d.rule).toBe('error-payload');
  });

  it('handles an unquoted error key, which is how console output pastes', () => {
    expect(classifyRequestDetailed('result { error: "An internal error occurred." } logs [ "[error] Database e', false).tier).toBe('fix');
  });

  it('routes a named JS error class to fix', () => {
    expect(classifyRequestDetailed('the page throws TypeError: cannot read x of undefined', false).tier).toBe('fix');
  });

  it('does NOT fire on the ordinary word "error" in a feature request', () => {
    // "add an error message" is a request, not a defect report. It must not be
    // pulled into the diagnostic tier by the bare word "error". (Which tier it
    // lands on is the pre-existing cascade's business -- only the absence of a
    // false error-payload match is asserted here.)
    const d = classifyRequestDetailed('add an error message to the signup form', false);
    expect(d.rule).not.toBe('error-payload');
    expect(d.tier).not.toBe('fix');
  });

  it('routes an explicit "do not modify" request to the diagnostic tier', () => {
    const d = classifyRequestDetailed('Investigate the CURRENT login failure. Do not modify anything yet.', false);
    expect(d.tier).toBe('fix');
    expect(d.rule).toBe('no-modify-request');
  });

  it('keeps an explicit defect statement on fix-strong, not the new rules', () => {
    expect(classifyRequestDetailed('fix the broken button color', false).rule).toBe('fix-strong');
  });
});
