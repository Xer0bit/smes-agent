/**
 * Simple diff utility to calculate added/removed lines.
 */

export interface DiffStats {
    additions: number;
    deletions: number;
}

export function calculateLineChanges(newContent: string, oldContent: string): DiffStats {
    if (!oldContent && !newContent) return { additions: 0, deletions: 0 };
    if (!oldContent) return { additions: newContent.split('\n').length, deletions: 0 };
    if (!newContent) return { additions: 0, deletions: oldContent.split('\n').length };

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Very naive diff: just count length difference if no better algo
    // Better: use a simple LCS or just count unmatching lines
    // For this UI purpose, a simple approximation is often enough if we don't want a heavy lib

    // We can use a slightly smarter approach: count common lines
    // This is O(N*M) worst case but usually faster for code files
    // Since we don't want to bring in a heavy diff lib, let's use a Set intersection for approximation
    // This isn't perfect line-by-line diff but gives a "change magnitude"

    let additions = 0;
    let deletions = 0;

    // Basic optimization: trim common prefix/suffix
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
        start++;
    }

    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;

    while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
        oldEnd--;
        newEnd--;
    }

    const oldDiff = oldLines.slice(start, oldEnd + 1);
    const newDiff = newLines.slice(start, newEnd + 1);

    if (oldDiff.length === 0 && newDiff.length === 0) {
        return { additions: 0, deletions: 0 };
    }

    deletions = oldDiff.length;
    additions = newDiff.length;

    return { additions, deletions };
}
