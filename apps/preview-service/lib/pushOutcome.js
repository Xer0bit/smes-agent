// What a finished /update push should DO to the live preview, as a pure
// decision separated from the I/O that carries it out.
//
// The route in server.js defines every handler inside startMainServer(), which
// self-starts on import -- so the route itself cannot be imported and tested.
// This is the part of it that actually matters: three inputs decide whether a
// user keeps seeing a working app or gets shown a broken one, and every
// incident in this area (2026-08-18/19) was a wrong answer here, not an
// Express plumbing bug.
//
// The invariant, stated once: a push that failed its build check must never
// reach the browser -- not as a reload of an open tab, and not as files left
// on disk for the next fresh load to pick up.

/**
 * @param {object} input
 * @param {boolean} input.hasBuildErrors  fastCheckErrors.length > 0 for this push
 * @param {boolean} input.hasSnapshot     a pre-write src/ snapshot exists to restore
 * @param {boolean} input.wouldReload     the write touched a module the browser has loaded
 * @returns {{ attemptRollback: boolean, reload: boolean }}
 */
function decidePushOutcome({ hasBuildErrors, hasSnapshot, wouldReload }) {
    if (!hasBuildErrors) {
        // Clean push: promote it. Reload only if something the browser is
        // actually showing changed -- reloading for files it hasn't imported
        // is pure disruption (2026-08-19).
        return { attemptRollback: false, reload: Boolean(wouldReload) };
    }

    // Broken push. Withholding the reload alone only protects an already-open
    // tab; a hard refresh, a new tab, or this Vite instance restarting (LRU
    // eviction, idle timeout) would still serve the broken files from disk.
    // Rolling back is what makes ANY fresh load stable, not just the live one.
    //
    // With no snapshot (first-ever build for this project) there is nothing
    // good to restore -- but still no reload: there is nothing good to show
    // either, and reloading into a known-broken build is the exact thing this
    // function exists to prevent.
    return { attemptRollback: Boolean(hasSnapshot), reload: false };
}

module.exports = { decidePushOutcome };
