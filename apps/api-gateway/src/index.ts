// MUST be the first import. ESM evaluates every import before any statement in
// this file runs, so env loading has to happen inside an import of its own or
// the whole ./app.js graph (winston included) evaluates against a bare env.
// The old inline configDotenv() calls here ran twelve lines too late — see
// bootstrap-env.ts for the full mechanism and the production incident.
import './bootstrap-env.js';
import app from './app.js';
import { logger } from './utils/logger.js';
import { ensureBaseTemplate } from './services/baseTemplateService.js';
import { testAndAutoDisableProviders, startLlmHealthLoop } from './services/llm-health.service.js';
import { startAgentRunWatchdog } from './services/agentRunWatchdog.service.js';
import { startServerStatusMonitor } from './services/serverStatus.service.js';
import { getLlmControlState } from './services/llm-control.service.js';
import { probeEmbeddingProvider } from './knowledgebase/index.js';
import { releaseAllLocksForThisProcess, interruptRunsForThisProcess } from './routes/ai.routes.js';
import type { Server } from 'node:http';
import { config } from './config/environment.js';

const PORT = process.env.PORT || 5001;

// One line of runtime truth per boot. pm2's records show intent, /proc shows
// the execve snapshot — neither shows what the logger actually initialized
// with (both were checked against production on 2026-08-30 and both misled).
// This is the value winston froze at, logged where every future incident can
// read it. Presence booleans only for secrets — never values.
logger.info('[Boot] resolved config', {
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    port: PORT,
    serviceRole: process.env.SERVICE_ROLE || 'all',
    supabaseUrlSet: Boolean(config.supabaseUrl),
    redisUrlSet: Boolean(process.env.REDIS_URL),
});

const activeConnections = new Set<import('node:net').Socket>();

// Load LLM config first (sets GOOGLE_GENERATIVE_AI_API_KEY), then probe embeddings.
// Must be sequential   probing before the key is loaded caches 'bm25' and silently
// prevents all KB indexing until the next resetProviderCache() call.
getLlmControlState()
    .then(() => probeEmbeddingProvider())
    .catch((err) => logger.warn('[LlmControl] Pre-listen state load failed:', err?.message));

const server: Server = app.listen(PORT, () => {
    logger.info(`🚀 eComGear API Server running on port ${PORT}`);
    // Nginx fronts this with `upstream { keepalive 64 }`; Node's default 5s
    // keepAliveTimeout is shorter than nginx's idle window, so nginx reused
    // just-closed sockets -> intermittent 502s (same race fixed in
    // preview-service/server.js 2026-08-17; headersTimeout > keepAliveTimeout
    // per Node docs).
    server.keepAliveTimeout = 75_000;
    server.headersTimeout = 80_000;
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

    // Signal PM2 that this worker is ready to accept traffic.
    // Required for cluster-mode rolling reloads: PM2 waits for this before
    // sending SIGINT to the old worker, giving true zero-downtime deploys.
    if (typeof process.send === 'function') process.send('ready');

    // Track open sockets so graceful shutdown can destroy keep-alive connections
    server.on('connection', (socket) => {
        activeConnections.add(socket);
        socket.once('close', () => activeConnections.delete(socket));
    });

    // Test all LLM providers on startup   auto-disables any that fail.
    // Runs after the server is already accepting requests so startup is never blocked.
    testAndAutoDisableProviders().catch((err) =>
        logger.warn('[LlmHealth] Startup health check failed:', err?.message)
    );
    // Then keep re-checking hourly so mid-uptime credit/quota exhaustion is
    // detected by ops before users hit it.
    startLlmHealthLoop();

    // Sweep agent_runs rows abandoned in status='running' (a hung run that
    // never reaches any of its own completion/failure update sites) so the
    // column stays trustworthy instead of lying forever.
    startAgentRunWatchdog();

    // Probe registered application servers so the admin Servers page has
    // status history even when nobody opens it. API role only.
    if ((process.env.SERVICE_ROLE || 'all') !== 'gen') startServerStatusMonitor();

    // Warm up the golden template in the background with retry.
    retryAsync(() => ensureBaseTemplate(), 3, 2000).catch((err) =>
        logger.error('[BaseTemplate] Critical: template init failed after retries:', err?.message)
    );
});

// ── Simple retry helper for startup tasks ────────────────────────────────────
async function retryAsync(fn: () => Promise<void>, attempts: number, delayMs: number): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        try { await fn(); return; } catch (err) {
            logger.warn(`[retryAsync] Attempt ${i + 1}/${attempts} failed: ${(err as Error)?.message}`);
            if (i === attempts - 1) throw err;
            await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        }
    }
}

// ── Graceful shutdown: drain connections before exit ─────────────────────────
let shuttingDown = false;
function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received   draining connections...`);

    // Deterministic cleanup: tell in-flight runs they are being killed and close
    // their agent_runs rows, then release any agent_locks rows THIS process
    // holds, regardless of whether its in-flight request handlers ever reach
    // their own finally block (see releaseAllLocksForThisProcess's comment).
    // Interrupt first: it needs the runs still present in memory, and it is what
    // turns a restart from a silently dropped stream into a message the user
    // can act on. Both are best-effort and neither may delay the drain.
    void interruptRunsForThisProcess()
        .catch(() => {})
        .finally(() => { void releaseAllLocksForThisProcess().catch(() => {}); });

    // Stop accepting new connections
    server.close(() => {
        logger.info('All connections drained, exiting');
        process.exit(0);
    });

    // Grace period before destroying keep-alive connections. This USED to be a
    // same-tick socket.destroy() with a comment claiming "12s to finish" that
    // the code never actually gave -- every deploy's SIGTERM killed in-flight
    // agent-stream sockets instantly, before the request handler's finally
    // block (releaseAgentLock's DB delete) had any chance to run. Confirmed in
    // production: 4 agent_locks rows leaked in the same ~90s window as a
    // single deploy, each still holding a project lock 14 minutes later and
    // blocking that project's file sync/load with a false "another generation
    // is running" error. Actually waiting here lets in-flight runs' own
    // abort/close handling and finally blocks complete normally first.
    const CONNECTION_DRAIN_GRACE_MS = 12_000;
    setTimeout(() => {
        for (const socket of activeConnections) {
            socket.destroy();
        }
    }, CONNECTION_DRAIN_GRACE_MS);

    // Hard kill after 15s regardless   should rarely fire now that keep-alive
    // connections are destroyed above, but keeps the process from leaking.
    setTimeout(() => {
        logger.warn('Forcing exit after 15s drain timeout');
        process.exit(1);
    }, 15_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ecosystem.config.cjs sets shutdown_with_message: true for this app (cluster
// mode), which makes PM2 send an IPC message instead of SIGTERM/SIGINT on
// restart/delete. Without this handler, gracefulShutdown() above NEVER ran on
// a real deploy -- PM2 just waited out kill_timeout and force-killed the
// process, which is exactly how agent_locks rows kept leaking on deploy even
// after releaseAllLocksForThisProcess() was added: the code that calls it was
// unreachable the whole time. Confirmed live: zero "[agent-lock]" log lines
// around any deploy's shutdown, despite SIGTERM/SIGINT handlers being wired.
process.on('message', (msg) => {
    if (msg === 'shutdown') gracefulShutdown('IPC shutdown message');
});

// Orphaned-worker self-termination. Deploys kept leaking one worker that
// outlived its replacement (confirmed live 2026-08-16: a worker from a July 9
// deploy still running 5+ weeks later from a DELETED directory, plus one
// leaked per deploy since) -- PM2 deregisters the old worker but its
// shutdown message/kill never lands. A worker PM2 manages always has a live
// IPC channel; losing it means PM2 abandoned this process, so drain and die
// instead of serving stale code forever. Running without PM2 (bare node)
// there is no channel and this never fires.
process.on('disconnect', () => {
    logger.warn('IPC channel to PM2 lost -- worker is orphaned; shutting down');
    gracefulShutdown('IPC disconnect');
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

// Treat unhandled rejections as fatal   drain active connections then let PM2 restart.
// Calling gracefulShutdown() stops new connections and gives in-flight SSE streams
// up to 15s to complete before the process exits.
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
});
