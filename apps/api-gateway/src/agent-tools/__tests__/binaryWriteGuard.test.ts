/**
 * Regression test for the 2026-08-19 fix: write_file/edit_file had no
 * awareness of binary-asset paths, so a stray or hallucinated call against
 * an existing image (e.g. a project's own logo) silently UTF-8-mangled or
 * blanked it out via fs.writeFileSync(..., 'utf8') -- confirmed live via a
 * corrupted asset that traced back to this exact gap, unrelated to any of
 * the revision-sync/preview-materialize binary fixes made earlier. Neither
 * write_file nor edit_file has any legitimate way to author binary content
 * (their schemas only accept `content`/`diff` as plain strings) -- place_asset
 * is the one tool that writes real bytes. This locks in that write_file and
 * edit_file now both refuse opaque binary paths outright, and that .svg
 * (plain text) is unaffected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeFileTool } from '../write_file.js';
import { editFileTool } from '../edit_file.js';
import type { AgentContext } from '../types.js';

function makeCtx(appPath: string): AgentContext {
  return {
    appPath,
    projectId: 'test-project',
    onXmlComplete: () => {},
  } as AgentContext;
}

const cleanupDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('binary asset write guard', () => {
  it('write_file refuses to write a .jpeg path and leaves an existing file untouched', async () => {
    const appPath = tmpDir('ecg-write-guard-');
    const target = path.join(appPath, 'public', 'assets', 'logo.jpeg');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const realBytes = Buffer.from('ffd8ffe0', 'hex');
    fs.writeFileSync(target, realBytes);

    const result = await writeFileTool.execute(
      { path: 'public/assets/logo.jpeg', content: 'not a real image' },
      makeCtx(appPath),
    );

    expect(String(result)).toMatch(/place_asset/);
    expect(fs.readFileSync(target)).toEqual(realBytes);
  });

  it('write_file still allows plain-text .svg writes', async () => {
    const appPath = tmpDir('ecg-write-guard-svg-');
    const result = await writeFileTool.execute(
      { path: 'public/assets/icon.svg', content: '<svg></svg>' },
      makeCtx(appPath),
    );
    expect(String(result)).toMatch(/Successfully wrote/);
    expect(fs.readFileSync(path.join(appPath, 'public/assets/icon.svg'), 'utf8')).toBe('<svg></svg>');
  });

  it('edit_file refuses to touch a .png path', async () => {
    const appPath = tmpDir('ecg-edit-guard-');
    const target = path.join(appPath, 'public', 'assets', 'banner.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const realBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    fs.writeFileSync(target, realBytes);

    const result = await editFileTool.execute(
      { path: 'public/assets/banner.png', diff: '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE' },
      makeCtx(appPath),
    );

    expect(String(result)).toMatch(/place_asset/);
    expect(fs.readFileSync(target)).toEqual(realBytes);
  });
});
