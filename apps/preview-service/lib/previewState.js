// ── Rate limiter for /update ──────────────────────────────────────────────────
// Keyed by IP; allows burst up to 30 requests per 60-second window.
const _updateRateBuckets = new Map(); // ip → { count, windowStart }
const UPDATE_RATE_LIMIT = 30;
const UPDATE_RATE_WINDOW_MS = 60_000;

function isUpdateRateLimited(ip) {
    const now = Date.now();
    const bucket = _updateRateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > UPDATE_RATE_WINDOW_MS) {
        _updateRateBuckets.set(ip, { count: 1, windowStart: now });
        return false;
    }
    bucket.count += 1;
    if (bucket.count > UPDATE_RATE_LIMIT) return true;
    return false;
}

// Map to store active Vite servers: projectId -> { vite, server (dummy), lastAccessed }
const activeServers = new Map();
const projectErrors = new Map();
const projectDiagnostics = new Map();
const runtimeInstances = new Map();
// In-flight server creation promises — prevents two concurrent getOrCreateServer calls
// from spawning duplicate Vite instances for the same project (leaking the first one).
const pendingServerCreations = new Map();
const closingServers = new Set();
const recentUpdateFingerprints = new Map();
// M1 fast-forward guard: last accepted full-sync base sequence (ISO timestamp
// of the revision/turn the push derives from) per project. A full-sync push
// with an OLDER base is a stale snapshot -- rejecting it stops a lagging tab
// or worker from rolling the live preview backwards. In-memory only: on
// restart the guard fails open, which only re-admits the pre-existing race,
// never creates a new failure.
const lastAcceptedBaseSeq = new Map();
let cleanupTimer = null;

function createUpdateFingerprint(files, fullSync) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha1');
    hash.update(`fullSync:${fullSync ? 1 : 0}|count:${files.length}|`);

    // Order-insensitive fingerprint so identical payloads with different array ordering
    // still collapse to one update pass.
    const normalized = files
        .map((file) => ({
            path: String(file?.path || '').replace(/^\/+/, ''),
            content: String(file?.content || ''),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of normalized) {
        hash.update(file.path);
        hash.update('\0');
        hash.update(file.content);
        hash.update('\0');
    }

    return hash.digest('hex');
}

function getPreviewPublicBaseUrl(req) {
    const configured = process.env.PREVIEW_PUBLIC_BASE_URL;
    if (configured && configured.trim()) return configured.replace(/\/$/, '');
    const port = process.env.PORT || 3001;
    const host = req.get('host') || `localhost:${port}`;
    const protocol = req.protocol || 'http';
    return `${protocol}://${host}`;
}

function touchRuntime(projectId) {
    const instance = runtimeInstances.get(projectId);
    if (!instance) return;
    instance.lastActiveAt = new Date().toISOString();
    runtimeInstances.set(projectId, instance);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Guest project IDs are prefixed with "guest-" followed by a standard UUID.
// e.g. guest-a1b2c3d4-e5f6-7890-abcd-ef1234567890
const GUEST_PROJECT_REGEX = /^guest-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidProjectId(id) {
    return typeof id === 'string' && (UUID_REGEX.test(id) || GUEST_PROJECT_REGEX.test(id));
}

function getProjectDiagnostics(projectId) {
    const stored = projectDiagnostics.get(projectId);
    const errors = stored?.errors || [];
    const kind = stored?.diagnosticKind || 'healthy';
    // Warnings (from non-blocking checks) don't make the preview "unhealthy".
    // Neither does 'type': Vite/esbuild strips types without checking them, so
    // whole-program TS errors do not stop the app from building or running.
    // Treating them as build failures marked every non-trivial project
    // permanently unhealthy (measured 2026-08-16: 303 real type errors on a
    // live project whose preview served fine), which fired the agent's repair
    // loop on every push -- a loop that cannot converge, since one edit-tier
    // run fixes one or two of hundreds. Genuinely app-breaking cases (unbound
    // identifiers, bad syntax) are caught by validateSourceFile and
    // quickViteBuildCheck and still report as 'build'.
    const isWarningOnly = kind === 'warning' || kind === 'type';

    return {
        healthy: errors.length === 0 || isWarningOnly,
        errors,
        diagnosticKind: kind,
        updatedAt: stored?.updatedAt || null,
        stalePreviewRetained: errors.length > 0 && !isWarningOnly,
    };
}

function setProjectErrors(projectId, errors, diagnosticKind = 'build') {
    if (!errors || errors.length === 0) {
        projectErrors.delete(projectId);
        projectDiagnostics.delete(projectId);
        return;
    }

    const normalized = errors
        .map((error) => typeof error === 'string' ? error : error?.message)
        .filter(Boolean)
        .slice(-20);

    if (normalized.length === 0) {
        projectErrors.delete(projectId);
        projectDiagnostics.delete(projectId);
        return;
    }

    projectErrors.set(projectId, normalized);
    projectDiagnostics.set(projectId, {
        diagnosticKind,
        errors: normalized,
        updatedAt: new Date().toISOString(),
    });
}

function appendProjectError(projectId, error, diagnosticKind = 'build') {
    const next = [...(projectErrors.get(projectId) || []), typeof error === 'string' ? error : error?.message]
        .filter(Boolean)
        .slice(-20);
    setProjectErrors(projectId, next, diagnosticKind);
}

module.exports = {
    activeServers,
    projectErrors,
    projectDiagnostics,
    runtimeInstances,
    pendingServerCreations,
    closingServers,
    recentUpdateFingerprints,
    lastAcceptedBaseSeq,
    get cleanupTimer() { return cleanupTimer; },
    set cleanupTimer(v) { cleanupTimer = v; },
    isUpdateRateLimited,
    createUpdateFingerprint,
    getPreviewPublicBaseUrl,
    touchRuntime,
    escapeHtml,
    isValidProjectId,
    getProjectDiagnostics,
    setProjectErrors,
    appendProjectError,
};
