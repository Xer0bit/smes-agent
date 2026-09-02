/**
 * Repo invariant: nothing may write a revision that the server cannot read back.
 *
 * `fetchHeadManifest` requires `generated_files.format === 'manifest-v1'`. A
 * revision written without it becomes an unreadable HEAD, and an unreadable HEAD
 * does not fail loudly -- it silently degrades two systems at once:
 *   - openSandbox takes its no-HEAD branch and copies the shared project dir,
 *     which is the contamination reservoir the per-run sandbox exists to remove;
 *   - fetchHeadHashes returns empty, the changeset diff is skipped, and every
 *     preview push reverts to a whole-tree fullSync (38.5 MB / 104-139s measured
 *     on CardPro, 2026-09-01).
 *
 * That is exactly what the snapshot-rollback path in ai.routes.ts did for months.
 * A unit test cannot catch it because each writer is individually valid; the
 * invariant is a property of the SET of writers, so this scans the source.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Find `.from('revisions')` … `.insert(` pairs and return the insert's argument
 * text, so it can be checked for the manifest marker. Deliberately crude: a
 * false positive here is a developer reading one extra line of code, a false
 * negative is another silent HEAD poisoning.
 */
function revisionInserts(src: string): string[] {
  const found: string[] = [];
  const re = /from\(\s*['"]revisions['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const after = src.slice(m.index, m.index + 1200);
    const ins = after.indexOf('.insert(');
    if (ins === -1) continue;
    // Only treat it as an insert on this chain if nothing else intervenes.
    const between = after.slice(0, ins);
    if (/\.(select|update|delete|upsert)\(/.test(between)) continue;
    found.push(after.slice(ins, ins + 700));
  }
  return found;
}

describe('revision write invariant', () => {
  const files = sourceFiles(SRC);

  it('scans a non-trivial number of source files (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every revisions insert sets format: 'manifest-v1'", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes("from('revisions')") && !src.includes('from("revisions")')) continue;
      for (const insert of revisionInserts(src)) {
        // Two shapes are correct:
        //  - the manifest is set inline on the insert, or
        //  - the insert DEFERS it (writes null, or omits the column) and the same
        //    file writes manifest-v1 in a follow-up update. That ordering is the
        //    deliberate crash-safety property: a half-written revision is
        //    unreadable rather than wrong, and fetchHeadManifest now looks back
        //    past unreadable rows to the last good manifest.
        const hasManifest = /manifest-v1/.test(insert);
        const defersManifest =
          /generated_files\s*:\s*null/.test(insert) || !/generated_files/.test(insert);
        const fileLandsManifest = /manifest-v1/.test(src);
        if (!hasManifest && !(defersManifest && fileLandsManifest)) {
          offenders.push(`${path.relative(SRC, f)}: ${insert.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
