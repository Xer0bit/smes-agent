import { describe, it, expect } from 'vitest';
import { classifyRequest } from '../intentClassifier.js';

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
