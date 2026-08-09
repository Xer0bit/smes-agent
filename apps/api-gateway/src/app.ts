import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

// Import routes
import authRoutes from './routes/auth.routes.js';
import projectRoutes from './routes/project.routes.js';
import fileRoutes from './routes/file.routes.js';
import aiRoutes from './routes/ai.routes.js';
import previewRoutes from './routes/preview.routes.js';
import systemRoutes from './routes/system.routes.js';
import runtimeRoutes from './routes/runtime.routes.js';
import databaseRoutes from './routes/database.routes.js';
import adminDatabaseRoutes from './routes/admin-database.routes.js';
import hostingRoutes from './routes/hosting.routes.js';
import seoRoutes from './routes/seo.routes.js';
import headerIntegrationsRoutes from './routes/header-integrations.routes.js';
import githubRoutes from './routes/github.routes.js';
import stripeRoutes from './routes/stripe.routes.js';
import functionsRoutes from './routes/functions.routes.js';
import ecgDevAgentRoutes from './routes/ecg-dev-agent.routes.js';
import ecgCustomizeRoutes from './routes/ecg-customize.routes.js';
import ecgProxyRoutes from './routes/ecg-proxy.routes.js';
import ecgChatRoutes from './routes/ecg-chat.routes.js';
import ecgAccessRoutes from './routes/ecg-access.routes.js';
import ecgAuthRoutes from './routes/ecgAuth.routes.js';
import deploymentRoutes from './routes/deployment.routes.js';
import billingRoutes from './routes/billing.routes.js';

// Import middleware
import { errorHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/request-logger.middleware.js';
import { AuthenticatedRequest } from './middleware/auth.middleware.js';

// Import logger
import { logger } from './utils/logger.js';

const app = express();

// Trust the first proxy (nginx) so X-Forwarded-For is used for IP-based rate limiting
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration
// 2026-08 security audit finding: this allowlist previously accepted ANY
// subdomain of ecomgear.dev/ecomgear.app via hostname.endsWith(...), combined
// with credentials:true. Since {slug}.preview.ecomgear.app is the actual
// domain space where user-published (potentially malicious) sites live, that
// suffix match was an effective wildcard-with-credentials over attacker-
// reachable origins. Replaced with an exact-match list. If per-project
// published subdomains genuinely need authenticated access to THIS platform
// API (api.ecomgear.dev) -- as opposed to preview-service's own separate
// API, which has its own, already-exact-match CORS config -- that requires a
// DB-backed origin validator (checking against provisioned domains) rather
// than a string suffix check. Flagged as a product question, not decided
// here: confirm whether that access pattern is actually needed before
// building it.
const localOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:4173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:4173',
];
const allowedOrigins = [
    'https://ecomgear.dev',
    'https://www.ecomgear.dev',
    'https://1000.ecomgear.dev', // legitimate secondary domain -- own nginx vhost
    // (infrastructure/nginx/vps1-1000.ecomgear.dev.conf), auto-deployed by
    // scripts/deploy.sh, whitelisted in every Supabase edge function's CORS
    // list. Dropped when the wildcard *.ecomgear.dev suffix match was
    // replaced with this exact-match list during the 2026-08 security
    // remediation -- confirmed live regression: every /api/v1/* call from
    // this domain (including agent chat streaming) was being silently
    // rejected by CORS with no visible error in the chat UI.
    'https://preview.ecomgear.app',
    ...(process.env.NODE_ENV !== 'production' ? localOrigins : []),
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s: string) => s.trim()) : []),
];

const isAllowedOrigin = (origin: string): boolean => allowedOrigins.includes(origin);

// Express handles CORS for all environments. The generated nginx config on VPS3
// does not add CORS headers, so there is no duplicate-header risk in production.
app.use(cors({
    origin: (origin, callback) => {
        // Requests with no Origin header come from server-to-server callers (the
        // preview service on VPS2, curl health checks, internal tooling). Allow them
        // only when the PREVIEW_UPDATE_SECRET env var is absent (local dev) or when
        // the caller is expected to authenticate via other headers (JWT/secret).
        // Browsers always send Origin, so this bypass does not affect web clients.
        // NOTE: does NOT accept the literal string 'null' -- that IS sent by
        // browsers for sandboxed iframes / data:/blob: documents, and accepting
        // it here previously let those obtain credentialed cross-origin access.
        if (!origin) return callback(null, true);
        if (isAllowedOrigin(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'apikey',
        'x-api-version',
        'x-operation-id',
        'idempotency-key',
        'x-idempotency-key',
        'x-upsert',
        'x-client-info',
        'Cache-Control',
        'prefer',
        'range',
        'Accept',
        'Origin',
        'X-Requested-With',
        'Last-Event-ID',               // SSE resume support
        'x-update-secret',             // internal preview service auth
        'x-project-id',                // ECG proxy project header
        'x-service-key',               // ECG service-to-service auth
        'x-dashboard-access',          // ECG generated-dashboard AccessGate token
    ],
    exposedHeaders: ['Content-Type', 'Cache-Control', 'X-Request-Id', 'Last-Event-ID'],
    // Was 86400 (24h) -- 2026-08 audit noted that meant any allowlist
    // tightening took up to a day to reach already-cached browsers. Lowered
    // to 1h: still meaningfully reduces preflight OPTIONS round-trips for
    // active sessions, without leaving a stale allowlist cached that long.
    maxAge: 3600,
}));

// Raw body parser specifically for Stripe webhook signature verification
app.use('/api/v1/billing/webhook', express.raw({ type: 'application/json' }));

// Body parsing   limit raised for base64-encoded binary assets in sync payloads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// HTTP request logging
app.use(morgan('combined'));
app.use(requestLogger);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0'
    });
});

// Rate-limit the AI agent-stream endpoint   20 requests per user per minute
const aiRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    keyGenerator: (req) => (req as AuthenticatedRequest).user?.id || req.ip || 'unknown',
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many AI requests   please wait a moment' },
});

// Which route groups this process serves. VPS3 (gen server) runs SERVICE_ROLE=gen
// and only handles LLM/agent generation traffic; VPS1 runs SERVICE_ROLE=api and
// handles everything else. Unset/'all' (local dev, tests) mounts both so nothing
// else has to change to run the full stack in one process.
const SERVICE_ROLE = process.env.SERVICE_ROLE || 'all';
const servesGen = SERVICE_ROLE === 'gen' || SERVICE_ROLE === 'all';
const servesApi = SERVICE_ROLE === 'api' || SERVICE_ROLE === 'all';

// API routes
if (servesGen) {
    app.use('/api/v1/ai', aiRateLimiter, aiRoutes);
}
if (servesApi) {
    app.use('/api/v1/auth', authRoutes);
    app.use('/api/v1/auth/ecg', ecgAuthRoutes);
    app.use('/api/v1/projects', projectRoutes);
    app.use('/api/v1/files', fileRoutes);
    app.use('/api/v1/preview', previewRoutes);
    app.use('/api/v1/system', systemRoutes);
    app.use('/api/v1/runtime', runtimeRoutes);
    app.use('/api/v1/database', databaseRoutes);
    app.use('/api/v1/admin/database', adminDatabaseRoutes);
    app.use('/api/v1/hosting', hostingRoutes);
    app.use('/api/v1/seo', seoRoutes);
    app.use('/api/v1/header-integrations', headerIntegrationsRoutes);
    app.use('/api/v1/github', githubRoutes);
    app.use('/api/v1/stripe', stripeRoutes);
    app.use('/api/v1/billing', billingRoutes);
    // Also mounted at the registered GitHub OAuth App callback path   the
    // App's "Authorization callback URL" is /auth/github/callback, which
    // must match REDIRECT_URI in github.routes.ts exactly.
    app.use('/auth/github', githubRoutes);
    app.use('/api/v1/functions', functionsRoutes);
    app.use('/api/v1/ecg-connect', ecgCustomizeRoutes);
    app.use('/api/v1/ecg-dev-agent', ecgDevAgentRoutes);
    app.use('/api/v1/ecg-proxy', ecgProxyRoutes);
    app.use('/api/v1/ecg-chat', ecgChatRoutes);
    app.use('/api/v1/ecg-access', ecgAccessRoutes);
    app.use('/api/v1/deploy', deploymentRoutes);
}

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`
    });
});

// Error handling middleware
app.use(errorHandler);

export default app;
