import 'dotenv/config'; // loads server/.env first
import { configDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
// Local dev: load .env.local (project root)   contains production service credentials.
// Does NOT override server/.env so local overrides always win.
configDotenv({ path: path.join(ROOT, '.env.local'), override: false });
// Production / any environment: load .env.production so TENANT_DB_* and other
// server secrets survive PM2 restarts without needing --update-env.
configDotenv({ path: path.join(ROOT, '.env.production'), override: false });
import app from './app.js';
import { logger } from './utils/logger.js';
import { ensureBaseTemplate } from './services/baseTemplateService.js';
import { testAndAutoDisableProviders } from './services/llm-health.service.js';
import { getLlmControlState } from './services/llm-control.service.js';
import { probeEmbeddingProvider } from './knowledgebase/index.js';
import { releaseAllLocksForThisProcess } from './routes/ai.routes.js';
import type { Server } from 'node:http';

const PORT = process.env.PORT || 5001;

const activeConnections = new Set<import('node:net').Socket>();

// Load LLM config first (sets GOOGLE_GENERATIVE_AI_API_KEY), then probe embeddings.
// Must be sequential   probing before the key is loaded caches 'bm25' and silently
// prevents all KB indexing until the next resetProviderCache() call.
getLlmControlState()
    .then(() => probeEmbeddingProvider())
    .catch((err) => logger.warn('[LlmControl] Pre-listen state load failed:', err?.message));

const server: Server = app.listen(PORT, () => {
    logger.info(`🚀 eComGear API Server running on port ${PORT}`);
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

    // Deterministic cleanup: release any agent_locks rows THIS process holds,
    // regardless of whether its in-flight request handlers ever reach their
    // own finally block (see releaseAllLocksForThisProcess's comment).
    releaseAllLocksForThisProcess().catch(() => {});

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
