// Normalize the base URL - remove trailing /preview if present for consistency
const rawPreviewUrl =
    import.meta.env.VITE_PREVIEW_URL ||
    import.meta.env.VITE_PREVIEW_SERVICE_URL ||
    (import.meta.env.PROD ? 'https://preview.ecomgear.app' : 'http://localhost:3001');
const DOCKER_PREVIEW_URL = rawPreviewUrl.replace(/\/preview\/?$/, '');

const HEALTH_CHECK_TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// SESSION TOKEN MANAGEMENT
// Tokens are stored in localStorage so they survive page refreshes.
// When REQUIRE_SESSION_TOKEN is not enabled (local dev / China publish server)
// the backend returns no `session` field and everything works without tokens.
// ─────────────────────────────────────────────────────────────────────────────
interface SessionInfo {
    token: string;
    expiresAt: number; // Unix ms
}

const SESSION_RENEW_THRESHOLD_MS = 30 * 60 * 1000; // renew when <30 min left
const LS_PREFIX = 'ecg_preview_session_';

function _sessionKey(projectId: string) { return `${LS_PREFIX}${projectId}`; }

function getStoredSession(projectId: string): SessionInfo | null {
    try {
        const raw = localStorage.getItem(_sessionKey(projectId));
        if (!raw) return null;
        const s: SessionInfo = JSON.parse(raw);
        if (Date.now() >= s.expiresAt) { localStorage.removeItem(_sessionKey(projectId)); return null; }
        return s;
    } catch { return null; }
}

function storeSession(projectId: string, s: SessionInfo) {
    try { localStorage.setItem(_sessionKey(projectId), JSON.stringify(s)); } catch { /* quota */ }
}

function clearSession(projectId: string) {
    try { localStorage.removeItem(_sessionKey(projectId)); } catch { /* noop */ }
}

/** Returns the active token for a project, or undefined if none / not required. */
function getToken(projectId: string): string | undefined {
    return getStoredSession(projectId)?.token;
}

/**
 * Call the preview-service to create / retrieve a 2-hour session token.
 * The JWT is sent ONLY as an Authorization header (never a URL/query param   a
 * bearer token in a URL ends up in browser history and server access logs).
 * The server responds with a Set-Cookie that authorizes this browser for
 * this project going forward; the JSON body's token is a secondary,
 * best-effort fallback for environments where third-party cookies are blocked.
 */
export async function createPreviewSession(projectId: string): Promise<SessionInfo | null> {
    try {
        const { lovableCloud } = await import('@/integrations/supabase/client');
        const { data: { session } } = await lovableCloud.auth.getSession();
        if (!session?.access_token) return null; // not logged in   nothing to bootstrap

        const base = DOCKER_PREVIEW_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/preview/${projectId}/session`, {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return null;
        const data: SessionInfo = await res.json();
        storeSession(projectId, data);
        scheduleAutoRenew(projectId, data.expiresAt);
        return data;
    } catch (e) {
        console.warn('[PreviewSession] createPreviewSession failed:', e);
        return null;
    }
}

/**
 * Renew the session (force-reset the 2-hour window).
 * Called automatically ~30 min before expiry.
 */
export async function renewPreviewSession(projectId: string): Promise<SessionInfo | null> {
    try {
        const { lovableCloud } = await import('@/integrations/supabase/client');
        const { data: { session } } = await lovableCloud.auth.getSession();
        if (!session?.access_token) return null;

        const base = DOCKER_PREVIEW_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/preview/${projectId}/renew`, {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return null;
        const data: SessionInfo = await res.json();
        storeSession(projectId, data);
        scheduleAutoRenew(projectId, data.expiresAt);
        console.log(`[PreviewSession] Renewed for ${projectId}, expires ${new Date(data.expiresAt).toLocaleTimeString()}`);
        return data;
    } catch (e) {
        console.warn('[PreviewSession] renewPreviewSession failed:', e);
        return null;
    }
}

// Auto-renew timers: projectId → timer id
const _renewTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutoRenew(projectId: string, expiresAt: number) {
    const existing = _renewTimers.get(projectId);
    if (existing) clearTimeout(existing);

    const renewIn = expiresAt - Date.now() - SESSION_RENEW_THRESHOLD_MS;
    if (renewIn <= 0) {
        // already close to expiry   renew now
        renewPreviewSession(projectId);
        return;
    }
    const timer = setTimeout(() => renewPreviewSession(projectId), renewIn);
    _renewTimers.set(projectId, timer);
}

/**
 * Call this when the iframe sends a 'preview-session-expired' postMessage.
 * Renews the session and returns the new preview URL to reload the iframe.
 */
export async function handlePreviewSessionExpired(projectId: string): Promise<string | null> {
    clearSession(projectId);
    const s = await renewPreviewSession(projectId);
    if (!s) return null;
    return getPreviewUrl(projectId);
}

// ─────────────────────────────────────────────────────────────────────────────

interface PreviewHealthStatus {
    isDockerAvailable: boolean;
    lastChecked: number;
    error?: string;
}

// Cache health status for 30 seconds (keyed by projectId)
const statusCache = new Map<string, PreviewHealthStatus>();
const CACHE_TTL_MS = 30000;

export function getPreviewUrl(projectId: string): string {
    const base = `${DOCKER_PREVIEW_URL}/preview/${projectId}/`;
    const token = getToken(projectId);
    return token ? `${base}?token=${token}` : base;
}

/**
 * Check if Docker preview service is available for a specific project.
 */
export async function checkPreviewHealth(projectId: string): Promise<PreviewHealthStatus> {
    const now = Date.now();
    const cached = statusCache.get(projectId);

    // Return cached result if still valid
    if (cached && (now - cached.lastChecked) < CACHE_TTL_MS) {
        return cached;
    }

    const tryCheck = async (attempt: number): Promise<PreviewHealthStatus> => {
        let timeoutId: any;
        try {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 10000);

            // Only check the service /health endpoint   fetching the project URL
            // triggers Vite server creation which is slow and can cause NetworkError
            // on first access. If /health responds, Docker is available.
            const serviceHealthUrl = `${DOCKER_PREVIEW_URL}/health`;
            const healthRes = await fetch(serviceHealthUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!healthRes.ok) {
                throw new Error(`Preview service unhealthy: ${healthRes.status}`);
            }

            if (attempt === 1) console.log(`[PreviewHealth] Service healthy for ${projectId}`);

            const status = {
                isDockerAvailable: true,
                lastChecked: now,
            };
            statusCache.set(projectId, status);
            return status;
        } catch (error) {
            clearTimeout(timeoutId);
            console.warn(`[PreviewHealth] Attempt ${attempt} failed for ${projectId}:`, error);
            throw error;
        }
    };

    try {
        return await tryCheck(1);
    } catch (error) {
        // Retry once if it was a timeout or connection failure
        console.log(`[PreviewHealth] Retrying health check for ${projectId}...`);
        try {
            return await tryCheck(2);
        } catch (secondError) {
            const status = {
                isDockerAvailable: false,
                lastChecked: now,
                error: secondError instanceof Error ? secondError.message : 'Unknown error',
            };
            statusCache.set(projectId, status);
            return status;
        }
    }
}

/**
 * Quick check if Docker is likely available (uses cache).
 */
export function isDockerLikelyAvailable(projectId: string): boolean {
    const cached = statusCache.get(projectId);
    if (!cached) return false;
    const now = Date.now();
    if ((now - cached.lastChecked) > CACHE_TTL_MS) return false;
    return cached.isDockerAvailable;
}

/**
 * Force refresh the health check (bypass cache).
 */
export async function refreshPreviewHealth(projectId: string): Promise<PreviewHealthStatus> {
    statusCache.delete(projectId);
    return checkPreviewHealth(projectId);
}

/**
 * Update files to Docker preview service for a specific project.
 *
 * @param fullSync When true (default), the preview prunes files not in the
 *                 `files` array and does a full Vite reload. When false, only
 *                 the provided files are patched and Vite's HMR hot-replaces
 *                 just the changed modules   no full reload, feels instant.
 *                 Pass false for single-file edits during a chat turn; pass
 *                 true for structural changes (new/deleted files, multi-file).
 */
export async function updateDockerPreview(projectId: string, files: { path: string; content: string }[], fullSync: boolean = true): Promise<{ success: boolean; error?: string }> {
    const tryUpdate = async (attempt: number): Promise<{ success: boolean; error?: string }> => {
        let timeoutId: any;
        try {
            const controller = new AbortController();
            // Must exceed the preview-service's own internal worst-case budget:
            // the /update handler on the server does materialize -> (optional
            // restart) -> warmupInstance (up to its own 30s timeout) -> a
            // syntax build check, ALL before it responds. A client timeout
            // equal to that inner 30s ceiling means any project that actually
            // needs a real warmup (large file count, cold Vite instance) is
            // guaranteed to abort here even when the server-side work would
            // have succeeded given a few more seconds   confirmed live: this
            // was the cause of "AbortError: signal is aborted without reason"
            // looping forever on a real production project with 187 files.
            // 60s leaves ~30s of headroom over the inner ceiling for
            // materialize + build-check + network overhead.
            timeoutId = setTimeout(() => controller.abort(), 60000);

            if (attempt === 1) console.log(`[PreviewHealth] Updating preview for ${projectId} (Attempt ${attempt})...`);

            // Proxied through the API server (holds PREVIEW_UPDATE_SECRET server-side)
            // instead of calling the preview service directly with a client-bundled
            // secret   see server/src/routes/database.routes.ts's /preview-update.
            // /api/v1/database/* only runs on the API server (VPS1, SERVICE_ROLE=api)  
            // NOT the gen server (VPS3, SERVICE_ROLE=gen only mounts /api/v1/ai). Using
            // getGenServerUrl here 404'd in production.
            const { getApiServerUrl } = await import('@/config/external-api');
            const { lovableCloud } = await import('@/integrations/supabase/client');
            const { data: { session } } = await lovableCloud.auth.getSession();

            const response = await fetch(getApiServerUrl(`/api/v1/database/preview-update?project_id=${encodeURIComponent(projectId)}`), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
                },
                body: JSON.stringify({ files, fullSync }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}`;

                try {
                    const contentType = response.headers.get('content-type') || '';
                    if (contentType.includes('application/json')) {
                        const payload = await response.json();
                        const validationSummary = Array.isArray(payload?.validationErrors)
                            ? payload.validationErrors
                                .slice(0, 3)
                                .map((entry: any) => entry?.summary || `${entry?.file || 'file'} ${entry?.message || ''}`.trim())
                                .filter(Boolean)
                                .join(' | ')
                            : '';
                        errorMessage = payload?.error || validationSummary || errorMessage;
                    } else {
                        const text = await response.text().catch(() => '');
                        if (text) errorMessage = text;
                    }
                } catch {
                    // Ignore parse failures and return the HTTP status.
                }

                return { success: false, error: `HTTP ${response.status}: ${errorMessage}` };
            }

            // Store session token if the server returned one (REQUIRE_SESSION_TOKEN mode)
            try {
                const data = await response.json();
                if (data?.session?.token && data?.session?.expiresAt) {
                    storeSession(projectId, data.session);
                    scheduleAutoRenew(projectId, data.session.expiresAt);
                }
            } catch { /* ignore parse errors */ }

            return { success: true };
        } catch (error) {
            clearTimeout(timeoutId);
            console.warn(`[PreviewHealth] Update attempt ${attempt} failed:`, error);
            throw error;
        }
    };

    try {
        return await tryUpdate(1);
    } catch (error) {
        console.log(`[PreviewHealth] Retrying preview update for ${projectId}...`);
        try {
            return await tryUpdate(2);
        } catch (secondError) {
            return {
                success: false,
                error: secondError instanceof Error ? secondError.message : 'Failed to connect to preview service',
            };
        }
    }
}

export const PREVIEW_DOCKER_URL = DOCKER_PREVIEW_URL;

/** Returns session info for a project   useful for UI countdown timers. */
export function getSessionInfo(projectId: string): SessionInfo | null {
    return getStoredSession(projectId);
}
