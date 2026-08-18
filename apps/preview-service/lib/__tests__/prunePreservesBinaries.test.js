import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneProjectFiles, countProjectFiles, shouldSkipPrune } from '../materialize.js';

// Council review 2026-08-18: "images disappear on reload" reduced to one
// missing invariant across 5 confirmed causes -- nothing in the sync path
// could tell a good file from a bad one, so nothing should destroy one on
// a guess. These tests pin the two structural guards added in response.

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('pruneProjectFiles never removes a binary-extension file, even when absent from the push', () => {
  fs.mkdirSync(path.join(root, 'public/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, 'src.tsx'), 'stale');

  const removed = pruneProjectFiles(root, new Set(['other.tsx']));

  expect(fs.existsSync(path.join(root, 'public/assets/logo.png'))).toBe(true);
  expect(removed).not.toContain('public/assets/logo.png');
  expect(removed).toContain('src.tsx');
});

test('countProjectFiles matches a manual count and excludes protected dirs', () => {
  fs.mkdirSync(path.join(root, 'node_modules/foo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/foo/index.js'), 'x');
  fs.writeFileSync(path.join(root, 'a.tsx'), 'x');
  fs.writeFileSync(path.join(root, 'b.tsx'), 'x');

  expect(countProjectFiles(root)).toBe(2);
});

// 2026-08-18 regression: the ratio-based floor only kicked in above 10
// on-disk files, leaving small projects with zero protection against an
// empty/truncated push wiping every file they own.
test('shouldSkipPrune refuses an empty push against a small existing project', () => {
  expect(shouldSkipPrune(0, 3)).toMatch(/looks incomplete/);
});

test('shouldSkipPrune allows an empty push against an empty/new project', () => {
  expect(shouldSkipPrune(0, 0)).toBeUndefined();
});

test('shouldSkipPrune allows a small legitimate edit below the 10-file ratio floor', () => {
  // Deleting 3 of 4 files in a tiny project is a normal edit, not corruption.
  expect(shouldSkipPrune(1, 4)).toBeUndefined();
});

test('shouldSkipPrune refuses a push that drops below half the on-disk count once above the floor', () => {
  expect(shouldSkipPrune(4, 18)).toMatch(/looks incomplete/);
});

test('shouldSkipPrune allows a legitimate bulk deletion at/above the ratio floor', () => {
  expect(shouldSkipPrune(9, 18)).toBeUndefined();
});
