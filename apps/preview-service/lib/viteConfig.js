const fs = require('fs');
const path = require('path');
const { getViteApi } = require('./viteApi');
const { preprocessFile } = require('./materialize');

// Client-side scripts injected into every generated project's index.html.
// Read once at module load (not per-request/per-project).
const CLIENT_SCRIPTS_DIR = path.join(__dirname, 'client-scripts');
const ERROR_REPORTER_SCRIPT = fs.readFileSync(path.join(CLIENT_SCRIPTS_DIR, 'error-reporter.js'), 'utf8');
const INSPECTOR_SCRIPT = fs.readFileSync(path.join(CLIENT_SCRIPTS_DIR, 'inspector.js'), 'utf8');
const NAV_PATCH_SCRIPT = fs.readFileSync(path.join(CLIENT_SCRIPTS_DIR, 'nav-patch.js'), 'utf8');
const BLANK_CHECK_SCRIPT = fs.readFileSync(path.join(CLIENT_SCRIPTS_DIR, 'blank-check.js'), 'utf8');

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

function resilientHmrPlugin(onDiagnostic) {
    return {
        name: 'ecomgear-resilient-hmr',
        async handleHotUpdate({ file, server, modules, read }) {
            try {
                if (typeof read === 'function') {
                    await read();
                }
                return modules;
            } catch (err) {
                const errorMsg = err?.message || String(err);
                console.error(`[resilient-hmr] Caught HMR error on ${file}:`, errorMsg);

                if (server && server.ws) {
                    server.ws.send({
                        type: 'custom',
                        event: 'ecomgear:hmr-error',
                        data: {
                            errorMsg: `HMR update failed for ${path.basename(file)}: ${errorMsg}`,
                            file,
                            timestamp: Date.now(),
                        },
                    });
                }

                if (onDiagnostic) {
                    onDiagnostic(`HMR Error in ${file}: ${errorMsg}`, 'hmr');
                }

                return [];
            }
        },
    };
}

/**
 * Builds and starts a Vite dev server instance. Shared by both the legacy
 * in-process path (getOrCreateServer in server.js) and the per-project child
 * process runner (viteChildRunner.mjs) so the two paths can never drift apart.
 *
 * `onDiagnostic(message, kind)` is the one seam that lets each caller route
 * error/diagnostic events differently: the in-process caller passes
 * `appendProjectError` directly (today's behavior, unchanged); the child
 * runner passes a callback that ships them to the parent over IPC, since a
 * child process's own copy of previewState.js is a different, empty Map that
 * nobody else ever reads.
 */
async function buildViteConfig({
    projectId,
    projectRoot,
    projectCacheDir,
    hmrConfig,
    middlewareMode,
    port,
    host,
    isProduction,
    onDiagnostic,
}) {
    const { createViteServer, reactPluginFactory } = await getViteApi();
    return createViteServer({
        configFile: false,
        plugins: [
            resilientHmrPlugin(onDiagnostic),
            reactPluginFactory(),
            // ── Block __edge_functions__/ from ever being served ──────────────
            // server.fs.deny does NOT reliably block requests here (verified
            // Vite's dev middleware still transformed and served the file even
            // with fs.deny set). configureServer runs as real middleware inside
            // Vite's own stack, so it applies regardless of how the request
            // reaches this instance (direct middlewares call or proxied).
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
                        // IMPORTANT: always record the error via onDiagnostic so that
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
                            onDiagnostic(syntaxError, 'build');
                            return { code: fallback, map: null };
                        }

                        // For component/page files, generate a safe placeholder
                        if (/^src\/(pages|components|layouts|contexts|hooks)\//.test(relPath) ||
                            relPath === 'src/App.tsx' || relPath === 'src/App.jsx') {
                            const baseName = path.basename(relPath).replace(/\.(tsx|jsx|ts|js)$/i, '');
                            const componentName = baseName.replace(/[^A-Za-z0-9_$]/g, '') || 'RecoveredComponent';
                            const fallback = `export default function ${componentName}() {\n  return null;\n}\n`;
                            console.warn(`[${projectId}] Auto-repaired broken component ${relPath} at transform time`);
                            onDiagnostic(syntaxError, 'build');
                            return { code: fallback, map: null };
                        }

                        // For utility files (non-component), provide a minimal export
                        if (/\.(ts|js)$/.test(relPath) && !/\.(tsx|jsx)$/.test(relPath)) {
                            const fallback = `// Auto-recovered: original file had syntax errors\nexport {};\n`;
                            console.warn(`[${projectId}] Auto-repaired broken utility ${relPath} at transform time`);
                            onDiagnostic(syntaxError, 'build');
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
                            children: ERROR_REPORTER_SCRIPT.replaceAll('__PROJECT_ID__', projectId),
                            injectTo: 'head-prepend',
                        },
                        {
                            tag: 'script',
                            attrs: { type: 'text/javascript' },
                            children: INSPECTOR_SCRIPT,
                            injectTo: 'head-prepend',
                        },
                        {
                            tag: 'script',
                            attrs: { type: 'text/javascript' },
                            children: NAV_PATCH_SCRIPT,
                            injectTo: 'head-prepend',
                        },
                        {
                            tag: 'script',
                            attrs: { type: 'text/javascript' },
                            children: BLANK_CHECK_SCRIPT,
                            injectTo: 'head-prepend',
                        },
                    ];
                },
            },
        ],
        cacheDir: projectCacheDir,
        server: {
            middlewareMode,
            ...(middlewareMode ? {} : { port, strictPort: true }),
            host: host || '0.0.0.0',
            cors: true,
            allowOnlyFromPrivateIPs: false,
            hmr: hmrConfig,
            // Vite's own chokidar watcher is intentionally disabled. All writes to a
            // project's files go exclusively through materializeProjectFiles, which
            // sends one explicit sendFullReload after the whole turn's files are
            // written. With the watcher live too, every individual fs.writeFileSync
            // during that write loop was independently picked up (polling interval
            // ~100ms) and triggered its own reload   the deliberate end-of-run
            // reload was redundant on top of one already firing per file.
            watch: null,
        },
        appType: 'spa',
        root: projectRoot,
        // Same base regardless of middlewareMode. The scaffolded index.html
        // (initProject) and agent-generated asset references hardcode this
        // prefix already, and Vite's own transformIndexHtml uses `base` to
        // emit it. In non-middlewareMode (child process), Vite's real
        // listener also auto-strips this exact prefix off incoming requests
        // itself   the same thing `base` normally does for any standalone
        // Vite dev server   so the proxy layer just forwards the full,
        // un-stripped path (see proxyRequest in lib/instanceOps.js) instead
        // of trying to strip it a second time.
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
                onDiagnostic(msg, 'build');
            },
            warnOnce: (msg) => console.warn(`[${projectId}] ${msg}`),
        },
    });
}

module.exports = {
    buildViteConfig,
    COMMON_DEPS,
    ERROR_REPORTER_SCRIPT,
    INSPECTOR_SCRIPT,
    NAV_PATCH_SCRIPT,
    BLANK_CHECK_SCRIPT,
};
