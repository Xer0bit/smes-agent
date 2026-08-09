/**
 * Eco Counter   per-request eco billing helpers.
 *
 * 1 eco = 1 code-action request (agent writes files).
 * 0.5 eco = 1 general question (text-only response).
 *
 * The line-counting helpers below are kept for backwards compatibility
 * but are no longer used for billing.
 */

import type { GeneratedFile } from '@/eCG/UserPrompt/types';

/**
 * Count non-empty lines in a single string/content block.
 */
export function countNonEmptyLines(content: string): number {
  if (!content) return 0;
  const lines = content.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) count++;
  }
  return count;
}

/**
 * Count total eco cost for an array of generated files.
 * Only counts non-empty lines; empty/whitespace-only lines are free.
 */
export function countEcoFromFiles(files: GeneratedFile[]): number {
  let total = 0;
  for (const file of files) {
    if (file.content) {
      total += countNonEmptyLines(file.content);
    }
  }
  return total;
}

/**
 * Count eco cost as a diff: only count NEW non-empty lines that weren't
 * in the previous version of the files.
 *
 * This is used for revisions/edits where we only charge for net-new lines.
 * If a revision shrinks a file, those removed lines are free (no refund).
 */
export function countEcoDiff(
  newFiles: GeneratedFile[],
  oldFiles: GeneratedFile[],
): number {
  const oldLineMap = new Map<string, number>();
  for (const f of oldFiles) {
    if (f.content) {
      oldLineMap.set(f.path, countNonEmptyLines(f.content));
    }
  }

  let total = 0;
  for (const f of newFiles) {
    if (!f.content) continue;
    const newLines = countNonEmptyLines(f.content);
    const oldLines = oldLineMap.get(f.path) ?? 0;
    // Only charge for net-new lines (growth). Shrinks are free.
    const delta = Math.max(0, newLines - oldLines);
    total += delta;
  }

  return total;
}
