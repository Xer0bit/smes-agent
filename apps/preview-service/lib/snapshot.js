const fs = require('fs');
const path = require('path');

// ── Stable Architecture: Project snapshot / rollback ──────────────────────────
// Creates a quick snapshot of the src/ directory before writing new files.
// If the build check fails after writing, we can atomically rollback.
const SNAPSHOT_DIR_NAME = '.src-snapshot';

function snapshotProjectSrc(projectRoot) {
    const srcDir = path.join(projectRoot, 'src');
    const snapshotDir = path.join(projectRoot, SNAPSHOT_DIR_NAME);

    // Clean up any leftover snapshot
    if (fs.existsSync(snapshotDir)) {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
    }

    if (!fs.existsSync(srcDir)) return false;

    try {
        fs.cpSync(srcDir, snapshotDir, { recursive: true });
        return true;
    } catch (err) {
        console.warn('[Snapshot] Failed to create src snapshot:', err.message);
        return false;
    }
}

function rollbackProjectSrc(projectRoot) {
    const srcDir = path.join(projectRoot, 'src');
    const snapshotDir = path.join(projectRoot, SNAPSHOT_DIR_NAME);

    if (!fs.existsSync(snapshotDir)) return false;

    try {
        if (fs.existsSync(srcDir)) {
            fs.rmSync(srcDir, { recursive: true, force: true });
        }
        fs.cpSync(snapshotDir, srcDir, { recursive: true });
        fs.rmSync(snapshotDir, { recursive: true, force: true });
        console.log('[Snapshot] Rolled back src/ to previous state');
        return true;
    } catch (err) {
        console.warn('[Snapshot] Failed to rollback:', err.message);
        return false;
    }
}

function cleanupSnapshot(projectRoot) {
    const snapshotDir = path.join(projectRoot, SNAPSHOT_DIR_NAME);
    try {
        if (fs.existsSync(snapshotDir)) {
            fs.rmSync(snapshotDir, { recursive: true, force: true });
        }
    } catch { /* ignore */ }
}

module.exports = { snapshotProjectSrc, rollbackProjectSrc, cleanupSnapshot };
