import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isBuildCheckable } = require('../validation.js');

/**
 * Which pushed paths quickViteBuildCheck may parse. Edge-function mirrors are
 * sandbox bodies the app never loads; esbuild-checking one rolled back a push
 * whose only change was that file (CardPro, 2026-09-02).
 */
describe('isBuildCheckable', () => {
  test('parses app source', () => {
    for (const p of ['src/App.tsx', 'src/lib/x.ts', 'src/a.jsx', 'src/b.js', '/src/App.tsx']) {
      expect(isBuildCheckable(p)).toBe(true);
    }
  });

  test('never parses edge-function mirrors, however the path is spelled', () => {
    for (const p of ['__edge_functions__/api_router.js', '/__edge_functions__/api_router.js', '__edge_functions__\\api_router.js']) {
      expect(isBuildCheckable(p)).toBe(false);
    }
  });

  test('ignores non-script files', () => {
    for (const p of ['src/index.css', 'index.html', 'public/logo.png', '', undefined]) {
      expect(isBuildCheckable(p)).toBe(false);
    }
  });
});
