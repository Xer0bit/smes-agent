/**
 * Tests for image classification helpers in agentLoopService.ts
 *
 * The four functions are private (unexported), so they are replicated here
 * verbatim from agentLoopService.ts lines ~148-194 for direct testing.
 */

import { describe, it, expect } from 'vitest';

// ─── Replicated from agentLoopService.ts ─────────────────────────────────────

function isReferenceScreenshot(analysis: string): boolean {
  const lower = analysis.toLowerCase();
  const screenshotSignals = /screenshot|application window|browser window|web app(?:lication)? interface|software interface|ui capture|dark.*ui|builder.*ui|editor.*ui|app.*screenshot|screen capture|dashboard.*screenshot|admin.*panel|dev.*tool|inspector|console.*log|page layout|full page|webpage/i;
  const diagramSignals = /\bdiagram\b|\bwireframe\b|\bsketch\b|\bmockup\b|\bflowchart\b|\bannot(?:at|ation)\b|\barchitecture\b|\blayout.*(?:diagram|plan|sketch)\b|\bexplanat/i;
  const strongAssetSignals = /\b(?:standalone logo|isolated logo|transparent background|brand mark only|icon-only|favicon source|logo file)\b/i;
  return (screenshotSignals.test(lower) || diagramSignals.test(lower)) && !strongAssetSignals.test(lower);
}

function isScreenshotFilename(name: string): boolean {
  return /^(?:screenshot|screen[ _-]?shot|screen[ _-]?capture|screen[ _-]?grab|snap(?:shot)?|capture|scr\d|grab|paste|clipboard|untitled|image\d*\.png$)/i.test(name)
    || /screenshot/i.test(name);
}

function hasEmbedIntent(prompt: string): boolean {
  const explicitAssetAction = /\b(?:use|set|add|make|embed|insert|place|put|replace|swap|apply)\b[\s\S]{0,40}\b(?:logo|favicon|hero|banner|background(?: image)?|icon|image|photo|picture|avatar)\b/i;
  const shorthandAssetAction = /\b(?:use as|set as|add as)\s+(?:the\s+)?(?:logo|favicon|hero|banner|background|icon|image|photo|picture|avatar)\b/i;
  const screenshotContext = /\b(?:screenshot|screen[ -]?shot|screen[ -]?capture|ui|interface|page|current state|existing state|bug|issue|error|fix)\b/i;

  if (explicitAssetAction.test(prompt) || shorthandAssetAction.test(prompt)) return true;
  if (screenshotContext.test(prompt)) return false;
  return false;
}

function supportsVision(providerName: string, modelId: string): boolean {
  if (providerName === 'deepseek') return false;
  if (providerName === 'anthropic') return true;
  if (providerName === 'gemini')    return true;
  return modelId.includes('gpt-4o') || modelId.includes('vision');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('isReferenceScreenshot', () => {
  it('returns true for a plain screenshot description', () => {
    expect(isReferenceScreenshot('This is a screenshot of the admin panel')).toBe(true);
  });

  it('returns true for a browser window description', () => {
    expect(isReferenceScreenshot('Shows a browser window with the app loaded')).toBe(true);
  });

  it('returns false for a standalone logo description', () => {
    expect(isReferenceScreenshot('standalone logo on a transparent background')).toBe(false);
  });

  it('returns false for a brand mark with isolated logo signal', () => {
    expect(isReferenceScreenshot('isolated logo asset for the brand, icon-only version')).toBe(false);
  });

  // Bug fix A/B tests — diagrams/wireframes must now return TRUE
  it('FIX: returns true for a diagram description', () => {
    expect(isReferenceScreenshot('This is a diagram showing the system architecture')).toBe(true);
  });

  it('FIX: returns true for a wireframe description', () => {
    expect(isReferenceScreenshot('A wireframe of the checkout page with annotated fields')).toBe(true);
  });

  it('FIX: returns true for a sketch description', () => {
    expect(isReferenceScreenshot('Hand-drawn sketch of the proposed layout')).toBe(true);
  });

  it('FIX: returns true for a mockup description', () => {
    expect(isReferenceScreenshot('High-fidelity mockup of the landing page')).toBe(true);
  });

  it('FIX: returns true for a flowchart description', () => {
    expect(isReferenceScreenshot('A flowchart illustrating the user onboarding process')).toBe(true);
  });

  it('returns true for a full-page web capture', () => {
    expect(isReferenceScreenshot('Full page screenshot of the homepage')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isReferenceScreenshot('')).toBe(false);
  });
});

describe('isScreenshotFilename', () => {
  it('returns true for canonical "Screenshot" prefix', () => {
    expect(isScreenshotFilename('Screenshot 2024-01-01 at 10.00.00.png')).toBe(true);
  });

  it('returns true for screen-shot hyphenated variant', () => {
    expect(isScreenshotFilename('screen-shot.png')).toBe(true);
  });

  it('returns true for clipboard paste filenames', () => {
    expect(isScreenshotFilename('paste123.png')).toBe(true);
  });

  it('returns true for "untitled" clipboard image', () => {
    expect(isScreenshotFilename('untitled.png')).toBe(true);
  });

  it('returns true for snap prefix', () => {
    expect(isScreenshotFilename('snapshot.png')).toBe(true);
  });

  it('returns true when "screenshot" appears anywhere in the name', () => {
    expect(isScreenshotFilename('my-screenshot-edited.png')).toBe(true);
  });

  it('returns false for a named logo file', () => {
    expect(isScreenshotFilename('company-logo.svg')).toBe(false);
  });

  it('returns false for a generic photo filename', () => {
    expect(isScreenshotFilename('hero-image.jpg')).toBe(false);
  });
});

describe('hasEmbedIntent', () => {
  it('returns true for explicit "use this as logo" instruction', () => {
    expect(hasEmbedIntent('Use this as the logo for the site')).toBe(true);
  });

  it('returns true for "embed this image as the hero"', () => {
    expect(hasEmbedIntent('Embed this image as the hero banner')).toBe(true);
  });

  it('returns true for "set as favicon"', () => {
    expect(hasEmbedIntent('Set as the favicon')).toBe(true);
  });

  it('returns false for a screenshot bug report mentioning logo', () => {
    expect(hasEmbedIntent('screenshot showing the logo is broken on the page')).toBe(false);
  });

  it('returns false for a pure UI question with no asset action', () => {
    expect(hasEmbedIntent('Here is the current state of the interface')).toBe(false);
  });

  it('returns false for an empty prompt', () => {
    expect(hasEmbedIntent('')).toBe(false);
  });

  it('returns true for "add this image as the background"', () => {
    expect(hasEmbedIntent('add this image as the background')).toBe(true);
  });

  it('returns false for a prompt mentioning error/fix without asset action', () => {
    expect(hasEmbedIntent('There is a bug in the error page layout')).toBe(false);
  });
});

describe('supportsVision', () => {
  it('returns true for anthropic provider regardless of model', () => {
    expect(supportsVision('anthropic', 'claude-3-opus')).toBe(true);
  });

  it('returns true for gemini provider', () => {
    expect(supportsVision('gemini', 'gemini-1.5-pro')).toBe(true);
  });

  it('returns false for deepseek provider', () => {
    expect(supportsVision('deepseek', 'deepseek-chat')).toBe(false);
  });

  it('returns true for openai with gpt-4o model', () => {
    expect(supportsVision('openai', 'gpt-4o')).toBe(true);
  });

  it('returns true for openai with vision model id', () => {
    expect(supportsVision('openai', 'gpt-4-vision-preview')).toBe(true);
  });

  it('returns false for openai with non-vision model', () => {
    expect(supportsVision('openai', 'gpt-3.5-turbo')).toBe(false);
  });

  it('returns true for openai gpt-4o-mini', () => {
    expect(supportsVision('openai', 'gpt-4o-mini')).toBe(true);
  });
});
