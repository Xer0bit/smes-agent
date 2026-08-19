import { test, expect } from 'vitest';
import { filesTouchLoadedModule } from '../materialize.js';

// 2026-08-19: every batched agent-response push unconditionally forced a
// full page reload, on every project -- including when the agent only wrote
// files the currently-viewed page hasn't imported yet, which is a very
// common case (new components staged for a later step, files behind a route
// the user isn't on). Reloading for those has zero visible effect, only
// disruption. filesTouchLoadedModule decides whether the just-written batch
// actually touches anything the browser has loaded.

function fakeVite(loadedFiles) {
  return {
    moduleGraph: {
      getModulesByFile: (file) => (loadedFiles.has(file) ? new Set([{}]) : undefined),
    },
  };
}

test('returns true when at least one written file is a loaded module', () => {
  const vite = fakeVite(new Set(['/app/src/App.tsx']));
  expect(filesTouchLoadedModule(vite, ['/app/src/NewThing.tsx', '/app/src/App.tsx'])).toBe(true);
});

test('returns false when none of the written files are loaded', () => {
  const vite = fakeVite(new Set(['/app/src/App.tsx']));
  expect(filesTouchLoadedModule(vite, ['/app/src/NewThing.tsx', '/app/src/AnotherNewThing.tsx'])).toBe(false);
});

test('defaults to true (reload) when vite/moduleGraph is unavailable', () => {
  expect(filesTouchLoadedModule(undefined, ['/app/src/App.tsx'])).toBe(true);
  expect(filesTouchLoadedModule({}, ['/app/src/App.tsx'])).toBe(true);
});

test('defaults to true (reload) if the moduleGraph check throws', () => {
  const vite = { moduleGraph: { getModulesByFile: () => { throw new Error('boom'); } } };
  expect(filesTouchLoadedModule(vite, ['/app/src/App.tsx'])).toBe(true);
});

test('returns false for an empty write batch', () => {
  const vite = fakeVite(new Set(['/app/src/App.tsx']));
  expect(filesTouchLoadedModule(vite, [])).toBe(false);
});
