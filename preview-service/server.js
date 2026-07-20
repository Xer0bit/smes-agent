const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const { getViteApi } = require('./lib/viteApi');
const previewState = require('./lib/previewState');
const {
    activeServers, projectErrors, projectDiagnostics, runtimeInstances,
    pendingServerCreations, closingServers, recentUpdateFingerprints,
    isUpdateRateLimited, createUpdateFingerprint, getPreviewPublicBaseUrl,
    touchRuntime, escapeHtml, isValidProjectId, getProjectDiagnostics,
    setProjectErrors, appendProjectError,
} = previewState;
const {
    validateSourceFile, buildValidationResponse, checkCrossFileImports,
    quickViteBuildCheck,
} = require('./lib/validation');
const {
    TAILWIND_CSS_BASE, preprocessFile, ensureEssentialFiles, isScaffoldOnly,
    materializeProjectFiles, pruneProjectFiles,
} = require('./lib/materialize');
const { snapshotProjectSrc, rollbackProjectSrc, cleanupSnapshot } = require('./lib/snapshot');

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


const PROJECTS_ROOT = path.resolve(__dirname, 'projects');

// Ensure projects root exists
if (!fs.existsSync(PROJECTS_ROOT)) {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

// ── Slug registry   maps published slug → projectId ───────────────────────────
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

// ── Warmup list   persists active project IDs across restarts ────────────────
// Written on graceful shutdown so a new process can restore all Vite servers
// that were running, eliminating user-visible "ecosystem reset" after deploys.
const WARMUP_LIST_FILE = path.join(PROJECTS_ROOT, '.warmup-list.json');

function loadWarmupList() {
    try {
        if (fs.existsSync(WARMUP_LIST_FILE))
            return JSON.parse(fs.readFileSync(WARMUP_LIST_FILE, 'utf-8'));
    } catch (e) { /* corrupt file   ignore */ }
    return [];
}

function saveWarmupList() {
    try {
        const ids = [...activeServers.keys()];
        fs.writeFileSync(WARMUP_LIST_FILE, JSON.stringify(ids));
    } catch (e) { console.warn('[Warmup] Failed to save warmup list:', e.message); }
}


const UPDATE_DEDUPE_WINDOW_MS = 8000;


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
        // Only restart if the file content actually changed   normalizeProjectFiles
        // always includes config files with default content, so checking by name alone
        // causes unnecessary cache-busting restarts on every update.
        if (projectRoot) {
            const diskPath = path.join(projectRoot, safePath);
            try {
                const diskContent = fs.readFileSync(diskPath, 'utf-8');
                const incoming = typeof file?.content === 'string' ? file.content : '';
                return diskContent !== incoming;
            } catch {
                // File doesn't exist on disk yet   this IS a real config change
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


// Checks the DB-backed `agent_locks` table before accepting a file push. This
// closes a race that used to be invisible here entirely: a running agent loop
// (on VPS3) and any other direct push to this endpoint (a manual fix, a
// second run, a rollback) would both land on the SAME project directory with
// zero coordination   whichever wrote last silently won, moments after the
// other. The agent loop sends its lock token as `x-agent-lock-token`; a push
// is only rejected if a lock is currently held by someone else (no token, or
// a mismatched one). No lock held at all → always allowed, so direct/manual
// pushes work exactly as before when nothing is running.
const AGENT_LOCK_STALE_MS = 15 * 60_000;
async function checkAgentLock(projectId, providedToken) {
    if (!SUPABASE_SERVICE_KEY) return { ok: true }; // fail open   locking unavailable, don't block all pushes
    try {
        const url = `${SUPABASE_REST_URL}/rest/v1/agent_locks?project_id=eq.${encodeURIComponent(projectId)}&select=token,acquired_at`;
        const res = await fetch(url, {
            headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
        if (!res.ok) return { ok: true }; // fail open on lock-service errors
        const rows = await res.json();
        const lock = rows[0];
        if (!lock) return { ok: true }; // nothing running for this project
        const age = Date.now() - new Date(lock.acquired_at).getTime();
        if (age > AGENT_LOCK_STALE_MS) return { ok: true }; // stale   treat as released
        if (lock.token === providedToken) return { ok: true }; // this push IS the lock holder
        return { ok: false };
    } catch {
        return { ok: true }; // fail open   never let lock-check errors block pushes
    }
}

// Fetches the latest generated_files revision from Supabase and writes them to disk.
// Called before Vite starts so the browser always gets the real app, not a blank scaffold.
// Fails silently   Vite will still start with whatever files are present.
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
            console.warn(`[AutoRestore] ${projectId}   Supabase returned ${res.status}`);
            return;
        }
        const rows = await res.json();
        const generatedFiles = rows[0]?.generated_files;
        // generated_files is stored as { files: [...], summary: "..." }
        const files = Array.isArray(generatedFiles)
            ? generatedFiles
            : (Array.isArray(generatedFiles?.files) ? generatedFiles.files : null);
        if (!rows.length || !files || !files.length) {
            console.warn(`[AutoRestore] ${projectId}   no revision found in Supabase`);
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
        console.log(`[AutoRestore] ${projectId}   restored ${written} files from Supabase`);
    } catch (err) {
        console.warn(`[AutoRestore] ${projectId}   failed: ${err.message}`);
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
    // Use TAILWIND_CSS_BASE which uses plain CSS fallbacks   avoids @apply color-token
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
                // Already a symlink   verify it points to the right place
                const target = fs.readlinkSync(projectModules);
                needsSymlink = (target !== systemModules);
                if (needsSymlink) fs.rmSync(projectModules, { recursive: true, force: true }); // stale symlink
            } else {
                // Real directory   remove it so we can create the symlink
                fs.rmSync(projectModules, { recursive: true, force: true });
            }
        } catch {
            // lstatSync throws ENOENT   path doesn't exist, symlink needed
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
previewState.cleanupTimer = setInterval(() => {
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
    // on each retry   an infinite reload loop when opening the preview link.
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
                // ── Block __edge_functions__/ from ever being served ──────────────
                // server.fs.deny does NOT reliably block requests here (verified  
                // Vite's dev middleware still transformed and served the file even
                // with fs.deny set). configureServer runs as real middleware inside
                // Vite's own stack, so it applies regardless of which of the 3
                // vite.middlewares(...) call sites in this file handled the request.
                {
                    name: 'ecomgear-block-edge-functions',
                    configureServer(server) {
                        server.middlewares.use((req, res, next) => {
                            if (req.url && req.url.includes('__edge_functions__')) {
                                res.statusCode = 403;
                                res.end('Forbidden');
                                return;
                            }
                            next();
                        });
                    },
                },
                // ── Transform error auto-repair plugin ────────────────────────────
                // Returns repaired code in-memory ONLY. Do NOT write to disk here  
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
                            // Return repaired code in-memory   NO disk write to avoid watcher loop
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
                            // Transform failed   attempt component-level fallback (in-memory only).
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
  // ── Click-to-select inspector ────────────────────────────────────
  // Activated/deactivated via postMessage from the parent (MultiDevicePreview).
  // When active, clicking an element posts its selector + rect + tagName back
  // so the chat can scope the next prompt to that element (Lovable/v0 parity).
  var _inspectActive = false;
  var _overlay = null;

  function clearOverlay() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
  }

  function highlight(el) {
    if (!_overlay) {
      _overlay = document.createElement('div');
      _overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;border:2px solid #6366f1;background:rgba(99,102,241,0.12);transition:all 80ms ease;';
      document.body.appendChild(_overlay);
    }
    var r = el.getBoundingClientRect();
    _overlay.style.left = r.left + 'px';
    _overlay.style.top = r.top + 'px';
    _overlay.style.width = r.width + 'px';
    _overlay.style.height = r.height + 'px';
  }

  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      var part = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      var parent = el.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'ecg-inspect-mode') {
      _inspectActive = e.data.active;
      if (!_inspectActive) clearOverlay();
    }
  });

  document.addEventListener('click', function(e) {
    if (!_inspectActive) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    var selector = buildSelector(el);
    var r = el.getBoundingClientRect();
    try {
      window.parent.postMessage({
        type: 'ecg-element-selected',
        selector: selector,
        tagName: el.tagName.toLowerCase(),
        text: (el.innerText || '').slice(0, 100),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height }
      }, '*');
    } catch(err) {}
  }, true);

  document.addEventListener('mousemove', function(e) {
    if (!_inspectActive) return;
    var el = e.target;
    if (el && el !== document.body && el !== document.documentElement) highlight(el);
  });
})();`,
                                injectTo: 'head-prepend',
                            },
                            {
                                tag: 'script',
                                attrs: { type: 'text/javascript' },
                                children: `(function(){
  function sendNav() {
    try {
      // Apps use HashRouter   the route lives in the hash fragment, not the pathname.
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
    // Element occupies at least 4x4 px of screen real estate   real content
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

  // A blank reading on the FIRST check is only a suspicion, not a verdict   a
  // cold preview server (Vite still transforming/optimizing deps after the
  // project was idle) can easily take longer than a few seconds to paint
  // anything, and that used to get misreported as a real crash. Only report
  // once a check is still blank on the CONFIRM pass, several seconds later.
  function checkBlank(confirm) {
    if (_blankReported) return;
    try {
      var root = document.getElementById('root') || document.getElementById('app');
      var target = root || document.body;
      var isBlank = (target.children.length === 0) || !hasRealContent(target, 6);
      if (isBlank) {
        if (confirm) {
          reportBlank();
        } else {
          scheduleCheck(7000, true);
        }
      } else {
        _hadContent = true; // app has rendered at least once   resets observer guard
      }
    } catch(e) {}
  }

  function scheduleCheck(delay, confirm) {
    if (_blankReported) return;
    clearTimeout(_reportTimer);
    _reportTimer = setTimeout(function() { checkBlank(confirm); }, delay);
  }

  // Initial suspicion check at 5s (soft   just schedules a confirm pass if
  // still blank), confirmed at +7s (12s total) before actually flagging.
  window.addEventListener('load', function() {
    scheduleCheck(5000, false);
  });

  // Re-check after any route change (React Router / hash nav / back-forward).
  // The app already proved it can render once, so a shorter confirm window
  // is fine here   this path is for genuine post-navigation crashes.
  window.addEventListener('hashchange', function() { if (!_blankReported) scheduleCheck(1500, true); });
  window.addEventListener('popstate',   function() { if (!_blankReported) scheduleCheck(1500, true); });

  // Watch for the React root being emptied AFTER it previously had content.
  // This catches: HMR update failures, React crashes, route components that
  // unmount everything, and Vite's dev-server error overlay replacing the app.
  try {
    var root = document.getElementById('root') || document.getElementById('app') || document.body;
    var observer = new MutationObserver(function() {
      if (_blankReported || !_hadContent) return;
      // Debounce: give React 2s to re-render after the DOM change before flagging
      scheduleCheck(2000, true);
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
                },
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

// Build CORS options   restrict origins in production, allow all in development.
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
    app.use(express.json({ limit: '50mb' }));

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

    // Pre-installed packages list   the agent queries this to know which
    // imports are available without an npm install.
    app.get('/packages', (req, res) => {
        res.json({ packages: COMMON_DEPS });
    });

    // ── Package install endpoint ──────────────────────────────────────────────
    // Installs npm packages into the preview service's own node_modules so Vite
    // can resolve them. Called by the agent's run_command tool after it installs
    // locally, ensuring both directories stay in sync.
    //
    // Auth: same x-update-secret header used by /preview/:id/update.
    // Body: { packages: ["chart.js", "lodash"] }
    app.options('/packages/install', cors(corsOptions));
    app.post('/packages/install', cors(corsOptions), async (req, res) => {
        if (PREVIEW_UPDATE_SECRET) {
            const provided = req.headers['x-update-secret'];
            if (!provided || provided !== PREVIEW_UPDATE_SECRET) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }

        const { packages } = req.body || {};
        if (!Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({ error: 'packages[] array required' });
        }

        // Validate: only plain package names   no shell metacharacters, no paths
        const NAME_RE = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(@[\w.^~>=<-]+)?$/i;
        const invalid = packages.filter(p => typeof p !== 'string' || !NAME_RE.test(p.trim()));
        if (invalid.length > 0) {
            return res.status(400).json({ error: `Invalid package name(s): ${invalid.join(', ')}` });
        }

        const pkgList = packages.map(p => p.trim()).join(' ');
        const baseFlags = '--ignore-scripts --no-audit --no-fund';
        const installCmd = `npm install ${baseFlags} ${pkgList}`;
        const legacyCmd  = `npm install ${baseFlags} --legacy-peer-deps ${pkgList}`;

        console.log(`[Packages] Installing into preview node_modules: ${pkgList}`);

        const { exec: execPkg } = require('child_process');
        const runInstall = (cmd, cb) => execPkg(cmd, {
            cwd: __dirname,
            timeout: 120_000,
            env: { ...process.env, NODE_ENV: 'development' },
        }, cb);

        runInstall(installCmd, (err, stdout, stderr) => {
            let out = [stdout, stderr].filter(Boolean).join('\n');

            const doFinish = (finalErr, finalOut) => {
                if (finalErr) {
                    console.error(`[Packages] Install failed: ${finalOut.slice(0, 500)}`);
                    return res.status(500).json({ error: 'Install failed', detail: finalOut.slice(0, 1000) });
                }

                console.log(`[Packages] Installed ${pkgList}   invalidating Vite dep caches`);
                for (const [projectId, instance] of activeServers.entries()) {
                    try {
                        instance.vite.moduleGraph.invalidateAll();
                        instance.vite.ws.send({ type: 'full-reload', path: '*' });
                    } catch (e) {
                        console.warn(`[Packages] Cache invalidation failed for ${projectId}:`, e?.message);
                    }
                }
                res.json({ success: true, installed: packages, output: finalOut.slice(0, 500) });
            };

            // Auto-retry with --legacy-peer-deps on peer dependency conflicts
            if (err && out.includes('ERESOLVE')) {
                console.log(`[Packages] Peer dep conflict   retrying with --legacy-peer-deps: ${pkgList}`);
                runInstall(legacyCmd, (err2, stdout2, stderr2) => {
                    doFinish(err2, [stdout2, stderr2].filter(Boolean).join('\n'));
                });
            } else {
                doFinish(err, out);
            }
        });
    });

    // Catch JSON parse errors from express.json()
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
    // requests the asset from the domain root   bypassing the project's
    // `/preview/{projectId}/` base path and getting a 404.
    //
    // This middleware intercepts those root-level asset requests, extracts the
    // project ID from the Referer header (which always contains the preview URL),
    // and redirects to the correct project-scoped path so the file is served
    // by the right Vite instance.
    //
    // Supported asset prefixes: /assets/, /images/, /fonts/, /icons/, /media/
    //   all common names for things placed in a project's public/ directory.
    const ASSET_PATH_RE = /^\/(assets|images|fonts|icons|media)\//;
    const PREVIEW_REFERER_RE = /\/preview\/([a-f0-9-]{36})\//i;

    app.use((req, res, next) => {
        if (!ASSET_PATH_RE.test(req.url)) return next();

        // Only redirect GET/HEAD requests (not PUT/POST API calls)
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        const referer = req.headers.referer || req.headers.referrer || '';
        const match = referer.match(PREVIEW_REFERER_RE);
        if (!match) return next(); // no project context   let it 404 normally

        const projectId = match[1];
        const targetUrl = `/preview/${projectId}${req.url}`;
        console.log(`[AssetRescue] ${req.url} → ${targetUrl} (referer project: ${projectId})`);
        // Internal forward   rewrite req.url and hand off to the /preview/:projectId handler
        req.url = targetUrl;
        next();
    });

    // ── Path-based published site routing   preview.ecomgear.app/p/{slug} ──
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

    // ── Published subdomain routing   {slug}.ecomgear.app (legacy/HTTP fallback) ──
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
    // ── Per-route static SEO shells ──────────────────────────────────────────
    // Generates {route}/index.html copies of the built SPA shell, each with that
    // route's own <title>/meta/OG/canonical/structured-data injected   for pages
    // that have an override saved in project_seo_routes (server/src/routes/seo.routes.ts
    // owns the CRUD API for that table; this is the consumer side, at publish time).
    //
    // Scoped to STATIC routes only (no ":" params)   a route like "/product/:id"
    // has no single concrete URL to generate without knowing which product, which
    // needs the project's actual data (product catalog), a separate, bigger piece.
    // Every generated app uses HashRouter for live preview/editing (pinned
    // deliberately   BrowserRouter breaks the shared preview-service's own
    // routing), so this does NOT change how the app navigates internally. It only
    // adds extra static entry points a crawler or social-share bot hits on a
    // fresh page load   real URLs like /about, not hash fragments, which crawlers
    // and OG scrapers (that never execute JS) can actually read.
    function injectSeoMetaJs(html, seo, pageUrl) {
        let out = html;
        const setTitle = (h, title) => /<title>/i.test(h)
            ? h.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
            : h.replace('</head>', `  <title>${title}</title>\n</head>`);
        const setMeta = (h, attrs, content) => {
            const key = (attrs.match(/name="([^"]+)"/) || attrs.match(/property="([^"]+)"/))?.[1];
            if (key) {
                const re = new RegExp(`<meta\\s[^>]*(name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
                if (re.test(h)) return h.replace(re, `<meta ${attrs} content="${content}">`);
            }
            return h.replace('</head>', `  <meta ${attrs} content="${content}">\n</head>`);
        };
        const esc = (s) => String(s).replace(/"/g, '&quot;');

        if (seo.title) out = setTitle(out, esc(seo.title));
        if (seo.description) out = setMeta(out, 'name="description"', esc(seo.description));
        if (seo.robots) out = setMeta(out, 'name="robots"', esc(seo.robots));
        const canonical = seo.canonical_url || pageUrl;
        if (canonical) {
            out = /<link[^>]+rel=["']canonical["'][^>]*>/i.test(out)
                ? out.replace(/<link[^>]+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${esc(canonical)}">`)
                : out.replace('</head>', `  <link rel="canonical" href="${esc(canonical)}">\n</head>`);
        }
        const ogTitle = seo.og_title || seo.title;
        const ogDesc = seo.og_description || seo.description;
        if (ogTitle) out = setMeta(out, 'property="og:title"', esc(ogTitle));
        if (ogDesc) out = setMeta(out, 'property="og:description"', esc(ogDesc));
        if (seo.og_image) out = setMeta(out, 'property="og:image"', esc(seo.og_image));
        if (pageUrl) out = setMeta(out, 'property="og:url"', esc(pageUrl));
        if (ogTitle) {
            out = setMeta(out, 'name="twitter:card"', 'summary_large_image');
            out = setMeta(out, 'name="twitter:title"', esc(ogTitle));
        }
        if (ogDesc) out = setMeta(out, 'name="twitter:description"', esc(ogDesc));
        if (seo.og_image) out = setMeta(out, 'name="twitter:image"', esc(seo.og_image));

        const type = seo.structured_data_type || 'WebSite';
        const schema = { '@context': 'https://schema.org', '@type': type, ...(seo.structured_data || {}) };
        if (seo.title) schema.name = seo.title;
        if (seo.description) schema.description = seo.description;
        if (pageUrl) schema.url = pageUrl;
        const script = `<script type="application/ld+json" id="ecomgear-route-structured-data">${JSON.stringify(schema)}</script>`;
        out = out.replace('</head>', `  ${script}\n</head>`);

        return out;
    }

    // Header integrations (WhatsApp button, GA/GTM/Meta pixel, custom head/body
    // code   project_settings.setting_key='header_integrations'). Same gap as
    // the SEO fix below: previously only baked into index.html when the user
    // clicked "Sync to Site" (server/src/routes/header-integrations.routes.ts),
    // so any later normal Publish rebuilt from the un-patched source and wiped
    // it. Reading it fresh on every export makes it (a) survive every publish
    // and (b) actually disappear when the user clears the field and re-syncs
    // or republishes, instead of lingering from a stale patched copy.
    const HEADER_INTEGRATIONS_HEAD_START = '<!-- ecomgear:header-integrations:head:start -->';
    const HEADER_INTEGRATIONS_HEAD_END = '<!-- ecomgear:header-integrations:head:end -->';
    const HEADER_INTEGRATIONS_BODY_START = '<!-- ecomgear:header-integrations:body:start -->';
    const HEADER_INTEGRATIONS_BODY_END = '<!-- ecomgear:header-integrations:body:end -->';

    function replaceHeaderIntegrationsBlock(html, startMarker, endMarker, block, insertBeforeAnchor) {
        const re = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\n?`, 'm');
        const wrapped = block.trim() ? `${startMarker}\n${block.trim()}\n${endMarker}\n` : '';
        if (re.test(html)) return html.replace(re, wrapped);
        if (!wrapped) return html;
        return html.replace(insertBeforeAnchor, `${wrapped}${insertBeforeAnchor}`);
    }

    function buildHeaderIntegrationsHead(d) {
        const parts = [];
        if (d.ga_measurement_id) {
            const id = d.ga_measurement_id.trim();
            parts.push(
                `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n` +
                `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`
            );
        }
        if (d.gtm_container_id) {
            const id = d.gtm_container_id.trim();
            parts.push(
                `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],` +
                `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})` +
                `(window,document,'script','dataLayer','${id}');</script>`
            );
        }
        if (d.meta_pixel_id) {
            const id = d.meta_pixel_id.trim();
            parts.push(
                `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};` +
                `if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;` +
                `s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');` +
                `fbq('init','${id}');fbq('track','PageView');</script>` +
                `<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1" /></noscript>`
            );
        }
        if (d.custom_head_code) parts.push(d.custom_head_code.trim());
        return parts.join('\n');
    }

    function buildHeaderIntegrationsBody(d) {
        const parts = [];
        if (d.whatsapp_number) {
            const number = d.whatsapp_number.replace(/[^\d]/g, '');
            const message = encodeURIComponent(d.whatsapp_message || 'Hi! I have a question.');
            parts.push(
                `<a href="https://wa.me/${number}?text=${message}" target="_blank" rel="noopener noreferrer" ` +
                `style="position:fixed;bottom:20px;right:20px;z-index:9999;width:56px;height:56px;border-radius:50%;` +
                `background:#25D366;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.25);text-decoration:none;" ` +
                `aria-label="Chat on WhatsApp">` +
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="#fff">` +
                `<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.2h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.2 8.2 0 0 1-4.18-1.14l-.3-.18-3.11.82.83-3.03-.2-.31a8.22 8.22 0 0 1-1.26-4.4c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.55-3.7 8.23-8.26 8.23zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.4-.12-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.43-.06-.13-.56-1.35-.77-1.84-.2-.48-.41-.42-.56-.43-.14-.01-.31-.01-.48-.01-.17 0-.43.06-.66.31-.23.25-.86.84-.86 2.04 0 1.2.88 2.36 1 2.52.13.17 1.73 2.65 4.2 3.71.59.25 1.05.4 1.41.52.59.19 1.13.16 1.55.1.47-.07 1.47-.6 1.68-1.18.2-.58.2-1.08.14-1.18-.06-.11-.23-.17-.48-.29z"/>` +
                `</svg></a>`
            );
        }
        if (d.custom_body_code) parts.push(d.custom_body_code.trim());
        return parts.join('\n');
    }

    function applyHeaderIntegrationsToHtml(html, data) {
        if (!data) return html;
        let out = html;
        out = replaceHeaderIntegrationsBlock(out, HEADER_INTEGRATIONS_HEAD_START, HEADER_INTEGRATIONS_HEAD_END, buildHeaderIntegrationsHead(data), '</head>');
        out = replaceHeaderIntegrationsBlock(out, HEADER_INTEGRATIONS_BODY_START, HEADER_INTEGRATIONS_BODY_END, buildHeaderIntegrationsBody(data), '</body>');
        return out;
    }

    async function fetchHeaderIntegrations(projectId) {
        if (!SUPABASE_SERVICE_KEY) return null;
        try {
            const url = `${SUPABASE_REST_URL}/rest/v1/project_settings?project_id=eq.${encodeURIComponent(projectId)}&setting_key=eq.header_integrations&select=setting_value`;
            const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
            if (!r.ok) return null;
            const rows = await r.json();
            return rows[0]?.setting_value || null;
        } catch {
            return null;
        }
    }

    // Site-wide favicon + Google verification (project_settings.setting_key='seo').
    // Previously these only got baked into index.html when the user clicked
    // "Sync to Site" in the SEO panel (server/src/routes/seo.routes.ts's /sync,
    // which ALSO tries to redeploy immediately)   a normal Publish never picked
    // them up on its own, unlike per-route SEO above which is always read fresh
    // here at export time. Applying them the same way closes that gap.
    async function fetchSiteSeoSettings(projectId) {
        if (!SUPABASE_SERVICE_KEY) return null;
        try {
            const url = `${SUPABASE_REST_URL}/rest/v1/project_settings?project_id=eq.${encodeURIComponent(projectId)}&setting_key=eq.seo&select=setting_value`;
            const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
            if (!r.ok) return null;
            const rows = await r.json();
            return rows[0]?.setting_value || null;
        } catch {
            return null;
        }
    }

    function injectSiteWideSeo(html, siteSeo) {
        if (!siteSeo) return html;
        let out = html;
        if (siteSeo.favicon) {
            out = /<link[^>]+rel=["']icon["'][^>]*>/i.test(out)
                ? out.replace(/<link[^>]+rel=["']icon["'][^>]*>/i, `<link rel="icon" href="${siteSeo.favicon}">`)
                : out.replace('</head>', `  <link rel="icon" href="${siteSeo.favicon}">\n</head>`);
        }
        if (siteSeo.google_verification) {
            const re = /<meta\s[^>]*name=["']google-site-verification["'][^>]*>/i;
            const tag = `<meta name="google-site-verification" content="${siteSeo.google_verification}">`;
            out = re.test(out) ? out.replace(re, tag) : out.replace('</head>', `  ${tag}\n</head>`);
        }
        return out;
    }

    async function fetchRouteSeoOverrides(projectId) {
        if (!SUPABASE_SERVICE_KEY) return [];
        try {
            const url = `${SUPABASE_REST_URL}/rest/v1/project_seo_routes?project_id=eq.${encodeURIComponent(projectId)}&select=*`;
            const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
            if (!r.ok) return [];
            return await r.json();
        } catch {
            return [];
        }
    }

    async function fetchProjectPublicUrl(projectId) {
        if (!SUPABASE_SERVICE_KEY) return '';
        try {
            const url = `${SUPABASE_REST_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=published_subdomain,published_url`;
            const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
            if (!r.ok) return '';
            const rows = await r.json();
            const p = rows[0];
            if (!p) return '';
            if (p.published_url && !String(p.published_url).includes('ecomgear.app')) {
                return `https://${String(p.published_url).replace(/^https?:\/\//, '')}`;
            }
            return p.published_subdomain ? `https://${p.published_subdomain}.ecomgear.app` : '';
        } catch {
            return '';
        }
    }

    // Adds {route}/index.html files (static routes only) + a real sitemap.xml,
    // built from indexHtml (the just-built SPA shell) + saved per-route overrides.
    async function appendRouteSeoFiles(files, projectId, indexHtml) {
        const overrides = await fetchRouteSeoOverrides(projectId);
        const staticOverrides = overrides.filter(o => o.route_path && !o.route_path.includes(':'));
        if (staticOverrides.length === 0) return;

        const projectUrl = await fetchProjectPublicUrl(projectId);
        const sitemapUrls = [];
        if (projectUrl) sitemapUrls.push(projectUrl);

        for (const o of staticOverrides) {
            const routePath = o.route_path === '/' ? '' : o.route_path.replace(/^\/+|\/+$/g, '');
            const pageUrl = projectUrl ? (routePath ? `${projectUrl}/${routePath}` : projectUrl) : '';
            const html = injectSeoMetaJs(indexHtml, o, pageUrl);
            if (!routePath) {
                // Root override   apply directly to the existing index.html instead of
                // generating a duplicate. Takes priority over the global project_settings
                // SEO (seo.routes.ts /sync) since it's the more specific, later-applied write.
                const idx = files.findIndex(f => f.path === 'index.html');
                if (idx >= 0) files[idx] = { path: 'index.html', content: html };
            } else {
                files.push({ path: `${routePath}/index.html`, content: html });
            }
            if (pageUrl) sitemapUrls.push(pageUrl);
        }

        if (sitemapUrls.length > 0) {
            const today = new Date().toISOString().slice(0, 10);
            const urlEntries = sitemapUrls.map(u => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join('\n');
            const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`;
            // Replace any sitemap.xml already in the build (e.g. from public/sitemap.xml) with the real, route-aware one.
            const existingIdx = files.findIndex(f => f.path === 'sitemap.xml');
            if (existingIdx >= 0) files[existingIdx] = { path: 'sitemap.xml', content: sitemapXml };
            else files.push({ path: 'sitemap.xml', content: sitemapXml });
        }
    }

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

            let builtIndexHtml = files.find(f => f.path === 'index.html')?.content;
            if (builtIndexHtml) {
                try {
                    const headerIntegrations = await fetchHeaderIntegrations(projectId);
                    if (headerIntegrations) {
                        builtIndexHtml = applyHeaderIntegrationsToHtml(builtIndexHtml, headerIntegrations);
                        const hiIdx = files.findIndex(f => f.path === 'index.html');
                        if (hiIdx >= 0) files[hiIdx] = { path: 'index.html', content: builtIndexHtml };
                    }
                } catch (hiErr) {
                    console.warn(`[Export] ${projectId}   header integrations injection failed (non-fatal):`, hiErr.message);
                }
                try {
                    const siteSeo = await fetchSiteSeoSettings(projectId);
                    if (siteSeo) {
                        builtIndexHtml = injectSiteWideSeo(builtIndexHtml, siteSeo);
                        const idx = files.findIndex(f => f.path === 'index.html');
                        if (idx >= 0) files[idx] = { path: 'index.html', content: builtIndexHtml };
                    }
                } catch (seoErr) {
                    console.warn(`[Export] ${projectId}   site-wide SEO (favicon/verification) failed (non-fatal):`, seoErr.message);
                }
                try {
                    await appendRouteSeoFiles(files, projectId, builtIndexHtml);
                } catch (seoErr) {
                    console.warn(`[Export] ${projectId}   per-route SEO generation failed (non-fatal):`, seoErr.message);
                }
            }

            console.log(`[Export] ${projectId}   ${files.length} built files`);
            res.json({ success: true, files });
        } catch (e) {
            if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
            console.error(`[Export] ${projectId} build failed:`, e.message);
            res.status(500).json({ error: 'Build failed', detail: e.message });
        }
    });

    // Secrets API: POST /preview/:projectId/secrets
    // Writes the project's real VITE_* secrets (hosted DB creds, Supabase auth,
    // functions URL, etc.) to a .env.local file so Vite's own env loading serves
    // the real values via import.meta.env.*   restarts the Vite server so it picks
    // them up (Vite only reads .env files at server startup, not on every request).
    app.options('/preview/:projectId/secrets', cors(corsOptions));
    app.post('/preview/:projectId/secrets', async (req, res) => {
        if (PREVIEW_UPDATE_SECRET) {
            const provided = req.headers['x-update-secret'];
            if (!provided || provided !== PREVIEW_UPDATE_SECRET) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        const { secrets } = req.body;
        if (!secrets || !Array.isArray(secrets)) {
            return res.status(400).json({ error: 'Invalid secrets format' });
        }

        const projectRoot = initProject(projectId);
        const envLines = secrets
            .filter((s) => s && typeof s.key_name === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(s.key_name))
            .map((s) => `${s.key_name}=${JSON.stringify(String(s.key_value ?? ''))}`);
        const envContent = envLines.join('\n') + '\n';
        const envPath = path.join(projectRoot, '.env.local');

        let changed = true;
        try {
            const existing = fs.readFileSync(envPath, 'utf-8');
            changed = existing !== envContent;
        } catch {
            // No existing file   this is a real change
        }

        fs.writeFileSync(envPath, envContent);
        console.log(`[${projectId}] Wrote ${envLines.length} secret(s) to .env.local`);

        if (changed) {
            await restartProjectServer(projectId, 'secrets updated').catch(() => {});
        }

        res.json({ success: true, secretsWritten: envLines.length, restarted: changed });
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
            return res.status(429).json({ error: 'Too many update requests   slow down' });
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

        // ── Concurrent-edit guard: reject if a different agent run currently
        // holds this project's lock (see checkAgentLock above) ───────────────
        const lockCheck = await checkAgentLock(projectId, req.headers['x-agent-lock-token']);
        if (!lockCheck.ok) {
            return res.status(423).json({
                error: 'Another generation is currently running for this project. This push was rejected to avoid corrupting its files   wait for it to finish and try again.',
                code: 'PROJECT_LOCKED',
            });
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
            console.warn(`[${projectId}] Import warnings: ${importErrors.length} unresolved import(s)   letting Vite HMR handle`);
            // Store as warnings so /status can report them, but don't block
            setProjectErrors(projectId, uniqueImportErrors.map((e) => e.summary), 'warning');
        }

        // ── Stable Architecture: Snapshot before write ────────────────────
        const hasSnapshot = snapshotProjectSrc(projectRoot);

        try {
            const materialized = await materializeProjectFiles(projectId, projectRoot, files);
            const { userFilePaths, allFixedIssues, validationErrors } = materialized;
            // validationErrors (real TS semantic errors   undefined names, etc.) are
            // merged with the post-write build check below into one real health
            // signal, rather than being filed here as a non-blocking 'warning'.

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
            // 60-120 seconds while Vite optimizes deps   showing a blank page.
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

                // transformRequest with a 30s timeout   enough for large dep trees
                await Promise.race([
                    viteInstance.transformRequest(`/${entryToWarm}`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), 30000)),
                ]);
                console.log(`[${projectId}] Warmup complete   Vite deps pre-bundled via transformRequest`);
            } catch (warmupErr) {
                // Non-blocking: warmup failure does not prevent the update from succeeding.
                // The browser may still get a short blank (Vite will finish optimization
                // on first real request) but this is rare and resolves within seconds.
                console.warn(`[${projectId}] Warmup failed (non-blocking):`, warmupErr?.message);
            }

            // ── Post-write build check ─────────────────────────────────
            // Run syntax check on all source files. Report errors as 'build'
            // so getProjectDiagnostics() returns healthy:false   this ensures
            // the agent loop sees the failure and retries instead of stopping.
            //
            // IMPORTANT: quickViteBuildCheck only runs esbuild (syntax-only  
            // parses fine even for `supabase.auth.getSession()` with zero import
            // of `supabase` anywhere, since that's a semantic/binding issue, not
            // a parse error). The earlier validateSourceFile() pass (TypeScript's
            // transpileModule, captured above as validationErrors) DOES catch
            // those   undefined-name references, unbound identifiers   but used
            // to be filed under diagnosticKind 'warning' (non-blocking), and this
            // check's success branch then unconditionally cleared ALL errors,
            // silently erasing whatever validateSourceFile had just found. Merge
            // both into one real signal so undefined-symbol bugs (e.g. a page
            // referencing `localDb`/`localAuth` that was never imported) actually
            // mark the preview unhealthy instead of being reported as clean.
            const buildCheck = await quickViteBuildCheck(projectId, projectRoot);
            const combinedErrorSummaries = [
                ...validationErrors.map((e) => e.summary),
                ...(buildCheck.ok ? [] : buildCheck.errors.map((e) => e.summary)),
            ];
            if (combinedErrorSummaries.length > 0) {
                console.warn(`[${projectId}] Build/type errors: ${combinedErrorSummaries.length} issue(s)   agent will repair`);
                setProjectErrors(projectId, combinedErrorSummaries, 'build');
            } else {
                // Clear previous errors only when BOTH checks are clean.
                setProjectErrors(projectId, []);
            }
            cleanupSnapshot(projectRoot);

            // Return success   files are promoted to live preview
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

    // POST /preview/:projectId/check — validate pending in-progress-run edits
    // WITHOUT writing them to disk or touching the live, watched Vite instance.
    // Used by get_build_errors.ts's mid-run error checks so an agent run's
    // intermediate states never flicker in the user-visible preview or
    // trigger real Vite rebuild work for content about to be overwritten
    // again seconds later. The one real disk write + live reload still
    // happens exactly once, at true run completion, via /update.
    app.post('/preview/:projectId/check', async (req, res) => {
        if (PREVIEW_UPDATE_SECRET) {
            const provided = req.headers['x-update-secret'];
            if (!provided || provided !== PREVIEW_UPDATE_SECRET) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }

        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: 'Invalid project ID' });
        }
        const { files } = req.body;
        if (!files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Invalid files format' });
        }

        // No initProject() here deliberately — that writes scaffold files to
        // disk as a side effect. If the project directory doesn't exist yet
        // (brand-new project, first-ever run), the checks below degrade
        // gracefully rather than erroring.
        const projectRoot = path.join(PROJECTS_ROOT, projectId);

        try {
            const { validationErrors } = await materializeProjectFiles(projectId, projectRoot, files, { dryRun: true });
            const importErrors = checkCrossFileImports(projectRoot, files, false);

            const errors = [
                ...validationErrors.map((e) => e.summary),
                ...importErrors.map((e) => e.summary),
            ];

            res.json({
                healthy: errors.length === 0,
                errors,
                diagnosticKind: errors.length === 0 ? 'healthy' : 'build',
            });
        } catch (err) {
            console.error(`[${projectId}] Check failed:`, err);
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
                        chunk = `// Vite server restarting   module temporarily unavailable\nexport default undefined;`;
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
            console.log(`[Warmup] Done   ${restored}/${warmupIds.length} projects restored`);
            // Clean up the warmup list now that we've processed it
            try { fs.unlinkSync(WARMUP_LIST_FILE); } catch (e) { /* ignore */ }
        });
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
        console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);

        if (previewState.cleanupTimer) {
            clearInterval(previewState.cleanupTimer);
            previewState.cleanupTimer = null;
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
