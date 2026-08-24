/**
 * Diagnostic classification for a failed edit_file SEARCH.
 *
 * SEARCH_MISS is the highest-frequency cause of wrong changes in this harness
 * (61 occurrences in a single 4000-line log window, audit 2026-08-24) and was
 * undiagnosable: the log line carried only project and path, and the failing
 * SEARCH text went to runStateLedger, which is in-memory and discarded when the
 * run ends. Three different root causes were plausible -- truncated read, stale
 * context, compaction loss -- each needing a different fix, and nothing in the
 * system could tell them apart.
 *
 * These fields exist to separate those causes from live data instead of
 * argument. Kept as a pure function so the discrimination itself is testable:
 * shipping fields that look informative but do not actually distinguish the
 * causes would leave us exactly as blind, with more logging.
 */

/** Lines of the file echoed back to the model in the failure message. */
export const PREVIEW_LINES = 100;

/** read_file serves head+outline instead of full content at or above this. */
export const TRUNCATION_MIN_LINES = 300;

/** Tiers where read_file truncates. Mirrors read_file.ts's TRUNC_TIERS. */
const TRUNCATING_TIERS = new Set(['edit', 'fix']);

export interface SearchMissDiagnosis {
  fileLines: number;
  /** 1-based line where the SEARCH's first line occurs, or null if absent. */
  targetFoundAtLine: number | null;
  /**
   * False means the correction preview does NOT contain the target, so the
   * model cannot repair the SEARCH from the error message alone and will
   * repeat. This is the harness-vs-reasoning split for thrash, measured.
   */
  targetInPreview: boolean;
  /** Whether read_file would have served a truncated view for this file+tier. */
  readWasTruncated: boolean;
  /**
   * The cause this evidence points to, for aggregation:
   *  'absent-from-file' -- SEARCH text is nowhere in the file: the model built
   *      it from a stale or compacted view, not from what is on disk.
   *  'present-not-matched' -- the text IS there, so the exact match failed on
   *      whitespace/formatting rather than on a wrong view.
   *  'below-truncation' -- the model likely never saw the region, because the
   *      read was truncated above it.
   */
  likelyCause: 'absent-from-file' | 'present-not-matched' | 'below-truncation';
}

export function classifySearchMiss(
  fileContent: string,
  searchBlock: string,
  tier: string | undefined,
): SearchMissDiagnosis {
  const allLines = fileContent.split('\n');
  // First non-empty line of the SEARCH block is the most reliable probe: whole
  // blocks rarely match verbatim once indentation differs, but one distinctive
  // line locates the region.
  const probe = searchBlock.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const idx = probe ? allLines.findIndex((l) => l.includes(probe)) : -1;

  const readWasTruncated =
    allLines.length >= TRUNCATION_MIN_LINES && tier != null && TRUNCATING_TIERS.has(tier);

  let likelyCause: SearchMissDiagnosis['likelyCause'];
  if (idx >= 0) {
    likelyCause = 'present-not-matched';
  } else if (readWasTruncated) {
    // Absent AND the read was truncated: the region was probably never shown.
    likelyCause = 'below-truncation';
  } else {
    likelyCause = 'absent-from-file';
  }

  return {
    fileLines: allLines.length,
    targetFoundAtLine: idx >= 0 ? idx + 1 : null,
    targetInPreview: idx >= 0 && idx < PREVIEW_LINES,
    readWasTruncated,
    likelyCause,
  };
}
