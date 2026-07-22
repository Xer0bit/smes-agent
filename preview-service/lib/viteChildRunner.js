// Per-project Vite dev server, run as its own OS child process (forked by
// getOrCreateServer in server.js when PREVIEW_CHILD_PROCESS_MODE covers this
// project). Talks to the parent exclusively over IPC   see the message
// handlers below for the full protocol.
const path = require('path');
const { buildViteConfig } = require('./viteConfig');

const projectId = process.env.PROJECT_ID;
const projectRoot = process.env.PROJECT_ROOT;
const port = parseInt(process.env.PORT, 10);
const isProduction = process.env.NODE_ENV === 'production';
const projectCacheDir = path.join(projectRoot, '.vite-cache');

function onDiagnostic(message, kind) {
    // A child process's own copy of previewState.js is a separate, empty Map
    // that nobody else ever reads   diagnostics MUST go back to the parent
    // over IPC or they silently vanish and /status stays falsely healthy.
    try { process.send({ type: 'diagnostic', message, kind }); } catch { /* parent gone */ }
}

// Same production HMR override server.js's legacy path applies: without this,
// Vite auto-detects location.port (empty for default ports), producing a
// malformed wss://host:/path URL that fails to connect and reload-loops.
const hmrConfig = {};
if (isProduction) {
    hmrConfig.host = process.env.HMR_HOST || 'preview.ecomgear.app';
    hmrConfig.protocol = process.env.HMR_PROTOCOL || 'wss';
    hmrConfig.clientPort = process.env.HMR_PORT ? parseInt(process.env.HMR_PORT, 10) : 443;
}

let vite = null;

async function main() {
    try {
        vite = await buildViteConfig({
            projectId,
            projectRoot,
            projectCacheDir,
            hmrConfig,
            middlewareMode: false,
            port,
            host: '127.0.0.1', // loopback only   parent still fronts everything externally
            isProduction,
            onDiagnostic,
        });
        await vite.listen();
        process.send({ type: 'ready' });
    } catch (err) {
        try { process.send({ type: 'error', message: err?.message || String(err) }); } catch { /* parent gone */ }
        process.exit(1);
    }
}

process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'shutdown') {
        try { await vite?.close(); } catch { /* best effort */ }
        process.exit(0);
    } else if (msg.type === 'full-reload') {
        try {
            vite?.moduleGraph.invalidateAll();
            vite?.ws.send({ type: 'full-reload', path: '*' });
        } catch (err) {
            console.warn(`[${projectId}] full-reload failed:`, err?.message);
        }
    } else if (msg.type === 'warmup') {
        // Mirrors the legacy in-process warmup: transformRequest() actually
        // WAITS for dep optimization to finish, unlike a fake HTTP request
        // that only triggers the scan asynchronously.
        try {
            if (!vite) throw new Error('vite instance not ready');
            await Promise.race([
                vite.transformRequest(`/${msg.entryPoint}`),
                new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), 28_000)),
            ]);
            process.send({ type: 'warmup-done' });
        } catch (err) {
            try { process.send({ type: 'warmup-error', message: err?.message || String(err) }); } catch { /* parent gone */ }
        }
    }
});

// Node fires 'disconnect' on this child when the IPC channel closes, which
// happens even if the parent dies via SIGKILL   the one orphan
// self-termination hook that doesn't depend on any parent-side cleanup code
// actually running.
process.on('disconnect', () => process.exit(0));

main();
