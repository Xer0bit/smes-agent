import 'dotenv/config';
import app from './app.js';
import { logger } from './utils/logger.js';
import { ensureBaseTemplate } from './services/baseTemplateService.js';
import { testAndAutoDisableProviders } from './services/llm-health.service.js';
import type { Server } from 'node:http';

const PORT = process.env.PORT || 5001;

let server: Server;

server = app.listen(PORT, () => {
    logger.info(`🚀 eComGear API Server running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

    // Signal PM2 that this worker is ready to accept traffic.
    // Required for cluster-mode rolling reloads: PM2 waits for this before
    // sending SIGINT to the old worker, giving true zero-downtime deploys.
    if (typeof process.send === 'function') process.send('ready');

    // Test all LLM providers on startup — auto-disables any that fail.
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
    logger.info(`${signal} received — draining connections...`);

    // Stop accepting new connections
    server.close(() => {
        logger.info('All connections drained, exiting');
        process.exit(0);
    });

    // Force-kill after 15s if connections won't drain
    setTimeout(() => {
        logger.warn('Forcing exit after 15s drain timeout');
        process.exit(1);
    }, 15_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

// Treat unhandled rejections as fatal — drain active connections then let PM2 restart.
// Calling gracefulShutdown() stops new connections and gives in-flight SSE streams
// up to 15s to complete before the process exits.
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
});
