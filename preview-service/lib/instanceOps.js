// Cross-cutting operations on a project's Vite "instance" that differ by
// shape: legacy in-process ({ vite, server, lastAccessed }) vs. child-process
// ({ proc, port, lastAccessed }, PREVIEW_CHILD_PROCESS_MODE). Centralized here
// so server.js's call sites do one thing (call the helper) regardless of
// which mode a given project is running in, instead of an `if (instance.proc)`
// scattered inconsistently across six places.
const { fork } = require('child_process');
const path = require('path');
const { appendProjectError } = require('./previewState');

const READY_TIMEOUT_MS = 15_000;

function isChildInstance(instance) {
    return Boolean(instance && instance.proc);
}

/**
 * Forks a per-project Vite child process and waits for its ready/error
 * handshake. Resolves with the live `proc` handle once Vite has actually
 * started listening; rejects (and force-kills the child) on error, timeout,
 * or early exit. Registers a permanent 'diagnostic' forwarder so build/runtime
 * errors surfaced deep inside the child's Vite plugins still reach this
 * process's projectErrors/projectDiagnostics Maps   a child's own copy of
 * previewState.js is a separate, empty Map nobody else ever reads.
 */
async function spawnChildInstance(projectId, projectRoot, port, { useSystemdRun, memoryMax = '512M', cpuQuota = '50%' } = {}) {
    const runnerPath = path.join(__dirname, 'viteChildRunner.js');
    const env = {
        ...process.env,
        PROJECT_ID: projectId,
        PROJECT_ROOT: projectRoot,
        PORT: String(port),
    };
    const forkOpts = {
        cwd: projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--max-old-space-size=384'],
    };

    // systemd-run gives real cgroup-enforced hard limits (confirmed available
    // on VPS2: systemd-run + cgroup v2 memory/cpu controllers). Falls back to
    // a plain fork with only the soft V8-heap cap above if systemd-run itself
    // fails to spawn for any reason   never block preview creation on the
    // hard-limit path.
    let proc;
    if (useSystemdRun) {
        try {
            proc = fork(runnerPath, [], {
                ...forkOpts,
                execPath: 'systemd-run',
                execArgv: ['--scope', '--quiet', '-p', `MemoryMax=${memoryMax}`, '-p', `CPUQuota=${cpuQuota}`, '--', process.execPath, ...forkOpts.execArgv],
            });
        } catch (err) {
            console.warn(`[${projectId}] systemd-run wrapping failed, falling back to plain fork:`, err?.message);
            proc = fork(runnerPath, [], forkOpts);
        }
    } else {
        proc = fork(runnerPath, [], forkOpts);
    }

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const line of lines) {
            if (line.trim()) {
                console.error(`[${projectId}] (child) ${line}`);
                appendProjectError(projectId, line, 'build');
            }
        }
    });
    proc.stdout?.on('data', (chunk) => {
        const s = chunk.toString().trim();
        if (s) console.log(`[${projectId}] (child) ${s}`);
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
            reject(new Error(`Vite child process for ${projectId} did not become ready within ${READY_TIMEOUT_MS}ms`));
        }, READY_TIMEOUT_MS);

        function onMessage(msg) {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'ready') { cleanup(); resolve(); }
            else if (msg.type === 'error') { cleanup(); reject(new Error(msg.message || 'Vite child process failed to start')); }
        }
        function onExit(code) {
            cleanup();
            reject(new Error(`Vite child process for ${projectId} exited early (code ${code}) before becoming ready`));
        }
        function cleanup() {
            clearTimeout(timeout);
            proc.removeListener('message', onMessage);
            proc.removeListener('exit', onExit);
        }
        proc.once('message', onMessage);
        proc.once('exit', onExit);
    });

    // Permanent diagnostic forwarder for the rest of this child's life.
    proc.on('message', (msg) => {
        if (msg && msg.type === 'diagnostic') {
            appendProjectError(projectId, msg.message, msg.kind || 'build');
        }
    });

    return proc;
}

// Both instance shapes use the SAME Vite `base: /preview/{projectId}/`
// config (see viteConfig.js) — the scaffolded index.html and agent-generated
// asset references hardcode that prefix, and a child's own real Vite listener
// auto-strips it the same way any standalone Vite dev server would. Express's
// mount-stripping on the MAIN preview route (only) removes the prefix from
// req.url before we get here; restore it for a child instance so its base
// matching sees the same path shape a real browser request would produce.
// The other two call sites (/p/:slug, subdomain routing) never strip it, so
// this is a no-op for them.
function ensurePreviewPrefix(req, projectId) {
    const mountedPrefix = `/preview/${projectId}`;
    if (req.url.startsWith(mountedPrefix)) return;
    req.url = req.originalUrl && req.originalUrl.startsWith(mountedPrefix)
        ? req.originalUrl
        : `${mountedPrefix}${req.url === '/' ? '/' : req.url}`;
}

function proxyRequest(instance, projectId, req, res, next, proxyServer) {
    if (isChildInstance(instance)) {
        ensurePreviewPrefix(req, projectId);
        proxyServer.web(req, res, { target: `http://127.0.0.1:${instance.port}` }, (err) => {
            console.error('[proxy] web proxy error:', err?.message);
            next(err);
        });
    } else {
        instance.vite.middlewares(req, res, next);
    }
}

function proxyUpgrade(instance, projectId, req, socket, head, proxyServer) {
    if (isChildInstance(instance)) {
        // Upgrade requests arrive on the raw http server, never routed through
        // Express's mount-stripping   req.url already carries the full prefix.
        proxyServer.ws(req, socket, head, { target: `http://127.0.0.1:${instance.port}` });
    } else {
        instance.server.emit('upgrade', req, socket, head);
    }
}

function sendFullReload(instance, projectId) {
    if (isChildInstance(instance)) {
        try { instance.proc.send({ type: 'full-reload' }); } catch (e) {
            console.warn(`[${projectId}] full-reload IPC failed:`, e?.message);
        }
    } else if (instance?.vite) {
        try {
            instance.vite.moduleGraph.invalidateAll();
            instance.vite.ws.send({ type: 'full-reload', path: '*' });
        } catch (e) {
            console.warn(`[${projectId}] full-reload failed:`, e?.message);
        }
    }
}

async function warmupInstance(instance, entryToWarm, timeoutMs = 30_000) {
    if (isChildInstance(instance)) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { cleanup(); reject(new Error('warmup timeout')); }, timeoutMs);
            function onMessage(msg) {
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'warmup-done') { cleanup(); resolve(); }
                else if (msg.type === 'warmup-error') { cleanup(); reject(new Error(msg.message || 'warmup failed')); }
            }
            function cleanup() {
                clearTimeout(timeout);
                instance.proc.removeListener('message', onMessage);
            }
            instance.proc.on('message', onMessage);
            instance.proc.send({ type: 'warmup', entryPoint: entryToWarm });
        });
    }
    return Promise.race([
        instance.vite.transformRequest(`/${entryToWarm}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('warmup timeout')), timeoutMs)),
    ]);
}

/** Graceful close, escalating SIGTERM -> SIGKILL for child instances. */
async function closeInstance(instance, projectId, reason) {
    if (isChildInstance(instance)) {
        await new Promise((resolve) => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            instance.proc.once('exit', finish);
            try {
                instance.proc.send({ type: 'shutdown' });
            } catch {
                finish();
                return;
            }
            setTimeout(() => {
                if (done) return;
                console.warn(`[${projectId}] Child process didn't exit gracefully during ${reason}, sending SIGTERM`);
                try { instance.proc.kill('SIGTERM'); } catch { /* already gone */ }
                setTimeout(() => {
                    if (done) return;
                    console.warn(`[${projectId}] Child process still alive after SIGTERM during ${reason}, sending SIGKILL`);
                    try { instance.proc.kill('SIGKILL'); } catch { /* already gone */ }
                }, 5_000);
            }, 5_000);
        });
        return;
    }

    try {
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
}

module.exports = {
    isChildInstance,
    spawnChildInstance,
    proxyRequest,
    proxyUpgrade,
    sendFullReload,
    warmupInstance,
    closeInstance,
};
