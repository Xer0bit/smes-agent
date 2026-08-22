/**
 * Round-trip behaviour of the single project-file writer.
 *
 * The property that matters is not "it writes a file" -- it is that a write and
 * its compensation return the location to the state it was in, and that when
 * they CANNOT, the writer says so up front instead of at recovery time.
 *
 * Section 6.1 of the paper allows compensation (a coarser restoring action)
 * for effects that cross the system boundary, and names deleting a created file
 * as an example. It does not license inventing a prior state you never
 * captured, which is what the barrier classification here prevents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const recorded: any[] = [];
vi.mock('../effectLedger.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    recordEffect: async (e: unknown) => { recorded.push(e); return recorded.length; },
  };
});
vi.mock('../../config/database.js', () => ({ supabase: {}, supabaseAuth: {}, default: {} }));

import { writeProjectFile, compensateFileWrite, MAX_CAPTURED_BEFORE_BYTES } from '../projectFileWriter.js';

let appPath: string;
beforeEach(() => {
  recorded.length = 0;
  appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pfw-'));
});
afterEach(() => fs.rmSync(appPath, { recursive: true, force: true }));

const ctx = () => ({ appPath, projectId: 'p1', runId: 'run-1' });
const row = (target: string, before: unknown) => ({
  id: 1, run_id: 'run-1', project_id: 'p1', seq: 1, kind: 'file_write',
  target, boundary: 'compensable' as const, before_state: before, after_state: null,
});

describe('project file writer', () => {
  it('creates a file and records the creation as compensable', async () => {
    const r = await writeProjectFile(ctx(), 'src/New.tsx', 'hello');
    expect(fs.readFileSync(r.fullPath, 'utf8')).toBe('hello');
    expect(r.existed).toBe(false);
    expect(r.boundary).toBe('compensable');
    expect(recorded[0].beforeState).toEqual({ existed: false });
  });

  it('compensating a creation deletes the file', async () => {
    const r = await writeProjectFile(ctx(), 'src/New.tsx', 'hello');
    await compensateFileWrite(row('src/New.tsx', { existed: false }), appPath);
    expect(fs.existsSync(r.fullPath)).toBe(false);
  });

  it('round-trips an overwrite back to the exact prior text', async () => {
    fs.mkdirSync(path.join(appPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'src/App.tsx'), 'ORIGINAL');
    await writeProjectFile(ctx(), 'src/App.tsx', 'REPLACED');
    expect(fs.readFileSync(path.join(appPath, 'src/App.tsx'), 'utf8')).toBe('REPLACED');
    await compensateFileWrite(row('src/App.tsx', recorded[0].beforeState), appPath);
    expect(fs.readFileSync(path.join(appPath, 'src/App.tsx'), 'utf8')).toBe('ORIGINAL');
  });

  it('round-trips binary content without corrupting it', async () => {
    // A PNG header contains bytes that are not valid UTF-8; a text-only capture
    // silently mangles them, and the corruption only shows up in the browser.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    fs.mkdirSync(path.join(appPath, 'public'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'public/logo.png'), png);
    await writeProjectFile(ctx(), 'public/logo.png', Buffer.from('replaced'));
    await compensateFileWrite(row('public/logo.png', recorded[0].beforeState), appPath);
    expect(fs.readFileSync(path.join(appPath, 'public/logo.png')).equals(png)).toBe(true);
  });

  it('classifies an overwrite it could not capture as a barrier', async () => {
    fs.mkdirSync(path.join(appPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'src/big.bin'), Buffer.alloc(MAX_CAPTURED_BEFORE_BYTES + 1, 1));
    const r = await writeProjectFile(ctx(), 'src/big.bin', 'small');
    // Honest classification: no captured prior state means no compensation, and
    // recoverRun halts on a barrier rather than stepping past it.
    expect(r.boundary).toBe('barrier');
    expect(recorded[0].beforeState).toEqual({ existed: true, content: null });
  });

  it('refuses to invent a prior state it never captured', async () => {
    await expect(compensateFileWrite(row('src/x.ts', { existed: true, content: null }), appPath))
      .rejects.toThrow(/refusing to guess/);
  });

  it('still writes when there is no run to attribute the effect to', async () => {
    // Template seeding has no agent run; the write must not depend on the ledger.
    const r = await writeProjectFile({ appPath }, 'src/Seed.tsx', 'x');
    expect(fs.readFileSync(r.fullPath, 'utf8')).toBe('x');
    expect(recorded).toHaveLength(0);
  });

  it('compensates from the effect row alone, with no appPath passed in', async () => {
    // Recovery runs in a different process and request than the write did, at a
    // point where appPath has not been resolved. If compensation needed it
    // passed in, recovery would halt on every file_write and Phase 2's orphan
    // cleanup would never reach anything.
    fs.mkdirSync(path.join(appPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'src/App.tsx'), 'ORIGINAL');
    await writeProjectFile(ctx(), 'src/App.tsx', 'REPLACED');
    const selfContained = {
      ...row('src/App.tsx', recorded[0].beforeState),
      after_state: recorded[0].afterState,
    };
    await compensateFileWrite(selfContained); // no second argument
    expect(fs.readFileSync(path.join(appPath, 'src/App.tsx'), 'utf8')).toBe('ORIGINAL');
  });

  it('refuses to act when no project root is recoverable', async () => {
    await expect(compensateFileWrite(row('src/x.ts', { existed: true, content: 'a' })))
      .rejects.toThrow(/no project root recorded/);
  });

  it('refuses to escape the project root', async () => {
    await expect(writeProjectFile(ctx(), '../../etc/passwd', 'nope')).rejects.toThrow();
  });
});
