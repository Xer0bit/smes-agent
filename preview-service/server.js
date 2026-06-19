const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

// Load .env.production for server-side secrets (Supabase keys etc.) if present.
// This file is written by the deploy script and never committed to git.
try {
    const envFile = path.join(__dirname, '.env.production');
    if (fs.existsSync(envFile)) {
        for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
            const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
        }
    }
} catch { /* ignore */ }
let viteApiPromise = null;

async function getViteApi() {
    if (!viteApiPromise) {
        viteApiPromise = Promise.all([
            import('vite'),
            import('@vitejs/plugin-react'),
        ]).then(([viteModule, reactModule]) => ({
            createViteServer: viteModule.createServer,
            transformWithEsbuild: viteModule.transformWithEsbuild,
            viteBuild: viteModule.build,
            reactPluginFactory: reactModule.default,
        })).catch((err) => {
            // Reset so the next call retries the import instead of re-using the
            // permanently-rejected promise, which would break all project creation.
            viteApiPromise = null;
            throw err;
        });
    }

    return viteApiPromise;
}

// Production configuration from environment
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// HMR settings for production (behind nginx proxy)
const HMR_HOST = process.env.VITE_HMR_HOST || undefined; // Let Vite auto-detect in dev
const HMR_PORT = process.env.VITE_HMR_PORT ? parseInt(process.env.VITE_HMR_PORT) : undefined;
const HMR_PROTOCOL = process.env.VITE_HMR_PROTOCOL || undefined;

// ── Auto-restore: Supabase config ────────────────────────────────────────────
// Used to recover project files that were pruned by the nightly cleanup.
const SUPABASE_REST_URL = (process.env.SUPABASE_URL || 'https://api.ecomgear.dev').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── Internal update secret ────────────────────────────────────────────────────
// Set PREVIEW_UPDATE_SECRET in .env.production on VPS2 and in the gen server env
// on VPS3. Requests to /update without the matching header are rejected (401).
// Leave empty in local dev to keep the endpoint open without config.
const PREVIEW_UPDATE_SECRET = process.env.PREVIEW_UPDATE_SECRET || '';

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

const PROJECTS_ROOT = path.resolve(__dirname, 'projects');

// Ensure projects root exists
if (!fs.existsSync(PROJECTS_ROOT)) {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

// ── Slug registry — maps published slug → projectId ───────────────────────────
const SLUGS_FILE = path.join(PROJECTS_ROOT, '.slugs.json');
function loadSlugRegistry() {
    const map = new Map();
    // 1. Load from main registry file
    try {
        if (fs.existsSync(SLUGS_FILE))
            for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SLUGS_FILE, 'utf-8'))))
                map.set(k, v);
    } catch (e) { console.error('[Slugs] Load error:', e.message); }
    // 2. Recover any missing entries from per-project .slug files
    let recovered = 0;
    try {
        for (const entry of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const slugFile = path.join(PROJECTS_ROOT, entry.name, '.slug');
            if (!fs.existsSync(slugFile)) continue;
            const slug = fs.readFileSync(slugFile, 'utf-8').trim();
            if (slug && !map.has(slug)) {
                map.set(slug, entry.name);
                recovered++;
            }
        }
    } catch (e) { console.error('[Slugs] Recovery scan error:', e.message); }
    if (recovered > 0) {
        console.log(`[Slugs] Recovered ${recovered} slug(s) from project metadata`);
        saveSlugRegistry(map);
    }
    return map;
}
function saveSlugRegistry(map) {
    try { fs.writeFileSync(SLUGS_FILE, JSON.stringify(Object.fromEntries(map), null, 2)); }
    catch (e) { console.error('[Slugs] Save error:', e.message); }
}
const slugRegistry = loadSlugRegistry();
console.log(`[Slugs] Loaded ${slugRegistry.size} published slug(s)`);

// ── Warmup list — persists active project IDs across restarts ────────────────
// Written on graceful shutdown so a new process can restore all Vite servers
// that were running, eliminating user-visible "ecosystem reset" after deploys.
const WARMUP_LIST_FILE = path.join(PROJECTS_ROOT, '.warmup-list.json');

function loadWarmupList() {
    try {
        if (fs.existsSync(WARMUP_LIST_FILE))
            return JSON.parse(fs.readFileSync(WARMUP_LIST_FILE, 'utf-8'));
    } catch (e) { /* corrupt file — ignore */ }
    return [];
}

function saveWarmupList() {
    try {
        const ids = [...activeServers.keys()];
        fs.writeFileSync(WARMUP_LIST_FILE, JSON.stringify(ids));
    } catch (e) { console.warn('[Warmup] Failed to save warmup list:', e.message); }
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
let cleanupTimer = null;

const UPDATE_DEDUPE_WINDOW_MS = 8000;

function createUpdateFingerprint(files, fullSync) {
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

const VITE_RESTART_TRIGGER_FILES = new Set([
    'package.json',
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'tsconfig.json',
    'tsconfig.node.json',
    'postcss.config.js',
    'tailwind.config.ts',
    'tailwind.config.js',
]);

function shouldRestartViteForUpdate(files = [], projectRoot = null) {
    return files.some((file) => {
        const safePath = String(file?.path || '').replace(/^\/+/, '');
        if (!VITE_RESTART_TRIGGER_FILES.has(safePath)) return false;
        // Only restart if the file content actually changed — normalizeProjectFiles
        // always includes config files with default content, so checking by name alone
        // causes unnecessary cache-busting restarts on every update.
        if (projectRoot) {
            const diskPath = path.join(projectRoot, safePath);
            try {
                const diskContent = fs.readFileSync(diskPath, 'utf-8');
                const incoming = typeof file?.content === 'string' ? file.content : '';
                return diskContent !== incoming;
            } catch {
                // File doesn't exist on disk yet — this IS a real config change
                return true;
            }
        }
        return true;
    });
}

async function restartProjectServer(projectId, reason = 'configuration update') {
    const existing = activeServers.get(projectId);
    if (!existing) return;

    console.log(`[${projectId}] Restarting Vite server (${reason})`);
    await closeProjectServer(projectId, 'restart');
}

async function closeProjectServer(projectId, reason = 'cleanup') {
    if (closingServers.has(projectId)) return;
    const instance = activeServers.get(projectId);
    if (!instance) return;

    closingServers.add(projectId);
    try {
        // Timeout: if Vite close() hangs (e.g. stuck HMR), force-continue after 10s
        await Promise.race([
            instance.vite.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Vite close timeout')), 10_000)),
        ]);
    } catch (error) {
        console.warn(`[${projectId}] Failed to close Vite instance during ${reason}:`, error?.message || error);
    }

    try {
        instance.server.close();
    } catch (error) {
        console.warn(`[${projectId}] Failed to close dummy server during ${reason}:`, error?.message || error);
    }

    activeServers.delete(projectId);
    projectErrors.delete(projectId);
    runtimeInstances.delete(projectId);
    recentUpdateFingerprints.delete(projectId);
    closingServers.delete(projectId);
}

function getPreviewPublicBaseUrl(req) {
    const configured = process.env.PREVIEW_PUBLIC_BASE_URL;
    if (configured && configured.trim()) return configured.replace(/\/$/, '');
    const host = req.get('host') || `localhost:${PORT}`;
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
    // Warnings (from non-blocking checks) don't make the preview "unhealthy"
    const isWarningOnly = kind === 'warning';

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

function getEsbuildLoader(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.tsx': return 'tsx';
        case '.ts': return 'ts';
        case '.jsx': return 'jsx';
        case '.js': return 'js';
        case '.mjs': return 'js';
        case '.mts': return 'ts';
        case '.cts': return 'ts';
        case '.json': return 'json';
        default: return null;
    }
}

function formatValidationError(filePath, error) {
    const message = error?.message || 'Invalid source file';
    const location = error?.location;
    const line = location?.line;
    const column = location?.column != null ? location.column + 1 : undefined;
    const lineText = location?.lineText || '';
    const prefix = line && column
        ? `${filePath}:${line}:${column}`
        : filePath;

    return {
        file: filePath,
        line,
        column,
        message,
        lineText,
        summary: `${prefix} ${message}`.trim(),
    };
}

// System/config files generated by initProject() — skip validation entirely.
// Vite reads these in-memory (configFile: false) so on-disk content is irrelevant.
const SKIP_VALIDATION_FILES = new Set([
    'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs',
    'tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs',
    'vite.config.ts', 'vite.config.js',
    'tsconfig.json', 'tsconfig.node.json',
    'components.json',
]);

async function validateSourceFile(filePath, content) {
    const basename = path.basename(filePath);
    if (SKIP_VALIDATION_FILES.has(basename)) return [];

    const loader = getEsbuildLoader(filePath);
    if (!loader) return [];

    const isScriptLike = ['tsx', 'ts', 'jsx', 'js', 'mjs', 'mts', 'cts'].includes(loader);
    if (isScriptLike) {
        try {
            const ts = require('typescript');
            const result = ts.transpileModule(content, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2020,
                    module: ts.ModuleKind.ESNext,
                    jsx: ts.JsxEmit.ReactJSX,
                },
                fileName: filePath,
                reportDiagnostics: true,
            });

            const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
            const hardErrors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
            if (hardErrors.length === 0) {
                // TypeScript passed — also run esbuild transform so errors like
                // `unexpected "{"` (JSX shorthand `<Comp {prop}>`) are caught before
                // the file is written to disk. These errors only appear at Vite
                // transform time and are NOT reported by TypeScript's transpileModule.
                if (loader === 'tsx' || loader === 'jsx') {
                    try {
                        const { transformWithEsbuild } = await getViteApi();
                        await transformWithEsbuild(content, filePath, {
                            loader,
                            jsx: 'automatic',
                            sourcemap: false,
                        });
                    } catch (esbuildErr) {
                        // TypeScript accepted the file — esbuild disagreement is
                        // non-fatal.  Let Vite HMR surface it as a browser overlay
                        // instead of hard-rejecting the entire update with 422.
                        const hint = esbuildErr?.errors?.[0]?.text || esbuildErr?.message || '';
                        console.warn(`[Validate] esbuild warning (TS passed): ${filePath} — ${hint}`);
                    }
                }
                return [];
            }

            return hardErrors.map((diag) => {
                const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n') || 'Invalid source file';
                if (!diag.file || typeof diag.start !== 'number') {
                    return {
                        file: filePath,
                        line: undefined,
                        column: undefined,
                        message,
                        lineText: '',
                        summary: `${filePath} ${message}`.trim(),
                    };
                }

                const lineAndChar = diag.file.getLineAndCharacterOfPosition(diag.start);
                const line = lineAndChar.line + 1;
                const column = lineAndChar.character + 1;
                const lineText = diag.file.text.split('\n')[line - 1] || '';

                return {
                    file: filePath,
                    line,
                    column,
                    message,
                    lineText,
                    summary: `${filePath}:${line}:${column} ${message}`.trim(),
                };
            });
        } catch (error) {
            return [formatValidationError(filePath, error)];
        }
    }

    try {
        const { transformWithEsbuild } = await getViteApi();
        await transformWithEsbuild(content, filePath, {
            loader,
            jsx: 'automatic',
            sourcemap: false,
        });
        return [];
    } catch (error) {
        if (Array.isArray(error?.errors) && error.errors.length > 0) {
            return error.errors.map((entry) => formatValidationError(filePath, entry));
        }

        return [formatValidationError(filePath, error)];
    }
}

function buildValidationResponse(errors) {
    const items = errors.map((error) => {
        const location = error.line && error.column ? `:${error.line}:${error.column}` : '';
        const codeLine = error.lineText ? `\n${error.lineText}` : '';
        return `${error.file}${location} ${error.message}${codeLine}`;
    });

    return {
        error: `Preview validation failed:\n${items.join('\n\n')}`,
        validationErrors: errors,
    };
}

function repairMalformedDefaultStringParams(content) {
    let next = content;
    // Handles patterns like: suffix = ', prefix = ''
    next = next.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)'(?=\s*,\s*[a-zA-Z_$][\w$]*\s*=)/g, "$1''");
    next = next.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)"(?=\s*,\s*[a-zA-Z_$][\w$]*\s*=)/g, '$1""');
    return next;
}

// ── Stable Architecture: Cross-file import resolution check ───────────────────
// Validates that all relative imports resolve to files that WILL exist after
// the update. This catches "Module not found" errors BEFORE writing to disk,
// which is the #1 cause of broken previews.
function checkCrossFileImports(projectRoot, requestFiles, fullSync) {
    const virtualFS = new Set();

    // 1. Include existing files on disk (unless fullSync replaces everything)
    if (!fullSync) {
        const walkDisk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (['node_modules', '.vite-cache', '.git', '.cache', '.src-snapshot'].includes(entry.name)) continue;
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) walkDisk(abs);
                else virtualFS.add(path.relative(projectRoot, abs).replace(/\\/g, '/'));
            }
        };
        walkDisk(projectRoot);
    }

    // 2. Overlay request files (they are the new source of truth for these paths)
    const requestFileMap = new Map();
    for (const file of requestFiles) {
        const safePath = file.path.replace(/^\/+/, '');
        virtualFS.add(safePath);
        requestFileMap.set(safePath, file.content || '');
    }

    // 3. Check relative imports in all script files
    const errors = [];
    const scriptExts = /\.(tsx?|jsx?)$/;
    const scriptFiles = [...virtualFS].filter((p) => scriptExts.test(p));

    for (const filePath of scriptFiles) {
        let content = requestFileMap.get(filePath);
        if (content === undefined) {
            try { content = fs.readFileSync(path.join(projectRoot, filePath), 'utf-8'); }
            catch { continue; }
        }
        if (!content || typeof content !== 'string') continue;

        // Skip binary-encoded files
        if (content.startsWith('__ECOMGEAR_BIN64__')) continue;

        // Extract relative imports (starting with ./ or ../)
        const importRegex = /(?:import\s+(?:[\w{}\s*,]+\s+from\s+)?|require\s*\(\s*|export\s+(?:[\w{}\s*,]+\s+from\s+)?)['"](\.[^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            const importPath = match[1];
            // Skip CSS/SCSS/asset imports (these are handled by Vite)
            if (/\.(css|scss|sass|less|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|mp4|webm)$/.test(importPath)) continue;

            const fileDir = path.dirname(filePath);
            const resolved = path.posix.normalize(path.posix.join(fileDir, importPath));

            // Check all possible resolution paths
            const candidates = [
                resolved,
                resolved + '.tsx',
                resolved + '.ts',
                resolved + '.jsx',
                resolved + '.js',
                resolved + '/index.tsx',
                resolved + '/index.ts',
                resolved + '/index.jsx',
                resolved + '/index.js',
            ];

            if (!candidates.some((c) => virtualFS.has(c))) {
                errors.push({
                    file: filePath,
                    message: `Unresolved local import '${importPath}' — no matching file found`,
                    summary: `${filePath}: Unresolved import '${importPath}'`,
                });
            }
        }
    }

    return errors;
}

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

// ── Stable Architecture: Post-write Vite transform check ─────────────────────
// After files are written, attempt to load the entry point through Vite's
// module graph. If it fails to transform, the project is broken.
async function quickViteBuildCheck(projectId, projectRoot) {
    const instance = activeServers.get(projectId);
    if (!instance || !instance.vite) return { ok: true, errors: [] };

    // Scan ALL source files — not just entry points — so syntax errors in
    // pages / components are caught immediately (before the agent health-checks).
    const srcDir = path.join(projectRoot, 'src');
    const candidateFiles = [];
    if (fs.existsSync(srcDir)) {
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name));
                } else if (/\.(tsx|jsx|ts|js)$/.test(entry.name)) {
                    candidateFiles.push(path.join(dir, entry.name));
                }
            }
        };
        walk(srcDir);
    }

    const errors = [];

    for (const absPath of candidateFiles) {
        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            const ext = path.extname(absPath).toLowerCase();
            const { transformWithEsbuild } = await getViteApi();
            await transformWithEsbuild(content, absPath, {
                loader: ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : ext === '.ts' ? 'ts' : 'js',
                jsx: 'automatic',
                sourcemap: false,
            });
        } catch (err) {
            const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
            if (Array.isArray(err?.errors) && err.errors.length > 0) {
                errors.push(...err.errors.map((e) => formatValidationError(relPath, e)));
            } else {
                errors.push(formatValidationError(relPath, err));
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

function delimiterImbalanceScore(content) {
    const chars = String(content || '');
    let paren = 0;
    let brace = 0;
    let bracket = 0;

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '(') paren += 1;
        else if (ch === ')') paren -= 1;
        else if (ch === '{') brace += 1;
        else if (ch === '}') brace -= 1;
        else if (ch === '[') bracket += 1;
        else if (ch === ']') bracket -= 1;
    }

    return Math.abs(paren) + Math.abs(brace) + Math.abs(bracket);
}

function trimTrailingOrphanClosers(content) {
    const lines = String(content || '').split(/\r?\n/);
    if (lines.length === 0) {
        return { content: String(content || ''), removed: 0 };
    }

    const orphanLinePattern = /^\s*[\)\}\];,]+\s*$/;
    let current = lines.slice();
    let currentScore = delimiterImbalanceScore(current.join('\n'));
    let removed = 0;

    while (current.length > 0 && orphanLinePattern.test(current[current.length - 1])) {
        const candidate = current.slice(0, -1);
        const candidateText = candidate.join('\n');
        const candidateScore = delimiterImbalanceScore(candidateText);
        if (candidateScore > currentScore) {
            break;
        }

        current = candidate;
        currentScore = candidateScore;
        removed += 1;
    }

    return { content: current.join('\n'), removed };
}

async function materializeProjectFiles(projectId, projectRoot, files) {
    const userFilePaths = new Set(files.map((file) => file.path.replace(/^\/+/, '')));
    const allFixedIssues = [];
    const validationErrors = [];
    const preparedFiles = [];
    const binaryWroteFiles = [];
    const configFiles = new Set(['vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'package.json', 'postcss.config.js', 'tailwind.config.js', 'components.json']);

    // Known-good scaffold defaults for JSON config files
    const SCAFFOLD_JSON_DEFAULTS = {
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                target: 'ES2020', useDefineForClassFields: true,
                lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
                skipLibCheck: true, moduleResolution: 'bundler',
                allowImportingTsExtensions: true, resolveJsonModule: true,
                isolatedModules: true, noEmit: true, jsx: 'react-jsx',
                strict: true, noUnusedLocals: false, noUnusedParameters: false,
                noFallthroughCasesInSwitch: true, baseUrl: '.', paths: { '@/*': ['./src/*'] },
            },
            include: ['src'], references: [],
        }, null, 2),
        'tsconfig.node.json': JSON.stringify({
            compilerOptions: {
                composite: true, skipLibCheck: true, module: 'ESNext',
                moduleResolution: 'bundler', allowSyntheticDefaultImports: true,
                strict: true, noEmit: true,
            },
            include: ['vite.config.ts'],
        }, null, 2),
    };

    for (const file of files) {
        if (file.content == null) {
            console.warn('[Materialize] Skipping file with null/undefined content:', file.path);
            continue;
        }
        const safePath = file.path.replace(/^\/+/, '');
        const filePath = path.join(projectRoot, safePath);

        // Security: reject any path that escapes the project root (path traversal).
        // path.join() alone does NOT prevent ../ sequences — must resolve & compare.
        const resolvedFilePath = path.resolve(filePath);
        const resolvedProjectRoot = path.resolve(projectRoot);
        if (!resolvedFilePath.startsWith(resolvedProjectRoot + path.sep) && resolvedFilePath !== resolvedProjectRoot) {
            console.warn(`[Security] Path traversal blocked: "${file.path}" resolved to "${resolvedFilePath}"`);
            continue;
        }

        // Security: block writes to sensitive directories that must never be
        // overwritten by agent-generated files.
        const topSegment = safePath.split('/')[0];
        if (['node_modules', '.git', 'dist', '.cache', '.vite-cache', '.src-snapshot'].includes(topSegment)) {
            console.warn(`[Security] Write to protected directory blocked: "${safePath}"`);
            continue;
        }

        if (/\.json$/i.test(safePath) && !safePath.startsWith('node_modules')) {
            try {
                JSON.parse(file.content);
            } catch {
                const fallback = SCAFFOLD_JSON_DEFAULTS[safePath];
                if (fallback) {
                    console.warn(`[Materialize] ${safePath}: invalid JSON — replacing with scaffold default`);
                    file.content = fallback;
                    allFixedIssues.push(`${safePath}: Replaced corrupt JSON with scaffold default`);
                } else if (fs.existsSync(filePath)) {
                    // Keep existing file on disk rather than overwriting with garbage
                    console.warn(`[Materialize] ${safePath}: invalid JSON — keeping existing file`);
                    allFixedIssues.push(`${safePath}: Kept existing file (new content was invalid JSON)`);
                    continue;
                }
            }
        }
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Binary files arrive as base64-encoded strings from the agent sync.
        // Decode and write them directly — no preprocessing or validation needed.
        if (file.content && file.content.startsWith('__ECOMGEAR_BIN64__')) {
            const buf = Buffer.from(file.content.slice('__ECOMGEAR_BIN64__'.length), 'base64');
            fs.writeFileSync(filePath, buf);
            binaryWroteFiles.push(filePath);
            continue;
        }

        const { content: preprocessedContent, issues } = preprocessFile(safePath, file.content);
        allFixedIssues.push(...issues.map((issue) => `${safePath}: ${issue}`));

        let contentToWrite = preprocessedContent;
        if (safePath === 'index.html') {
            contentToWrite = contentToWrite
                .replace(/src="\/src\//g, 'src="./src/')
                .replace(/href="\/src\//g, 'href="./src/');
        }

        if (safePath === 'package.json') {
            contentToWrite = harmonizePackageJson(contentToWrite, files);
        }

        let fileValidationErrors = await validateSourceFile(safePath, contentToWrite);

        // Validation fallback: attempt one more surgical repair for malformed default
        // string parameters before declaring the file invalid.
        if (fileValidationErrors.length > 0 && /\.(tsx?|jsx?)$/.test(safePath)) {
            const repaired = repairMalformedDefaultStringParams(contentToWrite);
            if (repaired !== contentToWrite) {
                const repairedValidationErrors = await validateSourceFile(safePath, repaired);
                if (repairedValidationErrors.length === 0) {
                    contentToWrite = repaired;
                    allFixedIssues.push(`${safePath}: Fixed malformed default string parameter (validation fallback)`);
                    fileValidationErrors = [];
                }
            }
        }

        validationErrors.push(...fileValidationErrors);

        preparedFiles.push({
            safePath,
            filePath,
            contentToWrite,
            shouldSkipWrite: configFiles.has(safePath) && fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === contentToWrite,
        });
    }

    if (allFixedIssues.length > 0) {
        const uniqueFilePaths = new Set(allFixedIssues.map((issue) => issue.split(':')[0])).size;
        const uniqueIssues = [...new Set(allFixedIssues)];
        const sample = uniqueIssues.slice(0, 6).join(' | ');
        console.log(
            `[Preprocess] Applied ${allFixedIssues.length} fix(es) across ${uniqueFilePaths} file(s)` +
            (sample ? `: ${sample}${uniqueIssues.length > 6 ? ' | ...' : ''}` : '')
        );
    }

    // Validation errors are treated as non-blocking warnings — files are written
    // and Vite HMR surfaces them as browser overlays, consistent with esbuild and
    // cross-file import handling. Hard-rejecting (422) blocks the AI agent loop.
    if (validationErrors.length > 0) {
        const sample = validationErrors.slice(0, 3).map((e) => e.summary).join(' | ');
        console.warn(`[Validate] ${validationErrors.length} warning(s) — writing files anyway: ${sample}`);
    }

    const wroteFiles = [...binaryWroteFiles];
    for (const prepared of preparedFiles) {
        if (prepared.shouldSkipWrite) {
            continue;
        }

        fs.writeFileSync(prepared.filePath, prepared.contentToWrite);
        wroteFiles.push(prepared.filePath);
    }

    const projectIdInstance = activeServers.get(projectId);
    if (projectIdInstance && projectIdInstance.vite) {
        try {
            // Batch write complete: invalidate the whole module graph ONCE and send
            // a SINGLE full-reload to the browser.
            // Emitting one watcher 'change' event PER FILE caused N separate Vite HMR
            // processing cycles — each .tsx file without a self-accepting HMR boundary
            // triggered its own 'full-reload' WebSocket message (26 files = 26
            // 'page reload' log entries). The Vite client debounces but the module
            // graph ends in a partially-stale state causing cascading re-requests.
            projectIdInstance.vite.moduleGraph.invalidateAll();
            projectIdInstance.vite.ws.send({ type: 'full-reload', path: '*' });
        } catch (err) {
            console.warn('Failed to trigger Vite reload:', err);
        }
    }

    return { userFilePaths, allFixedIssues, validationErrors, wroteFiles };
}

function pruneProjectFiles(projectRoot, userFilePaths) {
    const removed = [];
    const protectedTopLevel = new Set(['node_modules', '.vite-cache', '.git', '.cache', '.src-snapshot']);

    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');

            if (!relPath) continue;

            // Protect critical top-level paths whether they are real directories
            // OR symlinks (node_modules is always a symlink to the shared install).
            // Without this guard, fullSync pruning deleted the node_modules symlink,
            // causing Vite to fail resolving any import until the next initProject call.
            if (protectedTopLevel.has(relPath.split('/')[0])) continue;

            if (entry.isDirectory()) {
                walk(absPath);
                try {
                    const remaining = fs.readdirSync(absPath);
                    if (remaining.length === 0) {
                        fs.rmSync(absPath, { recursive: true, force: true });
                    }
                } catch { /* dir may have been removed or repopulated */ }
                continue;
            }

            // Binary files now travel in the payload as base64, so they appear
            // in userFilePaths like any other file. The normal check below
            // handles pruning stale binaries correctly.
            if (!userFilePaths.has(relPath)) {
                try {
                    fs.rmSync(absPath, { force: true });
                    removed.push(relPath);
                } catch { /* file may be locked by Vite */ }
            }
        }
    }

    walk(projectRoot);
    return removed;
}

function collectReferencedPackages(files) {
    const referencedPackages = new Set();

    for (const file of files) {
        const safePath = file.path.replace(/^\/+/, '');
        if (!/\.(tsx?|jsx?)$/.test(safePath)) {
            continue;
        }

        const importMatches = file.content.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
            const specifier = match[1] || match[2];
            if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) {
                continue;
            }

            if (specifier.startsWith('@')) {
                const scoped = specifier.split('/').slice(0, 2).join('/');
                referencedPackages.add(scoped);
                continue;
            }

            referencedPackages.add(specifier.split('/')[0]);
        }
    }

    return referencedPackages;
}

function harmonizePackageJson(packageJsonContent, files) {
    try {
        const parsed = JSON.parse(packageJsonContent);
        const referencedPackages = collectReferencedPackages(files);
        if (referencedPackages.size === 0) {
            return packageJsonContent;
        }

        const previewPackageJsonPath = path.join(__dirname, 'package.json');
        const previewPackageJson = JSON.parse(fs.readFileSync(previewPackageJsonPath, 'utf-8'));
        const availableDeps = {
            ...(previewPackageJson.dependencies || {}),
            ...(previewPackageJson.devDependencies || {}),
        };

        parsed.dependencies = parsed.dependencies || {};

        for (const pkg of referencedPackages) {
            if (!parsed.dependencies[pkg] && availableDeps[pkg]) {
                parsed.dependencies[pkg] = availableDeps[pkg];
            }
        }

        return JSON.stringify(parsed, null, 2);
    } catch (error) {
        console.warn('Failed to harmonize package.json:', error);
        return packageJsonContent;
    }
}

// Base Tailwind + shadcn CSS — plain CSS vars, no @apply color-tokens
const TAILWIND_CSS_BASE = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
  /* Plain CSS — avoids @apply errors when tailwind.config lacks color tokens */
  * { border-color: hsl(var(--border, 214.3 31.8% 91.4%)); }
  body { background-color: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%)); }
}
`;

// ============================================================
// FILE VALIDATION & AUTO-FIX UTILITIES
// Catches common issues before they reach Vite
// ============================================================

/**
 * Fix common syntax issues in files before writing them
 */
function preprocessFile(filePath, content) {
    // Skip Supabase edge function files -- Deno backend, not React source
    if (filePath.startsWith('supabase/') || filePath.includes('/supabase/')) {
        return { content: content ?? '', issues: [] };
    }
    let fixed = content;
    const issues = [];

    // CSS files: ensure @tailwind directives + fix @apply color-token directives
    if (filePath.endsWith('.css')) {
        const isIndexCss = filePath === 'src/index.css' || filePath.endsWith('/src/index.css') || filePath === 'index.css';

        // Fix: @import rules must precede all other statements in CSS.
        // AI often places @import after @tailwind directives which causes a Vite
        // "[vite:css] @import must precede all other statements" error and prevents
        // the CSS from loading (blank page).
        // Move all @import lines to the very top of the file.
        if (isIndexCss && fixed.includes('@import') && fixed.includes('@tailwind')) {
            const lines = fixed.split('\n');
            const importLines = [];
            const otherLines = [];
            for (const line of lines) {
                if (/^\s*@import\s/.test(line)) {
                    importLines.push(line);
                } else {
                    otherLines.push(line);
                }
            }
            if (importLines.length > 0) {
                const reordered = [...importLines, '', ...otherLines].join('\n');
                if (reordered !== fixed) {
                    fixed = reordered;
                    issues.push('Moved @import rules before @tailwind directives');
                }
            }
        }

        if (isIndexCss && !fixed.includes('@tailwind')) {
            fixed = TAILWIND_CSS_BASE + '\n' + fixed;
            issues.push('Prepended @tailwind directives');
        }
        // Strip @apply color-token directives that require matching tailwind.config keys
        const applyFixes = [
            [/@apply\s+(?=[^;]*bg-gradient-to-br)(?=[^;]*from-slate-50)(?=[^;]*via-blue-50)(?=[^;]*to-purple-50)(?=[^;]*text-foreground)(?=[^;]*min-h-screen)[^;]*;/g, 'background-image: linear-gradient(135deg, #f8fafc 0%, #eff6ff 48%, #f5f3ff 100%); color: hsl(var(--foreground, 222.2 84% 4.9%)); min-height: 100vh;'],
            [/@apply\s+border-border\s*;/g, 'border-color: hsl(var(--border, 214.3 31.8% 91.4%));'],
            [/@apply\s+bg-background\s+text-foreground\s*;/g, 'background-color: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%));'],
            [/@apply\s+bg-background\s*;/g, 'background-color: hsl(var(--background, 0 0% 100%));'],
            [/@apply\s+text-foreground\s*;/g, 'color: hsl(var(--foreground, 222.2 84% 4.9%));'],
        ];
        for (const [pattern, replacement] of applyFixes) {
            if (pattern.test(fixed)) {
                fixed = fixed.replace(pattern, replacement);
                issues.push('Replaced @apply color-token with plain CSS');
            }
        }

        // Generic safety net: convert remaining @apply with custom color tokens to plain CSS.
        // Catches patterns like @apply bg-muted, @apply text-accent-foreground, etc.
        const COLOR_TOKENS = {
            background: '0 0% 100%', foreground: '222.2 84% 4.9%',
            primary: '222.2 47.4% 11.2%', 'primary-foreground': '210 40% 98%',
            secondary: '210 40% 96.1%', 'secondary-foreground': '222.2 47.4% 11.2%',
            muted: '210 40% 96.1%', 'muted-foreground': '215.4 16.3% 46.9%',
            accent: '210 40% 96.1%', 'accent-foreground': '222.2 47.4% 11.2%',
            destructive: '0 84.2% 60.2%', 'destructive-foreground': '210 40% 98%',
            popover: '0 0% 100%', 'popover-foreground': '222.2 84% 4.9%',
            card: '0 0% 100%', 'card-foreground': '222.2 84% 4.9%',
            border: '214.3 31.8% 91.4%', input: '214.3 31.8% 91.4%', ring: '222.2 84% 4.9%',
        };
        const tokenNames = Object.keys(COLOR_TOKENS).sort((a, b) => b.length - a.length).join('|');
        const genericApplyRe = new RegExp(
            `@apply\\s+(?:bg|text|border|ring)-(${tokenNames})\\s*;`, 'g'
        );
        fixed = fixed.replace(genericApplyRe, (match, token) => {
            const fallback = COLOR_TOKENS[token];
            const varName = `--${token}`;
            if (match.startsWith('@apply bg-')) {
                issues.push(`Replaced @apply bg-${token} with plain CSS`);
                return `background-color: hsl(var(${varName}, ${fallback}));`;
            } else if (match.startsWith('@apply text-')) {
                issues.push(`Replaced @apply text-${token} with plain CSS`);
                return `color: hsl(var(${varName}, ${fallback}));`;
            } else if (match.startsWith('@apply border-')) {
                issues.push(`Replaced @apply border-${token} with plain CSS`);
                return `border-color: hsl(var(${varName}, ${fallback}));`;
            } else if (match.startsWith('@apply ring-')) {
                issues.push(`Replaced @apply ring-${token} with plain CSS`);
                return `--tw-ring-color: hsl(var(${varName}, ${fallback}));`;
            }
            return match;
        });

        return { content: fixed, issues };
    }

    // Only process TypeScript/JavaScript files
    if (!filePath.match(/\.(tsx?|jsx?|mjs)$/)) {
        return { content: fixed, issues };
    }

    // Fix 1: Remove .tsx/.ts/.jsx/.js extensions from imports
    const extPatterns = [
        { pattern: /from\s+['"]([^'"]+)\.tsx['"]/g, ext: '.tsx' },
        { pattern: /from\s+['"]([^'"]+)\.ts['"]/g, ext: '.ts' },
        { pattern: /from\s+['"]([^'"]+)\.jsx['"]/g, ext: '.jsx' },
        { pattern: /from\s+['"]([^'"]+)\.js['"]/g, ext: '.js' },
    ];
    extPatterns.forEach(({ pattern, ext }) => {
        if (pattern.test(fixed)) {
            fixed = fixed.replace(pattern, 'from "$1"');
            issues.push(`Removed ${ext} extension from imports`);
        }
    });

    // Fix 2: React import injection intentionally removed.
    // The project uses @vitejs/plugin-react with "jsx": "react-jsx" (automatic transform).
    // React is injected by the compiler — explicit `import React` is not needed and
    // causes duplicate-identifier errors when files also import React hooks.

    // Fix 3: Replace class= with className= in JSX
    if ((filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) && / class=/i.test(fixed)) {
        fixed = fixed.replace(/ class=/gi, ' className=');
        issues.push('Fixed class -> className');
    }

    // Fix 3.1: Repair dangling empty string literals in assignment/property contexts only.
    // Examples:
    // - suffix = ',    -> suffix = '',
    // - prefix: ",    -> prefix: "",
    // Keep this narrowly scoped to avoid mutating valid string syntax in other contexts.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)(['"])(?=\s*[,}\]])/g, '$1$2$2');
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*:\s*)(['"])(?=\s*[,}\]])/g, '$1$2$2');
        if (fixed !== before) {
            issues.push('Fixed dangling empty string literal');
        }
    }

    // Fix 3.13: Repair malformed default-string params in destructuring/signatures.
    // Examples:
    // - suffix = ', prefix = ''
    // - title = ", subtitle = ""
    // This specifically targets a quote right after `=` when the next token is
    // another parameter assignment, and normalizes it to an empty string literal.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)'(?=\s*,\s*[a-zA-Z_$][\w$]*\s*=)/g, "$1''");
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)"(?=\s*,\s*[a-zA-Z_$][\w$]*\s*=)/g, '$1""');
        if (fixed !== before) {
            issues.push('Fixed malformed default string parameter');
        }
    }

    // Fix 3.12: Normalize bare App imports.
    // Some generated outputs use `from "App"`, which breaks module resolution in preview.
    if (/(^|\/)src\/.*\.(tsx|jsx|ts|js)$/.test(filePath)) {
        const before = fixed;
        fixed = fixed.replace(/from\s+['"]App['"]/g, "from '@/App'");
        if (fixed !== before) {
            issues.push('Normalized bare App import path');
        }
    }

    // Fix 3.2: Repair doubled quote typo in function arguments only.
    // Example: console.error('Error:'', err) -> console.error('Error:', err)
    // Require at least one char inside the first string so valid empty literals
    // like '' are not accidentally collapsed back to a single quote.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/('(?:[^'\\\n\r]|\\.)+?)''(?=\s*,)/g, '$1\'');
        fixed = fixed.replace(/("(?:[^"\\\n\r]|\\.)+?)""(?=\s*,)/g, '$1"');
        if (fixed !== before) {
            issues.push('Fixed doubled quote typo in function arguments');
        }
    }

    // Fix 3.3: Repair malformed empty-string argument placeholders.
    // Examples:
    // - window.history.replaceState({}, ', window.location.pathname)
    // - someFn(a, ", b)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/,\s*'\s*,/g, ", '',");
        fixed = fixed.replace(/,\s*"\s*,/g, ', "",');
        if (fixed !== before) {
            issues.push('Fixed malformed empty-string argument');
        }
    }

    // Fix 3.35: Repair malformed empty-string object values (LLM truncation artifact).
    // Scope this to object-property assignments only so valid string literals
    // like console.error('Error: ', err) are never mutated.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        const malformedPropEmptyStringPattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)'\s*(?=[,}])/g;
        const malformedPropEmptyDoublePattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)"\s*(?=[,}])/g;
        const malformedPropSmartQuotePattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)[‘’]\s*(?=[,}])/g;

        fixed = fixed
            .replace(malformedPropEmptyStringPattern, "$1''")
            .replace(malformedPropEmptyDoublePattern, '$1""')
            .replace(malformedPropSmartQuotePattern, "$1''");

        if (fixed !== before) {
            issues.push('Repaired malformed empty-string object values');
        }
    }

    // Fix 3.4: Repair malformed History API title arg.
    // Example: window.history.replaceState({}, ', window.location.pathname)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(replaceState\(\s*\{\s*\}\s*,\s*)'(?=\s*,)/g, "$1''");
        fixed = fixed.replace(/(replaceState\(\s*\{\s*\}\s*,\s*)"(?=\s*,)/g, '$1""');
        if (fixed !== before) {
            issues.push('Fixed malformed History API title argument');
        }
    }

    // Fix 3.5: Fix common event handler casing
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const events = ['onclick', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onmouseenter', 'onmouseleave'];
        events.forEach(event => {
            const regex = new RegExp(` ${event}=`, 'gi');
            const proper = ` ${event.slice(0, 2)}${event.charAt(2).toUpperCase()}${event.slice(3)}=`;
            if (regex.test(fixed)) {
                fixed = fixed.replace(regex, proper);
                issues.push(`Fixed ${event} -> ${proper.trim()}`);
            }
        });
    }

    // Fix 3.6: Convert BrowserRouter / createBrowserRouter → Hash equivalents.
    // BrowserRouter requires a `basename` prop to work under sub-path hosting and
    // causes parse errors when the agent forgets the space before `basename=`.
    // HashRouter / createHashRouter works out-of-the-box in the preview environment.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts')) {
        if (fixed.includes('BrowserRouter') || fixed.includes('createBrowserRouter')) {
            const before = fixed;
            // Step 1: repair missing space (e.g. <BrowserRouterbasename= → <BrowserRouter basename=)
            fixed = fixed.replace(/<BrowserRouter([a-z])/g, '<BrowserRouter $1');
            // Step 2: replace createBrowserRouter → createHashRouter (must be before BrowserRouter rename)
            fixed = fixed.replace(/\bcreateStaticRouter\b/g, '__STATIC_ROUTER_KEEP__'); // protect unrelated
            fixed = fixed.replace(/\bcreateBrowserRouter\b/g, 'createHashRouter');
            fixed = fixed.replace(/__STATIC_ROUTER_KEEP__/g, 'createStaticRouter');
            // Step 3: replace <BrowserRouter> component and its import name
            fixed = fixed.replace(/\bBrowserRouter\b/g, 'HashRouter');
            // Step 4: strip any basename prop from the resulting HashRouter tag
            fixed = fixed.replace(/<HashRouter([^>]*)\bbasename=(?:\{[^}]*\}|"[^"]*"|'[^']*')([^>]*)>/g, (m, pre, post) => {
                const attrs = (pre + post).trim();
                return attrs ? `<HashRouter ${attrs}>` : '<HashRouter>';
            });
            // Step 5: strip basename option from createHashRouter({ basename: ... }) call
            fixed = fixed.replace(/createHashRouter\((\[[^\]]*\])\s*,\s*\{[^}]*\bbasename\b[^}]*\}\)/gs,
                (m, routes) => `createHashRouter(${routes})`);
            if (fixed !== before) {
                issues.push('Converted BrowserRouter/createBrowserRouter → HashRouter/createHashRouter');
            }
        }
    }

    // Fix 3.6b: Remove <Navigate to="/home"> redirect and promote /home route to /
    // Agents often generate: <Route path="/" element={<Navigate to="/home" replace />} />
    //                         <Route path="/home" element={<HomePage />} />
    // This causes the preview to always redirect to /#/home, which then gets stored
    // as the current route and breaks on any subsequent build that lacks a /home route.
    if ((filePath === 'src/App.tsx' || filePath.endsWith('/App.tsx')) &&
        /Navigate\s+to=["']\/home["']/.test(fixed) &&
        /path=["']\/home["']/.test(fixed)) {
        const before = fixed;
        // Remove the Navigate redirect line entirely
        fixed = fixed.replace(
            /[ \t]*<Route[^>]*path=["']\/["'][^>]*element=\{[^}]*Navigate[^}]*to=["']\/home["'][^}]*\}[^/]*(\/?>|\/>)\s*\n?/g,
            ''
        );
        // Also remove self-closing variant
        fixed = fixed.replace(
            /[ \t]*<Route[^/]*\/>[^\n]*Navigate[^\n]*\/home[^\n]*\n?/g,
            ''
        );
        // Promote /home route to /
        fixed = fixed.replace(
            /path=["']\/home["']/g,
            'path="/"'
        );
        if (fixed !== before) {
            issues.push('Promoted /home route to / and removed Navigate redirect');
        }
    }

    // Fix 3.7: Repair common router closing-tag mismatches (e.g. <HashRouter> ... </Router>)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const before = fixed;
        if (fixed.includes('<HashRouter') && fixed.includes('</Router>') && !fixed.includes('<Router')) {
            fixed = fixed.replace(/<\/Router>/g, '</HashRouter>');
        }
        if (fixed !== before) {
            issues.push('Fixed router closing-tag mismatch');
        }
    }

    // Fix 3.8: Encode raw " inside url('...') → %22 to prevent Babel JSX parse errors
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const before = fixed;
        fixed = fixed.replace(/url\((['"])(.*?)\1\)/gs, (m, q, inner) => `url(${q}${inner.replace(/"/g, '%22')}${q})`);
        fixed = fixed.replace(/url\(([^'"()\s][^()]*)\)/gs, (m, inner) => inner.includes('"') ? `url(${inner.replace(/"/g, '%22')})` : m);
        if (fixed !== before) {
            issues.push('Encoded raw quotes in url()');
        }
    }

    // Fix 3.9: Ensure App.tsx and component files have export default
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        // Check for named function/const components without export
        const componentMatch = fixed.match(/(?:^|\n)(function|const)\s+([A-Z][a-zA-Z0-9]*)\s*(?:=|[(\s])/);
        if (componentMatch) {
            const componentName = componentMatch[2];
            const hasExportDefault = new RegExp(`export\\s+default\\s+${componentName}\\b`).test(fixed) ||
                                     new RegExp(`export\\s+default\\s+function\\s+${componentName}\\b`).test(fixed);
            if (!hasExportDefault && !fixed.includes('export default')) {
                fixed = fixed.trimEnd() + `\n\nexport default ${componentName};\n`;
                issues.push(`Added missing export default for ${componentName}`);
            }
        }
    }

    // Fix 3.10: Repair unmatched JSX fragment shorthand (<> without </>)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const fragmentOpenCount = (fixed.match(/<>/g) || []).length;
        const fragmentCloseCount = (fixed.match(/<\/>/g) || []).length;

        if (fragmentOpenCount > fragmentCloseCount) {
            const before = fixed;

            // Common failure mode: return ( <> <Router>...</Router> );
            fixed = fixed.replace(/return\s*\(\s*<>\s*/m, 'return (\n    ');

            // Fallback: if no replacement happened, append missing closers before final `);`
            if (fixed === before) {
                const missing = fragmentOpenCount - fragmentCloseCount;
                if (missing > 0) {
                    fixed = fixed.replace(/\n\s*\);\s*$/, `\n${'  '.repeat(2)}${'</>\n'.repeat(missing)}  );`);
                }
            }

            if (fixed !== before) {
                issues.push('Fixed unmatched JSX fragment shorthand');
            }
        }
    }

    // Fix 3.11: Repair common truncated empty-string calls from streamed generation
    // Examples:
    // - num.toString().split(').map(...)   -> split('')
    // - useState(');                       -> useState('')
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;

        // string.split(').map(...) => string.split('').map(...)
        fixed = fixed.replace(/\.split\(\s*'\s*\)(?=\s*\.map\s*\()/g, ".split('')");
        fixed = fixed.replace(/\.split\(\s*"\s*\)(?=\s*\.map\s*\()/g, '.split("")');

        // useState('); / useState("); => useState('') / useState("")
        fixed = fixed.replace(/useState\(\s*'\s*\)(?=\s*[;,\)])/g, "useState('')");
        fixed = fixed.replace(/useState\(\s*"\s*\)(?=\s*[;,\)])/g, 'useState("")');

        if (fixed !== before) {
            issues.push('Fixed truncated empty-string calls');
        }
    }

    // Fix 4: Ensure main.tsx has CSS import
    if (filePath.endsWith('/main.tsx') || filePath === 'src/main.tsx') {
        if (!fixed.includes("import './index.css'") && !fixed.includes('import "./index.css"')) {
            const reactImportMatch = fixed.match(/(import.*from.*['"]react['"];?\s*\n)/);
            if (reactImportMatch) {
                fixed = fixed.replace(
                    reactImportMatch[0],
                    reactImportMatch[0] + "import './index.css';\n"
                );
                issues.push('Added CSS import to main.tsx');
            }
        }

        // Fix 4b: Repair truncated render() — replace whole file if parens unbalanced
        // Handles both `ReactDOM.createRoot(...)` and named-import `createRoot(...)` patterns.
        if (fixed.includes('createRoot') && fixed.includes('.render(')) {
            const renderIdx = fixed.indexOf('.render(');
            if (renderIdx !== -1) {
                const afterRender = fixed.slice(renderIdx + 8);
                let depth = 1, balanced = false;
                for (const ch of afterRender) {
                    if (ch === '(') depth++;
                    else if (ch === ')') { depth--; if (depth === 0) { balanced = true; break; } }
                }
                if (!balanced) {
                    const appImport = (fixed.match(/import\s+App\s+from\s+['"]([^'"]+)['"]/) || [])[1] || './App';
                    fixed = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from '${appImport}'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n)\n`;
                    issues.push('Replaced truncated main.tsx');
                }
            }
        }

        // Fix 4c: Replace near-empty main.tsx
        if (!fixed.includes('createRoot') && fixed.trim().length < 100) {
            fixed = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n)\n`;
            issues.push('Replaced empty main.tsx');
        }
    }

    // Fix 5: Replace import.meta.env.* EXCEPT BASE_URL with safe literal values.
    // BASE_URL is left alone — Vite replaces it with the correct base path at serve time
    // (base: `/preview/${projectId}/` in vite config). Replacing it here would break asset paths.
    // DEV → true, PROD → false, MODE → "development", others → ""
    fixed = fixed.replace(/import\.meta\.env\.([A-Z_]+)/g, (match, varName) => {
        if (varName === 'BASE_URL') return match; // Let Vite handle it
        if (varName === 'DEV') return 'true';
        if (varName === 'PROD') return 'false';
        if (varName === 'MODE') return '"development"';
        return '""';
    });
    if (fixed !== content && fixed.includes('""')) {
        issues.push('Replaced import.meta.env access with empty string');
    }

    // Fix 5.5: Remove orphaned closing delimiters after export statements.
    // Common streamed-generation artifact:
    //   export default Component;
    //   }
    //   )}
    // or
    //   export { useToast, toast }
    //   }
    //   }
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        // After `export default X` (semicolon optional), strip trailing lines made only of closers.
        fixed = fixed.replace(/(\nexport\s+default\s+[A-Za-z_$][\w$]*\s*;?)\n((?:\s*[\)\}\];,]+\s*\n)+)/g, '$1\n');
        // After `export { ... }` (semicolon optional), strip same artifacts.
        fixed = fixed.replace(/(\nexport\s*\{[^\n]*\}\s*;?)\n((?:\s*[\)\}\];,]+\s*\n)+)/g, '$1\n');
        // Same-line variant: `export default X; )}`
        fixed = fixed.replace(/(\nexport\s+default\s+[A-Za-z_$][\w$]*\s*;?)\s*[\)\}\];,]+\s*(\n|$)/g, '$1$2');
        fixed = fixed.replace(/(\nexport\s*\{[^\n]*\}\s*;?)\s*[\)\}\];,]+\s*(\n|$)/g, '$1$2');
        if (fixed !== before) {
            issues.push('Removed orphaned closing delimiters after export');
        }
    }

    // Fix 6: Trim trailing orphan closers like standalone ")" or "}" lines.
    // This specifically targets streamed truncation artifacts that trigger
    // "Declaration or statement expected" at EOF.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const trimmed = trimTrailingOrphanClosers(fixed);
        if (trimmed.removed > 0 && trimmed.content !== fixed) {
            fixed = trimmed.content;
            issues.push(`Removed ${trimmed.removed} trailing orphan closer line(s)`);
        }
    }

    return { content: fixed, issues };
}

/**
 * Ensure essential files exist for a valid React project
 */
function ensureEssentialFiles(projectRoot, userFiles) {
    const userFilePaths = new Set(userFiles.map(f => f.path.replace(/^\//, '')));

    // Repair corrupt JSON config files that would crash Vite
    const jsonConfigs = ['tsconfig.json', 'tsconfig.node.json', 'package.json', 'components.json'];
    const JSON_SCAFFOLD = {
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                target: 'ES2020', useDefineForClassFields: true,
                lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
                skipLibCheck: true, moduleResolution: 'bundler',
                allowImportingTsExtensions: true, resolveJsonModule: true,
                isolatedModules: true, noEmit: true, jsx: 'react-jsx',
                strict: true, noUnusedLocals: false, noUnusedParameters: false,
                noFallthroughCasesInSwitch: true, baseUrl: '.', paths: { '@/*': ['./src/*'] },
            },
            include: ['src'], references: [],
        }, null, 2),
        'tsconfig.node.json': JSON.stringify({
            compilerOptions: {
                composite: true, skipLibCheck: true, module: 'ESNext',
                moduleResolution: 'bundler', allowSyntheticDefaultImports: true,
                strict: true, noEmit: true,
            },
            include: ['vite.config.ts'],
        }, null, 2),
    };
    for (const configFile of jsonConfigs) {
        const configPath = path.join(projectRoot, configFile);
        if (fs.existsSync(configPath)) {
            try {
                JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch {
                const fallback = JSON_SCAFFOLD[configFile];
                if (fallback) {
                    fs.writeFileSync(configPath, fallback);
                    console.warn(`[${path.basename(projectRoot)}] Repaired corrupt ${configFile} with scaffold default`);
                }
            }
        }
    }

    // Linux is case-sensitive: generated projects sometimes create src/app.tsx while
    // main.tsx imports ./App. Create a tiny bridge to avoid boot failures.
    const appPascalTsx = path.join(projectRoot, 'src', 'App.tsx');
    const appPascalJsx = path.join(projectRoot, 'src', 'App.jsx');
    const appLowerTsx = path.join(projectRoot, 'src', 'app.tsx');
    const appLowerJsx = path.join(projectRoot, 'src', 'app.jsx');

    if (!fs.existsSync(appPascalTsx) && !fs.existsSync(appPascalJsx)) {
        if (fs.existsSync(appLowerTsx)) {
            fs.writeFileSync(appPascalTsx, `export { default } from './app';\n`);
            console.log(`[${path.basename(projectRoot)}] Created App.tsx bridge to ./app`);
        } else if (fs.existsSync(appLowerJsx)) {
            fs.writeFileSync(appPascalJsx, `export { default } from './app';\n`);
            console.log(`[${path.basename(projectRoot)}] Created App.jsx bridge to ./app`);
        }
    }
    
    // Check if user provided an index.css
    if (!userFilePaths.has('src/index.css')) {
        const indexCssPath = path.join(projectRoot, 'src', 'index.css');
        if (!fs.existsSync(indexCssPath)) {
            fs.writeFileSync(indexCssPath, TAILWIND_CSS_BASE);
            console.log(`[${path.basename(projectRoot)}] Created default index.css`);
        } else {
            // Repair existing index.css if @tailwind directives are missing
            const existing = fs.readFileSync(indexCssPath, 'utf-8');
            if (!existing.includes('@tailwind')) {
                fs.writeFileSync(indexCssPath, TAILWIND_CSS_BASE + existing);
                console.log(`[${path.basename(projectRoot)}] Repaired index.css (added @tailwind)`);
            }
        }
    }

    // Check if user provided App.tsx
    if (!userFilePaths.has('src/App.tsx') && !userFilePaths.has('src/App.jsx')) {
        // If no App provided, check if there's an alternative entry
        const hasIndex = userFilePaths.has('src/index.tsx') || userFilePaths.has('index.tsx');
        if (!hasIndex) {
            const appPath = path.join(projectRoot, 'src', 'App.tsx');
            if (!fs.existsSync(appPath)) {
                fs.writeFileSync(appPath, `function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center p-8">
        <h1 className="text-2xl font-bold text-gray-900">Preview Ready</h1>
        <p className="text-gray-600 mt-2">Your app files have been loaded.</p>
      </div>
    </div>
  );
}

export default App;
`);
                console.log(`[${path.basename(projectRoot)}] Created default App.tsx`);
            }
        }
    }

        // If generated files import the shadcn dialog primitive but omit the file,
        // provide a minimal compatible fallback so preview builds don't fail.
        const importsDialog = userFiles.some((f) =>
                typeof f.content === 'string' && /@\/components\/ui\/dialog/.test(f.content)
        );
        if (importsDialog) {
                const dialogPath = path.join(projectRoot, 'src', 'components', 'ui', 'dialog.tsx');
                if (!fs.existsSync(dialogPath)) {
                        const dialogDir = path.dirname(dialogPath);
                        if (!fs.existsSync(dialogDir)) fs.mkdirSync(dialogDir, { recursive: true });
                        fs.writeFileSync(dialogPath, `import * as React from 'react';

type DialogContextValue = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
};

const DialogContext = React.createContext<DialogContextValue>({ open: true });

interface DialogProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
}

function Dialog({ open = true, onOpenChange, children }: DialogProps) {
    return <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>;
}

function DialogContent({ className = '', children }: { className?: string; children: React.ReactNode }) {
    const { open } = React.useContext(DialogContext);
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className={\`w-full max-w-lg rounded-lg bg-background p-6 shadow-xl \${className}\`.trim()}>{children}</div>
        </div>
    );
}

function DialogHeader({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return <div className={\`mb-4 space-y-1 \${className}\`.trim()}>{children}</div>;
}

function DialogTitle({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return <h2 className={\`text-lg font-semibold \${className}\`.trim()}>{children}</h2>;
}

function DialogDescription({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return <p className={\`text-sm text-muted-foreground \${className}\`.trim()}>{children}</p>;
}

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription };
`);
                        console.log(`[${path.basename(projectRoot)}] Created fallback src/components/ui/dialog.tsx`);
                }
        }
}

// Returns true when a project directory contains only the blank scaffold written by
// initProject() — i.e. no real user-generated files exist yet (or were pruned).
function isScaffoldOnly(projectRoot) {
    const srcDir = path.join(projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return true;
    const files = fs.readdirSync(srcDir);
    if (files.length > 3) return false;
    // initProject creates exactly: main.tsx, App.tsx, index.css
    const scaffoldNames = new Set(['main.tsx', 'App.tsx', 'index.css']);
    return files.every(f => scaffoldNames.has(f));
}

// Fetches the latest generated_files revision from Supabase and writes them to disk.
// Called before Vite starts so the browser always gets the real app, not a blank scaffold.
// Fails silently — Vite will still start with whatever files are present.
async function autoRestoreFromSupabase(projectId, projectRoot) {
    if (!SUPABASE_SERVICE_KEY) return;
    if (!isScaffoldOnly(projectRoot)) return;

    try {
        const url = `${SUPABASE_REST_URL}/rest/v1/revisions?project_id=eq.${encodeURIComponent(projectId)}&select=generated_files&order=created_at.desc&limit=1`;
        const res = await fetch(url, {
            headers: {
                apikey: SUPABASE_SERVICE_KEY,
                Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            },
        });
        if (!res.ok) {
            console.warn(`[AutoRestore] ${projectId} — Supabase returned ${res.status}`);
            return;
        }
        const rows = await res.json();
        const generatedFiles = rows[0]?.generated_files;
        // generated_files is stored as { files: [...], summary: "..." }
        const files = Array.isArray(generatedFiles)
            ? generatedFiles
            : (Array.isArray(generatedFiles?.files) ? generatedFiles.files : null);
        if (!rows.length || !files || !files.length) {
            console.warn(`[AutoRestore] ${projectId} — no revision found in Supabase`);
            return;
        }
        let written = 0;
        for (const file of files) {
            const safePath = (file.path || '').replace(/^\/+/, '');
            if (!safePath || safePath.includes('..')) continue;
            const absPath = path.join(projectRoot, safePath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            const content = file.encoding === 'base64'
                ? Buffer.from(file.content, 'base64')
                : file.content;
            fs.writeFileSync(absPath, content);
            written++;
        }
        console.log(`[AutoRestore] ${projectId} — restored ${written} files from Supabase`);
    } catch (err) {
        console.warn(`[AutoRestore] ${projectId} — failed: ${err.message}`);
    }
}

// Helper to initialize a project folder with MINIMAL structure (no pre-built templates)
function initProject(projectId) {
    const projectRoot = path.join(PROJECTS_ROOT, projectId);
    if (!fs.existsSync(projectRoot)) {
        fs.mkdirSync(projectRoot, { recursive: true });
    }

    // Create minimal index.html only if missing - will be overwritten by generated code
    const indexHtmlPath = path.join(projectRoot, 'index.html');
    if (!fs.existsSync(indexHtmlPath)) {
        fs.writeFileSync(indexHtmlPath, `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/preview/${projectId}/src/main.tsx"></script>
  </body>
</html>`);
    }

    // Create minimal main.tsx entry point only if missing
    const mainTsxPath = path.join(projectRoot, 'src', 'main.tsx');
    if (!fs.existsSync(mainTsxPath)) {
        const srcDir = path.join(projectRoot, 'src');
        if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(mainTsxPath, `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`);
    }

    // Create minimal empty App.tsx only if missing - will be overwritten
    const appTsxPath = path.join(projectRoot, 'src', 'App.tsx');
    if (!fs.existsSync(appTsxPath)) {
        fs.writeFileSync(appTsxPath, `function App() {
  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100vh', 
      fontFamily: 'system-ui',
      color: '#666'
    }}>
      <div style={{ textAlign: 'center' }}>
        <div className="spinner" style={{ 
          width: '24px', 
          height: '24px', 
          border: '3px solid #eee',
          borderTop: '3px solid #333',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          margin: '0 auto 16px'
        }}></div>
        <h2>Initializing Preview...</h2>
        <style>{\`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }\`}</style>
      </div>
    </div>
  );
}

export default App;
`);
    }





    // Create index.css with full shadcn CSS variables only if missing.
    // Use TAILWIND_CSS_BASE which uses plain CSS fallbacks — avoids @apply color-token
    // directives that fail when tailwind.config lacks the matching color keys.
    const indexCssPath = path.join(projectRoot, 'src', 'index.css');
    if (!fs.existsSync(indexCssPath)) {
        fs.writeFileSync(indexCssPath, TAILWIND_CSS_BASE);
    }

    // Create vite.config.ts with path alias only if missing
    const viteConfigPath = path.join(projectRoot, 'vite.config.ts');
    const viteConfigJsPath = path.join(projectRoot, 'vite.config.js');
    if (!fs.existsSync(viteConfigPath) && !fs.existsSync(viteConfigJsPath)) {
        fs.writeFileSync(viteConfigPath, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
`);
    }

    // Create tailwind.config.js with shadcn color extensions only if missing
    const tailwindConfigTsPath = path.join(projectRoot, 'tailwind.config.ts');
    const tailwindConfigJsPath = path.join(projectRoot, 'tailwind.config.js');
    if (!fs.existsSync(tailwindConfigTsPath) && !fs.existsSync(tailwindConfigJsPath)) {
        fs.writeFileSync(tailwindConfigJsPath, `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
`);
    }

    // Create postcss.config.js only if missing
    const postcssConfigPath = path.join(projectRoot, 'postcss.config.js');
    if (!fs.existsSync(postcssConfigPath)) {
        fs.writeFileSync(postcssConfigPath, `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`);
    }

    // Create tsconfig.json only if missing
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
        fs.writeFileSync(tsconfigPath, JSON.stringify({
            compilerOptions: {
                target: 'ES2020',
                useDefineForClassFields: true,
                lib: ['ES2020', 'DOM', 'DOM.Iterable'],
                module: 'ESNext',
                skipLibCheck: true,
                moduleResolution: 'bundler',
                allowImportingTsExtensions: true,
                resolveJsonModule: true,
                isolatedModules: true,
                noEmit: true,
                jsx: 'react-jsx',
                strict: true,
                noUnusedLocals: false,
                noUnusedParameters: false,
                noFallthroughCasesInSwitch: true,
                baseUrl: '.',
                paths: { '@/*': ['./src/*'] }
            },
            include: ['src'],
            references: []
        }, null, 2));
    }

    // Create tsconfig.node.json only if missing (required for Vite config TS parsing)
    const tsconfigNodePath = path.join(projectRoot, 'tsconfig.node.json');
    if (!fs.existsSync(tsconfigNodePath)) {
        fs.writeFileSync(tsconfigNodePath, JSON.stringify({
            compilerOptions: {
                composite: true,
                skipLibCheck: true,
                module: 'ESNext',
                moduleResolution: 'bundler',
                allowSyntheticDefaultImports: true,
                strict: true,
                noEmit: true
            },
            include: ['vite.config.ts']
        }, null, 2));
    }

    // Create package.json only if missing (needed for Vite dep pre-bundling)
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        fs.writeFileSync(packageJsonPath, JSON.stringify({
            name: 'ecomgear-project',
            private: true,
            version: '0.0.0',
            type: 'module',
            dependencies: {
                react: '^18.3.1',
                'react-dom': '^18.3.1',
                'react-router-dom': '^6.28.0',
                'lucide-react': '^0.462.0',
                'class-variance-authority': '^0.7.0',
                clsx: '^2.1.1',
                'tailwind-merge': '^2.5.4',
                'tailwindcss-animate': '^1.0.7',
                sonner: '^1.5.0',
                recharts: '^2.13.0',
                'framer-motion': '^11.11.17',
                'date-fns': '^4.1.0'
            },
            devDependencies: {
                '@vitejs/plugin-react': '^4.3.1',
                typescript: '^5.5.4',
                vite: '^5.4.0',
                tailwindcss: '^3.4.14',
                autoprefixer: '^10.4.20',
                postcss: '^8.4.47'
            }
        }, null, 2));
    }

    // Symlink node_modules from the shared system install to the project directory.
    // Using lstatSync (not existsSync) so we detect broken symlinks too.
    const projectModules = path.join(projectRoot, 'node_modules');
    const systemModules = path.join(__dirname, 'node_modules');
    try {
        let needsSymlink = true;
        try {
            const stat = fs.lstatSync(projectModules);
            if (stat.isSymbolicLink()) {
                // Already a symlink — verify it points to the right place
                const target = fs.readlinkSync(projectModules);
                needsSymlink = (target !== systemModules);
                if (needsSymlink) fs.rmSync(projectModules, { recursive: true, force: true }); // stale symlink
            } else {
                // Real directory — remove it so we can create the symlink
                fs.rmSync(projectModules, { recursive: true, force: true });
            }
        } catch {
            // lstatSync throws ENOENT — path doesn't exist, symlink needed
        }
        if (needsSymlink) {
            fs.symlinkSync(systemModules, projectModules, 'dir');
        }
    } catch (e) {
        console.error(`[${projectId}] Failed to link node_modules:`, e);
    }

    return projectRoot;
}

// Common dependencies to pre-bundle for faster builds
const COMMON_DEPS = [
    'react', 'react-dom', 'react-router-dom', 'lucide-react',
    '@radix-ui/react-accordion', '@radix-ui/react-alert-dialog', '@radix-ui/react-aspect-ratio',
    '@radix-ui/react-avatar', '@radix-ui/react-checkbox', '@radix-ui/react-collapsible',
    '@radix-ui/react-context-menu', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu',
    '@radix-ui/react-hover-card', '@radix-ui/react-label', '@radix-ui/react-menubar',
    '@radix-ui/react-navigation-menu', '@radix-ui/react-popover', '@radix-ui/react-progress',
    '@radix-ui/react-radio-group', '@radix-ui/react-scroll-area', '@radix-ui/react-select',
    '@radix-ui/react-separator', '@radix-ui/react-slider', '@radix-ui/react-slot',
    '@radix-ui/react-switch', '@radix-ui/react-tabs', '@radix-ui/react-toast',
    '@radix-ui/react-toggle', '@radix-ui/react-toggle-group', '@radix-ui/react-tooltip',
    'class-variance-authority', 'clsx', 'tailwind-merge', 'framer-motion', 'date-fns',
    'recharts', 'sonner', 'embla-carousel-react', '@tanstack/react-query', '@tanstack/react-table',
    'react-hook-form', '@hookform/resolvers', 'react-day-picker', 'cmdk', 'vaul',
    'input-otp', 'react-resizable-panels', 'axios', 'lodash', 'uuid', 'zustand', 'zod',
    '@supabase/supabase-js', 'next-themes', 'react-icons', 'react-markdown', 'react-hot-toast',
    'react-dropzone', 'swr', 'i18next', 'react-i18next', '@heroicons/react',
];

// Production cleanup settings
const MAX_INACTIVE_TIME_MS = IS_PRODUCTION ? 30 * 60 * 1000 : 60 * 60 * 1000; // 30min prod, 1hr dev
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const _envCapRaw = parseInt(process.env.MAX_ACTIVE_SERVERS);
const _envCapValid = _envCapRaw > 0;
const MAX_ACTIVE_SERVERS = (_envCapValid ? _envCapRaw : null) ?? (IS_PRODUCTION ? 20 : 50);
const _capSource =
    process.env.MAX_ACTIVE_SERVERS === undefined ? 'default (not set)' :
    _envCapValid ? 'env' : `default (env value "${process.env.MAX_ACTIVE_SERVERS}" rejected)`;
console.log(`[Preview] MAX_ACTIVE_SERVERS = ${MAX_ACTIVE_SERVERS} (${_capSource})`);

// Cleanup inactive Vite servers to free memory
async function cleanupInactiveServers() {
    const now = Date.now();
    const toRemove = [];

    for (const [projectId, instance] of activeServers.entries()) {
        if (now - instance.lastAccessed > MAX_INACTIVE_TIME_MS) {
            toRemove.push(projectId);
        }
    }

    // If we're over the limit, remove oldest servers
    if (activeServers.size > MAX_ACTIVE_SERVERS) {
        const sorted = [...activeServers.entries()]
            .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        const toRemoveCount = activeServers.size - MAX_ACTIVE_SERVERS;
        for (let i = 0; i < toRemoveCount; i++) {
            if (!toRemove.includes(sorted[i][0])) {
                toRemove.push(sorted[i][0]);
            }
        }
    }

    for (const projectId of toRemove) {
        try {
            console.log(`[Cleanup] Shutting down inactive server: ${projectId}`);
            await closeProjectServer(projectId, 'inactive cleanup');
        } catch (e) {
            console.error(`[Cleanup] Error closing server ${projectId}:`, e);
            activeServers.delete(projectId);
            closingServers.delete(projectId);
        }
    }

    if (toRemove.length > 0) {
        console.log(`[Cleanup] Removed ${toRemove.length} inactive servers. Active: ${activeServers.size}`);
    }
}

// Start cleanup interval once for this process
cleanupTimer = setInterval(() => {
    cleanupInactiveServers().catch((error) => {
        console.error('[Cleanup] Unhandled cleanup error:', error);
    });
}, CLEANUP_INTERVAL_MS);
// Get or create Vite server for a project
async function getOrCreateServer(projectId) {
    if (activeServers.has(projectId)) {
        const instance = activeServers.get(projectId);
        instance.lastAccessed = Date.now();
        return instance;
    }

    // If a creation is already in progress for this project, wait for it and reuse
    // the result rather than spawning a duplicate Vite instance (which would leak).
    if (pendingServerCreations.has(projectId)) {
        return pendingServerCreations.get(projectId);
    }

    // If a close/restart is in progress, wait up to 8 s for it to finish
    if (closingServers.has(projectId)) {
        const deadline = Date.now() + 8000;
        await new Promise((resolve) => {
            const poll = setInterval(() => {
                if (!closingServers.has(projectId) || Date.now() >= deadline) {
                    clearInterval(poll);
                    resolve();
                }
            }, 100);
        });
        // If it came back up during the wait, return it
        if (activeServers.has(projectId)) {
            const instance = activeServers.get(projectId);
            instance.lastAccessed = Date.now();
            return instance;
        }
    }

    // Proactive LRU eviction: if at capacity, close the least-recently-used server
    // before creating a new one. This prevents the cap from being exceeded between
    // periodic cleanup cycles.
    // Note: projectId is guaranteed not in activeServers here (the early-return guard above handles that case)
    if (activeServers.size >= MAX_ACTIVE_SERVERS) {
        let lruId = null;
        let lruTime = Infinity;
        for (const [id, inst] of activeServers.entries()) {
            if (inst.lastAccessed < lruTime) {
                lruTime = inst.lastAccessed;
                lruId = id;
            }
        }
        if (lruId) {
            console.log(`[Preview] LRU eviction: closing ${lruId} to make room (cap=${MAX_ACTIVE_SERVERS})`);
            try {
                await closeProjectServer(lruId, 'lru eviction');
            } catch (e) {
                console.error(`[Preview] LRU eviction failed for ${lruId}:`, e?.message || e);
                activeServers.delete(lruId);
                closingServers.delete(lruId);
            }
        }
    }

    console.log(`[Preview] Starting server for project: ${projectId} (${NODE_ENV} mode)`);

    // Register the creation promise BEFORE the async work begins so concurrent
    // callers can await it and share the single Vite instance being created.
    const creationPromise = (async () => {
    const projectRoot = initProject(projectId);
    // If the project only has blank scaffold files (e.g. after nightly cleanup pruned
    // the real files), fetch the latest revision from Supabase before Vite starts.
    await autoRestoreFromSupabase(projectId, projectRoot);
    // Backfill compatibility files for older projects so module imports like /src/App.tsx resolve.
    ensureEssentialFiles(projectRoot, []);
    const projectCacheDir = path.join(projectRoot, '.vite-cache');

    // Create a dummy HTTP server for this instance to attach HMR to
    // We won't listen() on this, but we'll manually emit 'upgrade' events to it
    const dummyServer = http.createServer();

    // Build HMR config based on environment
    const hmrConfig = {
        server: dummyServer,
    };
    
    // In production, configure HMR explicitly so the Vite client connects to the
    // nginx proxy (wss on port 443). Without explicit config, Vite auto-detects
    // location.port which is '' for default ports, producing a malformed WS URL
    // (wss://host:/path) that fails to connect, causing the browser to reload
    // on each retry — an infinite reload loop when opening the preview link.
    if (IS_PRODUCTION) {
        hmrConfig.host = HMR_HOST || 'preview.ecomgear.app';
        hmrConfig.protocol = HMR_PROTOCOL || 'wss';
        hmrConfig.clientPort = HMR_PORT || 443;
        console.log(`[Preview] HMR configured for production: ${hmrConfig.protocol}://${hmrConfig.host}:${hmrConfig.clientPort}`);
    }

    try {
        const { createViteServer, reactPluginFactory } = await getViteApi();
        const vite = await createViteServer({
            configFile: false,
            plugins: [
                reactPluginFactory(),
                // ── Transform error auto-repair plugin ────────────────────────────
                // Returns repaired code in-memory ONLY. Do NOT write to disk here —
                // any fs.writeFileSync during a transform triggers the file watcher
                // (300ms polling), which emits a 'change' event → Vite sends
                // 'page-reload' → browser reloads → requests files again → transform
                // fires again → writes again → infinite reload loop.
                {
                    name: 'ecomgear-transform-repair',
                    enforce: 'pre',
                    async transform(code, id) {
                        // Only process project source files
                        if (!id.startsWith(projectRoot) || id.includes('node_modules')) return null;
                        const ext = path.extname(id).toLowerCase();
                        if (!['.tsx', '.ts', '.jsx', '.js'].includes(ext)) return null;

                        const relPath = path.relative(projectRoot, id).replace(/\\/g, '/');
                        const { content: repaired, issues } = preprocessFile(relPath, code);
                        if (issues.length > 0) {
                            console.log(`[${projectId}] Transform-repair ${relPath}: ${issues.join(', ')}`);
                            // Return repaired code in-memory — NO disk write to avoid watcher loop
                            return { code: repaired, map: null };
                        }

                        // Quick syntax check: try esbuild transform on the code
                        try {
                            const { transformWithEsbuild } = await getViteApi();
                            await transformWithEsbuild(code, id, {
                                loader: ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : ext === '.ts' ? 'ts' : 'js',
                                jsx: 'automatic',
                                sourcemap: false,
                            });
                        } catch (transformErr) {
                            // Transform failed — attempt component-level fallback (in-memory only).
                            // IMPORTANT: always record the error in projectDiagnostics so that
                            // getProjectDiagnostics() returns healthy:false. This prevents the agent
                            // loop from treating the fallback render as a successful build and stopping
                            // prematurely. The repair loop will then read the error and fix the file.
                            const errMsg = transformErr?.message || String(transformErr);
                            const syntaxError = `Syntax error in ${relPath}: ${errMsg.split('\n')[0]}`;

                            const isMainEntry = relPath === 'src/main.tsx' || relPath === 'src/main.jsx';
                            if (isMainEntry) {
                                const appImport = (code.match(/import\s+App\s+from\s+['"]([^'"]+)['"]/) || [])[1] || './App';
                                const fallback = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from '${appImport}'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n)\n`;
                                console.warn(`[${projectId}] Auto-repaired broken ${relPath} at transform time`);
                                appendProjectError(projectId, syntaxError, 'build');
                                return { code: fallback, map: null };
                            }

                            // For component/page files, generate a safe placeholder
                            if (/^src\/(pages|components|layouts|contexts|hooks)\//.test(relPath) ||
                                relPath === 'src/App.tsx' || relPath === 'src/App.jsx') {
                                const baseName = path.basename(relPath).replace(/\.(tsx|jsx|ts|js)$/i, '');
                                const componentName = baseName.replace(/[^A-Za-z0-9_$]/g, '') || 'RecoveredComponent';
                                const fallback = `export default function ${componentName}() {\n  return null;\n}\n`;
                                console.warn(`[${projectId}] Auto-repaired broken component ${relPath} at transform time`);
                                appendProjectError(projectId, syntaxError, 'build');
                                return { code: fallback, map: null };
                            }

                            // For utility files (non-component), provide a minimal export
                            if (/\.(ts|js)$/.test(relPath) && !/\.(tsx|jsx)$/.test(relPath)) {
                                const fallback = `// Auto-recovered: original file had syntax errors\nexport {};\n`;
                                console.warn(`[${projectId}] Auto-repaired broken utility ${relPath} at transform time`);
                                appendProjectError(projectId, syntaxError, 'build');
                                return { code: fallback, map: null };
                            }
                        }

                        return null;
                    },
                },
                // Runtime error reporter: inject a small script into index.html
                // that catches window errors + unhandled rejections and POSTs them
                // back to the preview service so they appear in the /status endpoint
                // and trigger the Repair overlay (same as build errors).
                {
                    name: 'ecomgear-runtime-error-reporter',
                    transformIndexHtml() {
                        return [
                            {
                                tag: 'script',
                                attrs: { type: 'text/javascript' },
                                children: `(function(){
  var _reported = false;
  function report(msg, src, line) {
    if (_reported) return; _reported = true;
    try {
      fetch('/preview/${projectId}/runtime-error', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ message: String(msg), source: String(src||''), line: line||0 })
      });
    } catch(e) {}
  }
  window.addEventListener('error', function(e) {
    // Skip resource load errors (images, fonts, etc.): e.error is null and e.filename is empty
    if (!e.error && !e.filename) return;
    report((e.error ? e.error.message : e.message) || String(e), e.filename, e.lineno);
  }, true);
  window.addEventListener('unhandledrejection', function(e) {
    var msg = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled promise rejection';
    report(msg, '', 0);
  }, true);
})();`,
                                injectTo: 'head-prepend',
                            },
                            {
                                tag: 'script',
                                attrs: { type: 'text/javascript' },
                                children: `(function(){
  function sendNav() {
    try {
      // Apps use HashRouter — the route lives in the hash fragment, not the pathname.
      // Send only the route portion (e.g. "/post-gig") so the parent does not
      // re-embed the full /preview/{id}/ path into a URL hash, causing duplication.
      var hash = window.location.hash;
      var routePath = hash ? hash.replace(/^#/, '') : '/';
      if (!routePath || routePath === '') routePath = '/';
      window.parent.postMessage({ type: 'navigation', pathname: routePath }, '*');
    } catch(e) {}
  }
  // Patch pushState / replaceState so React Router link clicks are captured
  function patchHistory(method) {
    var original = window.history[method];
    window.history[method] = function() {
      original.apply(this, arguments);
      sendNav();
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('hashchange', sendNav);
  window.addEventListener('popstate', sendNav);
  // Send initial route after app has mounted
  setTimeout(sendNav, 300);
})();`,
                                injectTo: 'head-prepend',
                            },
                            {
                                tag: 'script',
                                attrs: { type: 'text/javascript' },
                                children: `(function(){
  var _blankReported = false;
  var _hadContent = false; // true once real content was seen
  var _reportTimer = null;

  // Walk the DOM tree up to 'depth' levels looking for an element with
  // real rendered dimensions. Returns true when visible content is found.
  function hasRealContent(el, depth) {
    if (!el || depth <= 0) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity||'1') < 0.05) return false;
    var r = el.getBoundingClientRect();
    // Element occupies at least 4x4 px of screen real estate — real content
    if (r.width > 4 && r.height > 4) return true;
    for (var i = 0; i < el.children.length; i++) {
      if (hasRealContent(el.children[i], depth - 1)) return true;
    }
    return false;
  }

  function reportBlank() {
    if (_blankReported) return;
    _blankReported = true;
    window.parent.postMessage({ type: 'PREVIEW_BLANK' }, '*');
  }

  function checkBlank() {
    if (_blankReported) return;
    try {
      var root = document.getElementById('root') || document.getElementById('app');
      var target = root || document.body;
      var isBlank = (target.children.length === 0) || !hasRealContent(target, 6);
      if (isBlank) {
        reportBlank();
      } else {
        _hadContent = true; // app has rendered at least once — resets observer guard
      }
    } catch(e) {}
  }

  function scheduleCheck(delay) {
    if (_blankReported) return;
    clearTimeout(_reportTimer);
    _reportTimer = setTimeout(checkBlank, delay);
  }

  // Initial checks: 2.5s and 6s after page load
  window.addEventListener('load', function() {
    scheduleCheck(2500);
    setTimeout(checkBlank, 6000);
  });

  // Re-check after any route change (React Router / hash nav / back-forward)
  // Delay 1.5s so the new page has time to render
  window.addEventListener('hashchange', function() { if (!_blankReported) scheduleCheck(1500); });
  window.addEventListener('popstate',   function() { if (!_blankReported) scheduleCheck(1500); });

  // Watch for the React root being emptied AFTER it previously had content.
  // This catches: HMR update failures, React crashes, route components that
  // unmount everything, and Vite's dev-server error overlay replacing the app.
  try {
    var root = document.getElementById('root') || document.getElementById('app') || document.body;
    var observer = new MutationObserver(function() {
      if (_blankReported || !_hadContent) return;
      // Debounce: give React 2s to re-render after the DOM change before flagging
      scheduleCheck(2000);
    });
    observer.observe(root, { childList: true, subtree: false });
  } catch(e) {}
})();`,
                                injectTo: 'head-prepend',
                            },
                        ];
                    },
                },
            ],
            cacheDir: projectCacheDir,
            server: {
                middlewareMode: true,
                host: '0.0.0.0',
                cors: true,
                allowOnlyFromPrivateIPs: false,
                hmr: hmrConfig,
                watch: {
                    usePolling: true,
                    interval: IS_PRODUCTION ? 300 : 100  // Slower polling in production
                }
            },
            appType: 'spa',
            root: projectRoot,
            base: `/preview/${projectId}/`,
            css: {
                postcss: {
                    plugins: [
                        require('tailwindcss')({
                            darkMode: ['class'],
                            content: [
                                path.join(projectRoot, 'index.html'),
                                path.join(projectRoot, 'src/**/*.{js,jsx,ts,tsx,html}'),
                            ],
                            theme: {
                                extend: {
                                    colors: {
                                        border: 'hsl(var(--border))',
                                        input: 'hsl(var(--input))',
                                        ring: 'hsl(var(--ring))',
                                        background: 'hsl(var(--background))',
                                        foreground: 'hsl(var(--foreground))',
                                        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
                                        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
                                        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
                                        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
                                        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
                                        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
                                        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
                                        sidebar: {
                                            DEFAULT: 'hsl(var(--sidebar-background))',
                                            foreground: 'hsl(var(--sidebar-foreground))',
                                            primary: 'hsl(var(--sidebar-primary))',
                                            'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
                                            accent: 'hsl(var(--sidebar-accent))',
                                            'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
                                            border: 'hsl(var(--sidebar-border))',
                                            ring: 'hsl(var(--sidebar-ring))',
                                        },
                                    },
                                    borderRadius: {
                                        lg: 'var(--radius)',
                                        md: 'calc(var(--radius) - 2px)',
                                        sm: 'calc(var(--radius) - 4px)',
                                    },
                                },
                            },
                            plugins: [require('tailwindcss-animate')],
                        }),
                        require('autoprefixer')(),
                    ],
                },
            },
            resolve: {
                alias: {
                    '@': path.join(projectRoot, 'src'),
                },
            },
            optimizeDeps: {
                include: COMMON_DEPS,
                // Prevent re-bundling on every request
                force: false,
            },
            // Better error handling for syntax issues
            esbuild: {
                logLevel: 'warning',
                logOverride: {
                    'this-is-undefined-in-esm': 'silent',
                },
            },
            // Custom logger to capture build errors
            customLogger: {
                info: (msg) => console.log(`[${projectId}] ${msg}`),
                warn: (msg) => console.warn(`[${projectId}] ${msg}`),
                error: (msg) => {
                    console.error(`[${projectId}] ${msg}`);
                    appendProjectError(projectId, msg, 'build');
                },
                warnOnce: (msg) => console.warn(`[${projectId}] ${msg}`),
            },
        });

        const instance = { vite, server: dummyServer, lastAccessed: Date.now() };
        activeServers.set(projectId, instance);
        return instance;
    } catch (error) {
        console.error(`[${projectId}] Failed to create Vite server:`, error);
        throw error;
    }
})();

    pendingServerCreations.set(projectId, creationPromise);
    try {
        return await creationPromise;
    } finally {
        pendingServerCreations.delete(projectId);
    }
}

// Build CORS options — restrict origins in production, allow all in development.
const ALLOWED_ORIGINS_ENV = process.env.ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = ALLOWED_ORIGINS_ENV
    ? ALLOWED_ORIGINS_ENV.split(',').map(o => o.trim()).filter(Boolean)
    : [
        'https://ecomgear.dev',
        'https://www.ecomgear.dev',
        'https://ecomgear.app',
        'https://www.ecomgear.app',
        'http://localhost:5173',
        'http://localhost:3000',
        'http://localhost:8080',
    ];

function createInlineTailwindConfig(projectRoot) {
    return require('tailwindcss')({
        darkMode: ['class'],
        content: [
            path.join(projectRoot, 'index.html'),
            path.join(projectRoot, 'src/**/*.{js,jsx,ts,tsx,html}'),
        ],
        theme: {
            extend: {
                colors: {
                    border: 'hsl(var(--border))',
                    input: 'hsl(var(--input))',
                    ring: 'hsl(var(--ring))',
                    background: 'hsl(var(--background))',
                    foreground: 'hsl(var(--foreground))',
                    primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
                    secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
                    muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
                    accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
                    destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
                    popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
                    card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
                    sidebar: {
                        DEFAULT: 'hsl(var(--sidebar-background))',
                        foreground: 'hsl(var(--sidebar-foreground))',
                        primary: 'hsl(var(--sidebar-primary))',
                        'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
                        accent: 'hsl(var(--sidebar-accent))',
                        'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
                        border: 'hsl(var(--sidebar-border))',
                        ring: 'hsl(var(--sidebar-ring))',
                    },
                },
                borderRadius: {
                    lg: 'var(--radius)',
                    md: 'calc(var(--radius) - 2px)',
                    sm: 'calc(var(--radius) - 4px)',
                },
            },
        },
        plugins: [require('tailwindcss-animate')],
    });
}

function corsOptions(req, callback) {
    const origin = req.headers.origin;
    const allowHeaders = [
        'Authorization',
        'Content-Type',
        'Accept',
        'apikey',
        'x-api-version',
        'x-operation-id',
        'x-client-info',
        'x-external-authorization',
        'x-update-secret',
    ];
    const allowMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin || IS_PRODUCTION === false) {
        return callback(null, {
            origin: true,
            methods: allowMethods,
            allowedHeaders: allowHeaders,
            optionsSuccessStatus: 204,
        });
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, {
            origin: true,
            methods: allowMethods,
            allowedHeaders: allowHeaders,
            optionsSuccessStatus: 204,
        });
    } else {
        callback(null, { origin: false });
    }
}

async function startMainServer() {
    const app = express();
    const mainServer = http.createServer(app);

    app.use(cors(corsOptions));
    app.options(/.*/, cors(corsOptions));
    app.use(bodyParser.json({ limit: '50mb' }));

    // Runtime Control API (local migration mode)
    app.post('/control/runtime/:projectId/start', cors(corsOptions), async (req, res) => {
        const { projectId } = req.params;
        try {
            await getOrCreateServer(projectId);
            const now = new Date().toISOString();
            const previewUrl = `${getPreviewPublicBaseUrl(req)}/preview/${projectId}`;
            const instance = {
                projectId,
                containerId: `local-preview-${projectId}`,
                runtimeStatus: 'running',
                previewUrl,
                hostNode: process.env.HOSTNAME || 'local-preview-service',
                startedAt: runtimeInstances.get(projectId)?.startedAt || now,
                lastActiveAt: now,
                metadata: { mode: 'local-preview-service' },
            };
            runtimeInstances.set(projectId, instance);
            res.json({ success: true, ...instance });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message || String(err), projectId });
        }
    });

    app.post('/control/runtime/:projectId/stop', cors(corsOptions), async (req, res) => {
        const { projectId } = req.params;
        const existing = runtimeInstances.get(projectId);
        if (existing) {
            existing.runtimeStatus = 'stopped';
            existing.lastActiveAt = new Date().toISOString();
            runtimeInstances.set(projectId, existing);
        }
        res.json({ success: true, projectId, runtimeStatus: 'stopped' });
    });

    app.get('/control/runtime/:projectId/status', cors(corsOptions), async (req, res) => {
        const { projectId } = req.params;
        const instance = runtimeInstances.get(projectId);
        if (!instance) {
            return res.json({
                success: true,
                projectId,
                runtimeStatus: 'stopped',
                previewUrl: `${getPreviewPublicBaseUrl(req)}/preview/${projectId}`,
            });
        }
        res.json({ success: true, ...instance });
    });

    // Service Health Check
    app.get('/health', (req, res) => {
        res.json({ 
            status: 'ok', 
            activeServers: activeServers.size,
            uptime: Math.floor(process.uptime())
        });
    });

    // Pre-installed packages list — the agent queries this to know which
    // imports are available without an npm install.
    app.get('/packages', (req, res) => {
        res.json({ packages: COMMON_DEPS });
    });

    // Catch JSON parse errors from body-parser
    app.use((err, req, res, next) => {
        if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
            console.error(`[Server] JSON Parse Error: ${err.message}`);
            return res.status(400).json({ error: 'Invalid JSON payload. Please check file contents.' });
        }
        next();
    });

    // ── Asset path rescue middleware ───────────────────────────────────────
    // When generated code uses an absolute path like `/assets/image.png`
    // instead of `${import.meta.env.BASE_URL}assets/image.png`, the browser
    // requests the asset from the domain root — bypassing the project's
    // `/preview/{projectId}/` base path and getting a 404.
    //
    // This middleware intercepts those root-level asset requests, extracts the
    // project ID from the Referer header (which always contains the preview URL),
    // and redirects to the correct project-scoped path so the file is served
    // by the right Vite instance.
    //
    // Supported asset prefixes: /assets/, /images/, /fonts/, /icons/, /media/
    // — all common names for things placed in a project's public/ directory.
    const ASSET_PATH_RE = /^\/(assets|images|fonts|icons|media)\//;
    const PREVIEW_REFERER_RE = /\/preview\/([a-f0-9-]{36})\//i;

    app.use((req, res, next) => {
        if (!ASSET_PATH_RE.test(req.url)) return next();

        // Only redirect GET/HEAD requests (not PUT/POST API calls)
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        const referer = req.headers.referer || req.headers.referrer || '';
        const match = referer.match(PREVIEW_REFERER_RE);
        if (!match) return next(); // no project context — let it 404 normally

        const projectId = match[1];
        const targetUrl = `/preview/${projectId}${req.url}`;
        console.log(`[AssetRescue] ${req.url} → ${targetUrl} (referer project: ${projectId})`);
        // Internal forward — rewrite req.url and hand off to the /preview/:projectId handler
        req.url = targetUrl;
        next();
    });

    // ── Path-based published site routing — preview.ecomgear.app/p/{slug} ──
    // Works with existing SSL cert (no wildcard needed).
    // Must be BEFORE /preview/:projectId.
    app.use('/p/:slug', async (req, res, next) => {
        const slug = (req.params.slug || '').toLowerCase().trim();
        const safeSlug = escapeHtml(slug);
        const projectId = slugRegistry.get(slug);
        if (!projectId) {
            return res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>404 – ${safeSlug} not found</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#07080a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{text-align:center;padding:40px}.sub{color:#555;margin-top:8px}a{color:#a78bfa}</style>
</head><body><div class="box">
<h1 style="font-size:2rem">404</h1>
<p><strong>${safeSlug}</strong> is not published yet.</p>
<p class="sub"><a href="https://www.ecomgear.dev">Build with ecomgear →</a></p>
</div></body></html>`);
        }
        // Always serve index.html for all sub-paths (HashRouter SPA)
        req.url = `/preview/${projectId}/`;
        console.log(`[Published] /p/${slug} → project ${projectId}`);
        try {
            const { vite } = await getOrCreateServer(projectId);
            vite.middlewares(req, res, next);
        } catch (e) {
            console.error(`[Published] Error serving ${slug}:`, e.message);
            next(e);
        }
    });

    // ── Published subdomain routing — {slug}.ecomgear.app (legacy/HTTP fallback) ──
    // Only reached when browser allows HTTP (no HSTS). Path-based /p/:slug is preferred.
    const SUBDOMAIN_RESERVED = new Set(['preview', 'api', 'www', 'gen', 'agent', 'app', 'mail', 'admin', 'help']);
    app.use(async (req, res, next) => {
        const host = (req.headers.host || '').toLowerCase().split(':')[0];
        const slugMatch = host.match(/^([a-z0-9][a-z0-9-]*[a-z0-9])\.ecomgear\.app$/);
        if (!slugMatch || SUBDOMAIN_RESERVED.has(slugMatch[1])) return next();

        const slug = slugMatch[1];
        const safeSlug = escapeHtml(slug);
        const projectId = slugRegistry.get(slug);
        if (!projectId) {
            return res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>404 – ${safeSlug}.ecomgear.app</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#07080a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{text-align:center;padding:40px}.sub{color:#555;margin-top:8px}a{color:#a78bfa}</style>
</head><body><div class="box">
<h1 style="font-size:2rem">404</h1>
<p><strong>${safeSlug}.ecomgear.app</strong> is not published yet.</p>
<p class="sub"><a href="https://www.ecomgear.dev">Build with ecomgear →</a></p>
</div></body></html>`);
        }

        // Root → rewrite to project's Vite base path so Vite serves index.html
        if (req.url === '/' || req.url === '') {
            req.url = `/preview/${projectId}/`;
        }
        console.log(`[Subdomain] ${host} → project ${projectId} | ${req.url}`);
        try {
            const { vite } = await getOrCreateServer(projectId);
            vite.middlewares(req, res, next);
        } catch (e) {
            console.error(`[Subdomain] Error serving ${slug}:`, e.message);
            next(e);
        }
    });

    // ── Check subdomain availability ──────────────────────────────────────
    app.get('/check-subdomain/:slug', (req, res) => {
        const slug = (req.params.slug || '').toLowerCase().trim();
        const requestingProjectId = (req.query.projectId || '').toString().trim();
        if (SUBDOMAIN_RESERVED.has(slug) || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
            return res.json({ available: false, reason: 'Slug is reserved or invalid' });
        }
        const ownedBy = slugRegistry.get(slug);
        // If the slug is already registered to this project, it's available (re-publish)
        if (ownedBy && requestingProjectId && ownedBy === requestingProjectId) {
            return res.json({ available: true });
        }
        const taken = ownedBy !== undefined;
        res.json({ available: !taken, reason: taken ? 'Slug already taken' : undefined });
    });

    // ── Publish project to a slug ─────────────────────────────────────────
    app.options('/publish/:projectId', cors(corsOptions));
    app.post('/publish/:projectId', async (req, res) => {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        const { slug, files } = req.body || {};
        if (!slug || !Array.isArray(files) || !files.length) {
            return res.status(400).json({ error: 'slug and files[] are required' });
        }
        const normalizedSlug = slug.toLowerCase().trim();
        const existing = slugRegistry.get(normalizedSlug);
        if (existing && existing !== projectId) {
            return res.status(409).json({ error: `"${normalizedSlug}" is already taken by another project` });
        }
        console.log(`[Publish] ${projectId} → ${normalizedSlug}.ecomgear.app (${files.length} files)`);
        // Write files to disk (same paths the preview Vite server uses)
        const projectRoot = initProject(projectId);
        const materialized = await materializeProjectFiles(projectId, projectRoot, files);
        if (materialized.validationErrors.length > 0) {
            setProjectErrors(projectId, materialized.validationErrors.map((error) => error.summary), 'validation');
            return res.status(422).json({
                success: false,
                autoFixes: materialized.allFixedIssues.length > 0 ? materialized.allFixedIssues : undefined,
                ...buildValidationResponse(materialized.validationErrors),
            });
        }

        // Register slug and persist (also write per-project .slug file for recovery)
        slugRegistry.set(normalizedSlug, projectId);
        saveSlugRegistry(slugRegistry);
        try { fs.writeFileSync(path.join(projectRoot, '.slug'), normalizedSlug); } catch (_) {}
        // Warm the Vite server so first visitor is fast
        getOrCreateServer(projectId).catch(() => {});
        setProjectErrors(projectId, []);
        res.json({
            success: true,
            slug: normalizedSlug,
            publishedUrl: `https://preview.ecomgear.app/p/${normalizedSlug}`,
            autoFixes: materialized.allFixedIssues.length > 0 ? materialized.allFixedIssues : undefined,
        });
    });

    // ── Unpublish a slug ──────────────────────────────────────────────────
    app.options('/publish/:slug', cors(corsOptions));
    app.delete('/publish/:slug', (req, res) => {
        const slug = req.params.slug.toLowerCase();
        if (!slugRegistry.has(slug)) return res.status(404).json({ error: 'Slug not found' });
        slugRegistry.delete(slug);
        saveSlugRegistry(slugRegistry);
        res.json({ success: true });
    });

    // ── Export built project for production hosting (VPS4) ────────────────
    // Runs vite build on the project and returns the compiled dist/ files.
    // The frontend calls this before deploying to the hosting service.
    const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif',
        '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.webm', '.ogg', '.pdf']);
    app.options('/preview/:projectId/export', cors(corsOptions));
    app.post('/preview/:projectId/export', async (req, res) => {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        const projectRoot = path.join(PROJECTS_ROOT, projectId);
        if (!fs.existsSync(projectRoot) || !fs.existsSync(path.join(projectRoot, 'src', 'main.tsx'))) {
            return res.status(404).json({ error: 'Project not found or not initialized' });
        }
        const buildDir = path.join(projectRoot, '.export-dist');
        try {
            // Rewrite index.html to use root-relative script path for production build
            const indexHtmlPath = path.join(projectRoot, 'index.html');
            const originalHtml = fs.readFileSync(indexHtmlPath, 'utf-8');
            const prodHtml = originalHtml.replace(
                /src="\/preview\/[^"]+\/src\/main\.tsx"/,
                'src="/src/main.tsx"'
            );
            fs.writeFileSync(indexHtmlPath, prodHtml);
            try {
                const { viteBuild, reactPluginFactory } = await getViteApi();
                await viteBuild({
                    configFile: false,
                    root: projectRoot,
                    base: '/',
                    plugins: [reactPluginFactory()],
                    build: {
                        outDir: buildDir,
                        emptyOutDir: true,
                        sourcemap: false,
                        minify: 'esbuild',
                    },
                    css: {
                        postcss: {
                            plugins: [
                                createInlineTailwindConfig(projectRoot),
                                require('autoprefixer')(),
                            ],
                        },
                    },
                    resolve: {
                        alias: { '@': path.join(projectRoot, 'src') },
                    },
                    logLevel: 'warn',
                });
            } finally {
                // Always restore original index.html
                fs.writeFileSync(indexHtmlPath, originalHtml);
            }
            // Read all built files from the dist directory
            const files = [];
            function readBuildDir(dir, prefix) {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        readBuildDir(fullPath, relPath);
                    } else {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (BINARY_EXTS.has(ext)) {
                            files.push({ path: relPath, content: fs.readFileSync(fullPath, 'base64'), encoding: 'base64' });
                        } else {
                            files.push({ path: relPath, content: fs.readFileSync(fullPath, 'utf-8') });
                        }
                    }
                }
            }
            readBuildDir(buildDir, '');
            fs.rmSync(buildDir, { recursive: true, force: true });
            console.log(`[Export] ${projectId} — ${files.length} built files`);
            res.json({ success: true, files });
        } catch (e) {
            if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
            console.error(`[Export] ${projectId} build failed:`, e.message);
            res.status(500).json({ error: 'Build failed', detail: e.message });
        }
    });

    // File Update API: POST /preview/:projectId/update
    // Explicitly handle OPTIONS for this route to prevent fall-through to Vite middleware
    app.options('/preview/:projectId/update', cors(corsOptions));
    app.post('/preview/:projectId/update', async (req, res) => {
        // ── Auth: shared secret (server-to-server and trusted clients) ───────
        if (PREVIEW_UPDATE_SECRET) {
            const provided = req.headers['x-update-secret'];
            if (!provided || provided !== PREVIEW_UPDATE_SECRET) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }

        // ── Rate limit by IP ─────────────────────────────────────────────────
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (isUpdateRateLimited(clientIp)) {
            return res.status(429).json({ error: 'Too many update requests — slow down' });
        }

        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        const { files, fullSync = false } = req.body;
        touchRuntime(projectId);

        if (!files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Invalid files format' });
        }

        const now = Date.now();
        const fingerprint = createUpdateFingerprint(files, fullSync);
        const recentFingerprint = recentUpdateFingerprints.get(projectId);
        if (
            recentFingerprint &&
            recentFingerprint.hash === fingerprint &&
            now - recentFingerprint.timestamp < UPDATE_DEDUPE_WINDOW_MS
        ) {
            console.log(`[${projectId}] Skipping duplicate update payload (${files.length} files)`);
            return res.json({
                success: true,
                deduped: true,
                filesProcessed: files.length,
                staleFilesPruned: 0,
            });
        }

        recentUpdateFingerprints.set(projectId, {
            hash: fingerprint,
            timestamp: now,
        });

        console.log(`[${projectId}] Updating ${files.length} files...`);
        const projectRoot = initProject(projectId);
        const requiresServerRestart = shouldRestartViteForUpdate(files, projectRoot);

        // ── Cross-file import check (non-blocking warning) ────────────
        // Log unresolved imports as warnings but don't reject the update.
        // Vite dev mode will surface these at runtime through HMR overlays.
        const importErrors = checkCrossFileImports(projectRoot, files, fullSync);
        if (importErrors.length > 0) {
            const uniqueImportErrors = importErrors.slice(0, 10);
            console.warn(`[${projectId}] Import warnings: ${importErrors.length} unresolved import(s) — letting Vite HMR handle`);
            // Store as warnings so /status can report them, but don't block
            setProjectErrors(projectId, uniqueImportErrors.map((e) => e.summary), 'warning');
        }

        // ── Stable Architecture: Snapshot before write ────────────────────
        const hasSnapshot = snapshotProjectSrc(projectRoot);

        try {
            const materialized = await materializeProjectFiles(projectId, projectRoot, files);
            const { userFilePaths, allFixedIssues, validationErrors } = materialized;

            if (validationErrors.length > 0) {
                // Non-blocking: surface as warnings, let Vite HMR show them in browser.
                setProjectErrors(projectId, validationErrors.map((error) => error.summary), 'warning');
            }

            // Clean up default template files that might conflict with user's app
            const hasUserApp = userFilePaths.has('src/App.tsx') || userFilePaths.has('src/App.jsx') ||
                userFilePaths.has('App.tsx') || userFilePaths.has('App.jsx');
            const hasUserMain = userFilePaths.has('src/main.tsx') || userFilePaths.has('src/main.jsx') ||
                userFilePaths.has('src/index.tsx') || userFilePaths.has('src/index.jsx');
            const hasUserIndex = userFilePaths.has('index.html');

            const defaultAppPath = path.join(projectRoot, 'src', 'App.tsx');
            if (!hasUserApp && fs.existsSync(defaultAppPath)) {
                const content = fs.readFileSync(defaultAppPath, 'utf-8');
                if (content.includes('Loading') || content.includes('Waiting') || content.includes('placeholder')) {
                    console.log(`[${projectId}] Removing placeholder App.tsx`);
                    fs.writeFileSync(defaultAppPath, `
function App() {
  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui' }}>
      <h1>App Generated</h1>
      <p>Your application files have been loaded. Check the console for any errors.</p>
    </div>
  );
}

export default App;
`);
                }
            }

            ensureEssentialFiles(projectRoot, files);

            let removedStaleFiles = [];
            if (fullSync) {
                removedStaleFiles = pruneProjectFiles(projectRoot, userFilePaths);
                if (removedStaleFiles.length > 0) {
                    console.log(`[${projectId}] Pruned ${removedStaleFiles.length} stale file(s)`);
                }
            }

            if (requiresServerRestart) {
                const projectCacheDir = path.join(projectRoot, '.vite-cache');
                if (fs.existsSync(projectCacheDir)) {
                    fs.rmSync(projectCacheDir, { recursive: true, force: true });
                }
                await restartProjectServer(projectId, 'dependency/config update');
            }

            // Ensure server exists/restarts if config changed
            const { vite: viteInstance } = await getOrCreateServer(projectId);

            // ── Warmup: force dep optimization to finish before client loads ──
            // Vite doesn't pre-bundle deps until the first module request arrives.
            // Without warming up, the browser loads the preview URL and waits
            // 60-120 seconds while Vite optimizes deps — showing a blank page.
            //
            // Strategy: call vite.transformRequest() on the entry points directly.
            // This is the Vite-internal API that triggers dep discovery + bundling
            // and actually WAITS for optimization to complete (unlike a fake HTTP
            // request that only triggers the scan asynchronously).
            try {
                const entryPoints = ['src/main.tsx', 'src/main.jsx', 'src/index.tsx'].filter((ep) => {
                    return fs.existsSync(path.join(projectRoot, ep));
                });
                const entryToWarm = entryPoints[0] || 'src/main.tsx';

                // transformRequest with a 30s timeout — enough for large dep trees
                await Promise.race([
                    viteInstance.transformRequest(`/${entryToWarm}`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), 30000)),
                ]);
                console.log(`[${projectId}] Warmup complete — Vite deps pre-bundled via transformRequest`);
            } catch (warmupErr) {
                // Non-blocking: warmup failure does not prevent the update from succeeding.
                // The browser may still get a short blank (Vite will finish optimization
                // on first real request) but this is rare and resolves within seconds.
                console.warn(`[${projectId}] Warmup failed (non-blocking):`, warmupErr?.message);
            }

            // ── Post-write build check ─────────────────────────────────
            // Run syntax check on all source files. Report errors as 'build'
            // so getProjectDiagnostics() returns healthy:false — this ensures
            // the agent loop sees the failure and retries instead of stopping.
            const buildCheck = await quickViteBuildCheck(projectId, projectRoot);
            if (!buildCheck.ok) {
                console.warn(`[${projectId}] Syntax errors: ${buildCheck.errors.length} issue(s) — agent will repair`);
                setProjectErrors(projectId, buildCheck.errors.map((e) => e.summary), 'build');
            } else {
                // Clear previous errors if all files are now clean
                setProjectErrors(projectId, []);
            }
            cleanupSnapshot(projectRoot);

            // Return success — files are promoted to live preview
            res.json({ 
                success: true,
                promoted: true,
                filesProcessed: files.length,
                staleFilesPruned: removedStaleFiles.length,
                autoFixes: allFixedIssues.length > 0 ? allFixedIssues : undefined
            });
        } catch (err) {
            // Rollback on any unexpected error
            if (hasSnapshot) {
                rollbackProjectSrc(projectRoot);
                console.log(`[${projectId}] Rolled back after error: ${err.message}`);
            }
            recentUpdateFingerprints.delete(projectId);
            console.error(`[${projectId}] Update failed:`, err);
            res.status(500).json({ error: err.message });
        }
    });

    // Preview Status API: GET /preview/:projectId/status
    app.get('/preview/:projectId/status', cors(corsOptions), (req, res) => {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        touchRuntime(projectId);
        res.json(getProjectDiagnostics(projectId));
    });

    // Runtime Error Report: POST /preview/:projectId/runtime-error
    // Receives uncaught errors from inside the preview iframe and funnels them
    // into projectErrors so the Repair overlay lights up automatically.
    app.options('/preview/:projectId/runtime-error', cors(corsOptions));
    app.post('/preview/:projectId/runtime-error', cors(corsOptions), (req, res) => {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
        const { message, source, line } = req.body || {};
        if (!message) return res.status(400).json({ error: 'message required' });
        const srcInfo = source ? ` (${String(source).split('/').pop()}:${line || '?'})` : '';
        const formatted = `Runtime error${srcInfo}: ${String(message).slice(0, 500)}`;
        appendProjectError(projectId, formatted, 'runtime');
        res.json({ ok: true });
    });

        app.get('/preview/:projectId/error-overlay', cors(corsOptions), (req, res) => {
                const { projectId } = req.params;
                if (!isValidProjectId(projectId)) {
                    return res.status(400).json({ error: 'Invalid project ID' });
                }
                const { errors, diagnosticKind } = getProjectDiagnostics(projectId);
                if (errors.length === 0) {
                        return res.status(404).type('html').send('<!doctype html><title>No preview errors</title><body style="font-family:system-ui;padding:24px">No preview errors recorded.</body>');
                }

                const items = errors.map((error) => `<li style="margin:0 0 12px;white-space:pre-wrap">${escapeHtml(error)}</li>`).join('');
                res.type('html').send(`<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Preview Error</title>
        <style>
            body{margin:0;background:#08111f;color:#f8fafc;font-family:Inter,system-ui,sans-serif}
            main{max-width:960px;margin:0 auto;padding:32px 20px 48px}
            .panel{border:1px solid rgba(255,255,255,.1);background:rgba(10,18,32,.94);border-radius:24px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
            h1{margin:0 0 8px;font-size:28px}
            p{margin:0 0 20px;color:#94a3b8;line-height:1.6}
            ol{padding-left:20px;margin:0}
            code{display:block;padding:14px 16px;border-radius:16px;background:rgba(255,255,255,.04);color:#cbd5e1;overflow:auto}
        </style>
    </head>
    <body>
        <main>
            <div class="panel">
                <h1>Preview build failed</h1>
                <p>The preview is unhealthy (${escapeHtml(diagnosticKind)}). The last known-good preview may still be visible until the next successful update.</p>
                <ol>${items}</ol>
            </div>
        </main>
    </body>
</html>`);
        });

    // Request Routing Middleware
    app.use('/preview/:projectId', async (req, res, next) => {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        console.log(`[${projectId}] Request: ${req.method} ${req.url} (Original: ${req.originalUrl})`);

        try {
            const { vite } = await getOrCreateServer(projectId);
            // Mounted route already strips `/preview/:projectId` from req.url.
            // Keep that value for Vite, otherwise source-module requests can fall
            // through to SPA HTML and trigger corrupted-content MIME errors.
            const url = req.originalUrl || `/preview/${projectId}${req.url}`;
            const mountedPrefix = `/preview/${projectId}`;

            // Defensive normalization: ensure Vite receives project-relative paths.
            // If a full mounted path leaks through here, Vite may return index.html
            // for module URLs (e.g. /src/main.tsx), causing browser module load failures.
            if (req.url === mountedPrefix) {
                req.url = '/';
            } else if (req.url.startsWith(`${mountedPrefix}/`)) {
                req.url = req.url.slice(mountedPrefix.length);
            }

            // Intercept response to fix MIME types for JS/TS files
            // NOTE: Do NOT override CSS - Vite transforms CSS imports to JS modules
            const originalSetHeader = res.setHeader.bind(res);
            res.setHeader = function (name, value) {
                // Fix Content-Type for JavaScript modules that Vite might serve incorrectly
                if (name.toLowerCase() === 'content-type') {
                    // Vite internal routes - always JavaScript
                    if (url.includes('/@vite/') || url.includes('/@fs/') || url.includes('/@id/')) {
                        // Force JS for any file served via @fs (which includes node_modules symlinks)
                        if (!url.endsWith('.css')) {
                            value = 'application/javascript; charset=utf-8';
                        }
                    }
                    // .vite/deps chunks are always JS
                    else if (url.includes('.vite/deps/')) {
                        value = 'application/javascript; charset=utf-8';
                    }
                    // DO NOT override CSS - Vite transforms CSS imports to JS when imported in modules
                }
                return originalSetHeader(name, value);
            };

            // Also intercept writeHead to ensure MIME type on error responses (504 Outdated Request)
            const originalWriteHead = res.writeHead.bind(res);
            res.writeHead = function (statusCode, ...args) {
                const isJsRequest = url.includes('/@vite/') ||
                    url.includes('/@fs/') ||
                    url.includes('/@id/') ||
                    url.includes('.vite/deps/') ||
                    /\.(tsx?|jsx?|mjs|es|js)(\?|$)/.test(url);

                // If no content-type was set for a JS module request, provide a safe default.
                if (isJsRequest && !res.getHeader('Content-Type')) {
                    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                }

                // For 504 (Outdated Request during server restart); ensure MIME type is set
                if (statusCode === 504) {
                    if (isJsRequest) {
                        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                    }
                }
                return originalWriteHead(statusCode, ...args);
            };

            // Intercept end() to provide graceful fallback for 504 errors
            const originalEnd = res.end.bind(res);
            res.end = function (chunk, ...args) {
                // If it's a 504 with empty body, provide a no-op script for JS requests
                // instead of location.reload() which causes infinite reload cascades
                if (res.statusCode === 504 && !chunk) {
                    const isJsRequest = url.includes('/@vite/') ||
                        url.includes('/@fs/') ||
                        url.includes('/@id/') ||
                        url.includes('.vite/deps/') ||
                        url.match(/\.(tsx?|jsx?|mjs|es)(\?|$)/);
                    if (isJsRequest) {
                        // Export an empty module so the import chain doesn't break.
                        // Vite HMR will push a full-reload event once the server
                        // is back and the module graph has been invalidated, so
                        // there is no need to trigger location.reload() from here.
                        chunk = `// Vite server restarting — module temporarily unavailable\nexport default undefined;`;
                    }
                }
                return originalEnd(chunk, ...args);
            };

            vite.middlewares(req, res, next);
        } catch (e) {
            console.error(`[${projectId}] Error handling request:`, e);
            next(e);
        }
    });

    // HMR Upgrade Handling
    mainServer.on('upgrade', async (req, socket, head) => {
        // Parse URL: /preview/:projectId/...
        const match = req.url.match(/^\/preview\/([^/]+)\//);
        if (match) {
            const projectId = match[1];
            try {
                const { server: dummyServer } = await getOrCreateServer(projectId);
                // Emit upgrade on the specific project's dummy server
                // Vite's WebSocket server is listening on this dummy server
                dummyServer.emit('upgrade', req, socket, head);
                return;
            } catch (e) {
                console.error(`[HMR] Failed to route upgrade for ${projectId}:`, e);
            }
        }

        socket.destroy();
    });

    mainServer.listen(PORT, '0.0.0.0', () => {
        console.log(`Multi-Tenant Preview Service listening at http://0.0.0.0:${PORT} (${NODE_ENV})`);
        if (IS_PRODUCTION) {
            console.log(`HMR WebSocket: ${HMR_PROTOCOL || 'ws'}://${HMR_HOST || 'auto'}:${HMR_PORT || PORT}`);
        }

        // Signal PM2 that this process is ready to accept traffic.
        // Prevents PM2 from killing the old process before this one is listening.
        if (typeof process.send === 'function') process.send('ready');

        // Re-warm projects that were active before the last restart/deploy.
        // Runs in the background so it doesn't delay the ready signal.
        setImmediate(async () => {
            const warmupIds = loadWarmupList();
            if (warmupIds.length === 0) return;
            console.log(`[Warmup] Restoring ${warmupIds.length} project(s) from previous session...`);
            let restored = 0;
            for (const projectId of warmupIds) {
                const projectDir = path.join(PROJECTS_ROOT, projectId);
                if (!fs.existsSync(projectDir)) continue;
                try {
                    // getOrCreateServer is defined later in the file; use a lazy require-style
                    // dynamic access so this top-level code compiles without a forward reference.
                    await getOrCreateServer(projectId);
                    restored++;
                    console.log(`[Warmup] Restored ${projectId} (${restored}/${warmupIds.length})`);
                } catch (e) {
                    console.warn(`[Warmup] Could not restore ${projectId}:`, e.message);
                }
            }
            console.log(`[Warmup] Done — ${restored}/${warmupIds.length} projects restored`);
            // Clean up the warmup list now that we've processed it
            try { fs.unlinkSync(WARMUP_LIST_FILE); } catch (e) { /* ignore */ }
        });
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
        console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);

        if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }

        // Persist active project IDs so the next process can restore them.
        // Must happen BEFORE closing servers so the list is still populated.
        saveWarmupList();
        console.log(`[Shutdown] Saved warmup list (${activeServers.size} project(s))`);
        
        // Close all Vite servers
        for (const [projectId] of activeServers.entries()) {
            try {
                console.log(`[Shutdown] Closing server for ${projectId}`);
                await closeProjectServer(projectId, 'shutdown');
            } catch (e) {
                console.error(`[Shutdown] Error closing ${projectId}:`, e);
            }
        }
        activeServers.clear();
        
        // Close main server
        mainServer.close(() => {
            console.log('[Shutdown] Server closed');
            process.exit(0);
        });
        
        // Force exit after 10 seconds
        setTimeout(() => {
            console.log('[Shutdown] Forcing exit');
            process.exit(1);
        }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

startMainServer();

process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled promise rejection in preview-service:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[Process] Uncaught exception in preview-service:', error);
});
