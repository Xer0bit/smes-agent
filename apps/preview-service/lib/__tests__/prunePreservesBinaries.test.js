import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneProjectFiles, countProjectFiles } from '../materialize.js';

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
