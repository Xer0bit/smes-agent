import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { snapshotProjectSrc, rollbackProjectSrc, cleanupSnapshot } from '../snapshot.js';

/**
 * 2026-08-19: server.js's /update route now calls rollbackProjectSrc when a
 * push's own build check finds real errors, so disk always reflects the
 * last known-good state -- not just "the currently open tab won't be
 * pushed a broken update" (a fresh load, hard refresh, or Vite restart
 * would otherwise still serve whatever broken files are on disk). These
 * tests lock in the underlying snapshot/rollback mechanism that guarantee
 * now depends on.
 */

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('snapshotProjectSrc copies src/ and rollbackProjectSrc restores it exactly', () => {
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'export default function App() { return <div>good</div>; }');

  expect(snapshotProjectSrc(root)).toBe(true);

  // Simulate a broken push overwriting the file.
  fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'export default function App() { return <div>broken</');
  fs.writeFileSync(path.join(srcDir, 'NewBrokenFile.tsx'), 'this is not valid syntax at all {{{');

  expect(rollbackProjectSrc(root)).toBe(true);
  expect(fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8')).toBe(
    'export default function App() { return <div>good</div>; }',
  );
  expect(fs.existsSync(path.join(srcDir, 'NewBrokenFile.tsx'))).toBe(false);
});

test('snapshotProjectSrc returns false when there is no src/ yet (first-ever build)', () => {
  expect(snapshotProjectSrc(root)).toBe(false);
});

test('rollbackProjectSrc returns false when no snapshot was ever taken', () => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  expect(rollbackProjectSrc(root)).toBe(false);
});

test('cleanupSnapshot removes the snapshot dir without touching src/', () => {
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'ok');
  snapshotProjectSrc(root);

  expect(fs.existsSync(path.join(root, '.src-snapshot'))).toBe(true);
  cleanupSnapshot(root);
  expect(fs.existsSync(path.join(root, '.src-snapshot'))).toBe(false);
  expect(fs.existsSync(path.join(srcDir, 'App.tsx'))).toBe(true);
});

test('a second snapshot call replaces the first (no stale rollback target)', () => {
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'v1');
  snapshotProjectSrc(root);

  fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'v2 (known good)');
  snapshotProjectSrc(root); // new snapshot taken from v2, not v1

  fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'v3 (broken)');
  rollbackProjectSrc(root);

  expect(fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8')).toBe('v2 (known good)');
});
