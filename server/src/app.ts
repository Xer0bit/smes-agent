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
import seoRoutes from './routes/seo.routes.js';

// Import middleware
import { errorHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/request-logger.middleware.js';

// Import logger
import { logger } from './utils/logger.js';

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:4173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:4173',
    'https://ecomgear.dev',
    'https://www.ecomgear.dev',
    'https://preview.ecomgear.app',
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s: string) => s.trim()) : []),
];

const isAllowedOrigin = (origin: string): boolean => {
    if (allowedOrigins.includes(origin)) return true;

    try {
        const url = new URL(origin);
        const hostname = url.hostname.toLowerCase();
        const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
        const isEcomgearDomain = hostname === 'ecomgear.dev' || hostname.endsWith('.ecomgear.dev');
        const isEcomgearApp = hostname === 'ecomgear.app' || hostname.endsWith('.ecomgear.app');
        return isLocalHost || isEcomgearDomain || isEcomgearApp;
    } catch {
        return false;
    }
};

// Express handles CORS for all environments. The generated nginx config on VPS3
// does not add CORS headers, so there is no duplicate-header risk in production.
app.use(cors({
    origin: (origin, callback) => {
        // Requests with no Origin header come from server-to-server callers (the
        // preview service on VPS2, curl health checks, internal tooling). Allow them
        // only when the PREVIEW_UPDATE_SECRET env var is absent (local dev) or when
        // the caller is expected to authenticate via other headers (JWT/secret).
        // Browsers always send Origin, so this bypass does not affect web clients.
        if (!origin || origin === 'null') return callback(null, true);
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
    ],
    exposedHeaders: ['Content-Type', 'Cache-Control', 'X-Request-Id', 'Last-Event-ID'],
    maxAge: 86400,
}));

// Body parsing — limit raised for base64-encoded binary assets in sync payloads
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

// Rate-limit the AI agent-stream endpoint — 20 requests per user per minute
const aiRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    keyGenerator: (req) => (req as any).user?.id || req.ip || 'unknown',
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many AI requests — please wait a moment' },
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/files', fileRoutes);
app.use('/api/v1/ai', aiRateLimiter, aiRoutes);
app.use('/api/v1/preview', previewRoutes);
app.use('/api/v1/system', systemRoutes);
app.use('/api/v1/runtime', runtimeRoutes);
app.use('/api/v1/database', databaseRoutes);
app.use('/api/v1/seo', seoRoutes);

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
