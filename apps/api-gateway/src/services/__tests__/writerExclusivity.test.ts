/**
 * Exclusivity guard for project file writes.
 *
 * Phase 3's value is NOT the writeProjectFile wrapper. It is that exactly one
 * piece of code writes a project file. Section 6.1 of the paper draws the
 * system boundary per location: "a file lies inside when only the system can
 * reach it under a private path, and outside when it is a path other programs
 * read or write." Every extra writer moves project files back outside the
 * boundary and makes their effects unrevertible again, because another writer
 * may have moved the file underneath you before you try.
 *
 * That property degrades silently. Nothing fails when someone adds a fifteenth
 * fs.writeFileSync -- the code works, the tests pass, and compensation quietly
 * becomes unsound for every path that writer touches. This test is what turns
 * that into a build failure.
 *
 * Adding a genuine exception is fine; add it to ALLOWED with the reason. The
 * point is that it becomes a deliberate, reviewed act instead of an accident.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** Direct filesystem write calls that would bypass the single owner. */
const WRITE_CALL = /\bfs\.(writeFileSync|copyFileSync|appendFileSync|promises\.writeFile|promises\.appendFile|promises\.copyFile)\s*\(/;

/**
 * Files permitted to write directly, each with the reason it is not a project
 * file write. Anything not listed here must go through projectFileWriter.
 */
const ALLOWED: Record<string, string> = {
  'services/projectFileWriter.ts': 'the single owner itself',
  'agent-tools/place_asset.ts': 'writes only into the OS upload temp dir (UPLOAD_BASE), not the project tree',
  'services/agentLoopService.ts': 'writes only into os.tmpdir() for re-fetched chat attachments',
  'services/baseTemplateService.ts': 'seeds the shared base template, not a live project tree',
  'services/ecg-template.ts': 'seeds the shared eCG template, not a live project tree',
  'agent-tools/run_command.ts': 'writes npm/package manager artefacts, not agent-authored source',
  // Found by this guard on its first run, which is the case for having it.
  // restoreSnapshot() bulk-copies a snapshot back over appPath. That restore is
  // itself a compensation, so routing it through the writer would record
  // thousands of fresh file_write effects and let a later recovery undo the
  // undo -- the same reason the pre-agent rollback in agentLoopService is not
  // tracked. NOTE: this is a second, older rollback mechanism that overlaps
  // with the effect ledger; consolidating the two is worth doing.
  'services/agentSnapshot.ts': 'bulk snapshot restore -- a compensation, not a tracked write',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('project file write exclusivity', () => {
  it('no unlisted file writes project files directly', () => {
    const offenders: string[] = [];

    for (const file of walk(path.join(SRC, 'agent-tools')).concat(walk(path.join(SRC, 'services')))) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (ALLOWED[rel]) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Skip comments -- several files legitimately MENTION fs.writeFileSync
        // in prose explaining why they no longer call it.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (WRITE_CALL.test(line)) offenders.push(`${rel}:${i + 1}  ${trimmed.slice(0, 90)}`);
      });
    }

    expect(
      offenders,
      'These write the filesystem directly, bypassing projectFileWriter. A project file with more\n' +
      'than one writer cannot be reverted (paper section 6.1). Either route it through\n' +
      'writeProjectFile/writeProjectFileSync, or add it to ALLOWED with the reason it is not a\n' +
      'project file write:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every ALLOWED entry still exists, so the list cannot rot', () => {
    // A stale exception is worse than no exception: it silently permits a path
    // that no longer means what the reason says.
    for (const rel of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(SRC, rel)), `ALLOWED lists ${rel}, which no longer exists`).toBe(true);
    }
  });
});
