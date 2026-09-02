// @vitest-environment jsdom
import { test, expect, describe, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client-scripts', 'nav-patch.js'), 'utf8');

/**
 * The preview's Back / Forward must never leave the preview. Before this
 * patch the app's pushState entries lived in the browser's joint history, so
 * history.go(-1) with no preview entries left walked the editor page itself.
 */
describe('nav-patch', () => {
  beforeAll(() => { new Function(script)(); }); // eslint-disable-line no-new-func
  beforeEach(() => {
    window.history.replaceState({}, '', window.location.pathname);
    window.__ecgNav.reset();
  });

  const push = (route) => window.history.pushState({}, '', `${window.location.pathname}#${route}`);
  const go = (delta) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ecg-nav-go', delta } }));

  test('router pushes never grow the browser history; the stack grows instead', () => {
    const before = window.history.length;
    push('/about'); push('/pricing');
    expect(window.history.length).toBe(before);
    expect(window.__ecgNav.routes()).toEqual(['/', '/about', '/pricing']);
    expect(window.__ecgNav.index()).toBe(2);
  });

  test('Back and Forward move within the stack and update the hash', () => {
    push('/about'); push('/pricing');
    go(-1);
    expect(window.location.hash).toBe('#/about');
    expect(window.__ecgNav.index()).toBe(1);
    go(1);
    expect(window.location.hash).toBe('#/pricing');
  });

  test('a delta past either end is ignored, never handed to history.go', () => {
    push('/about');
    go(-5);
    expect(window.location.hash).toBe('#/about');
    expect(window.__ecgNav.index()).toBe(1);
    go(3);
    expect(window.__ecgNav.index()).toBe(1);
  });

  test('a new push after going back drops the forward entries', () => {
    push('/about'); push('/pricing');
    go(-1);
    push('/contact');
    expect(window.__ecgNav.routes()).toEqual(['/', '/about', '/contact']);
  });
});
