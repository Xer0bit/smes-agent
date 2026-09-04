/**
 * Every captured console error routes the run into the runtime repair pass, so
 * a false positive here rewrites correct code. The preview renders user markup
 * in an iframe on another box, where third-party noise is constant.
 */
import { describe, expect, it } from 'vitest';
import { isExternalNoise } from '../previewSmokeCheck.service.js';

describe('isExternalNoise', () => {
  it('ignores third-party noise the agent did not cause and cannot fix', () => {
    for (const t of [
      'Failed to load resource: the server responded with a status of 404 ()',
      'GET https://cdn.example.com/a.js net::ERR_BLOCKED_BY_CLIENT',
      "Access to fetch at 'https://api.other.com/x' from origin 'https://preview.SMEsAgent.app' has been blocked by CORS policy",
      'Failed to load resource: favicon.ico',
      'chrome-extension://abcdef/inject.js error',
      "Refused to load because it violates the following Content Security Policy directive",
      '[vite] connecting...',
      'WebSocket connection to \'wss://preview/hmr\' failed',
    ]) {
      expect(isExternalNoise(t)).toBe(true);
    }
  });

  it('does NOT swallow a real application crash', () => {
    // These are exactly what the check exists to catch. A wrong filter here is
    // worse than no filter: it hides the failure silently.
    for (const t of [
      "Uncaught: Cannot read properties of undefined (reading 'map')",
      'Uncaught TypeError: items.reduce is not a function',
      'Warning: Each child in a list should have a unique "key" prop.',
      "ReferenceError: cartTotal is not defined",
      'Error: Minified React error #310',
    ]) {
      expect(isExternalNoise(t)).toBe(false);
    }
  });

  it('does not treat an ordinary message mentioning cors as noise', () => {
    expect(isExternalNoise('Uncaught Error: corsConfig is not defined')).toBe(false);
  });
});
