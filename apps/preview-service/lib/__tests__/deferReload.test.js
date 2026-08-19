import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
// require, not import, for both: materialize.js itself loads previewState.js
// via require('./previewState') (no extension) -- importing activeServers
// separately via ESM resolved to a different module-graph entry than the one
// materialize.js reads from, so a Map set here was invisible to the code
// under test. Requiring materialize.js's own dependency the same way it does
// guarantees both see the same activeServers singleton.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { materializeProjectFiles } = require('../materialize.js');
const { activeServers } = require('../previewState.js');

/**
 * 2026-08-19: files used to get promoted AND reloaded into the live preview
 * unconditionally, even when the caller's own build check (run after
 * materialize, since it needs the files on disk) found real errors --
 * the browser saw the broken version immediately, and only a separate
 * status poll surfaced the "click Repair" prompt after the fact. deferReload
 * lets the caller (server.js's /update route) hold back the actual reload
 * until its own build check is known-clean, so a broken push never replaces
 * the last-good version the user is looking at. Files still get written
 * either way -- the agent's own fix pass needs the real on-disk state.
 */

let root;
let projectId;

function fakeInstance() {
  return {
    lastAccessed: Date.now(),
    vite: {
      moduleGraph: {
        // Every write in these tests touches a path the "browser" already
        // has loaded, so the reload decision hinges purely on deferReload.
        getModulesByFile: () => new Set([{}]),
        invalidateAll: () => {},
      },
      ws: { send: () => { fakeInstance.sent = true; } },
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'defer-reload-test-'));
  projectId = `test-${Math.random().toString(36).slice(2)}`;
  fakeInstance.sent = false;
  activeServers.set(projectId, fakeInstance());
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  activeServers.delete(projectId);
});

test('deferReload: true writes files but does not send the reload itself, and reports shouldReload', async () => {
  const result = await materializeProjectFiles(projectId, root, [
    { path: 'src/Widget.tsx', content: 'export default function Widget() { return null; }' },
  ], { deferReload: true });

  expect(fs.existsSync(path.join(root, 'src/Widget.tsx'))).toBe(true);
  expect(result.shouldReload).toBe(true);
  expect(fakeInstance.sent).toBe(false);
});

test('deferReload: false (default) writes files and sends the reload itself', async () => {
  const result = await materializeProjectFiles(projectId, root, [
    { path: 'src/Widget.tsx', content: 'export default function Widget() { return null; }' },
  ]);

  expect(fs.existsSync(path.join(root, 'src/Widget.tsx'))).toBe(true);
  expect(result.shouldReload).toBe(true);
  expect(fakeInstance.sent).toBe(true);
});
