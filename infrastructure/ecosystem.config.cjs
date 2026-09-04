const path = require('path');
const fs = require('fs');
// VPS1: 156.67.218.75 (Singapore)   Frontend + Supabase Edge + API server
// VPS2: 72.62.126.99(Indonesia)   Preview Hosting + Generated Apps
// VPS3: 3.148.126.20 (USA)   LLM / Code Generation + Agent Runner (generation-only)
const ROOT = __dirname;
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || process.env.PORT || 3001);
const GEN_API_PORT = Number(process.env.GEN_API_PORT || process.env.PORT || 5001);
const API_SERVER_PORT = Number(process.env.API_SERVER_PORT || process.env.PORT || 5002);

// Reads a var straight out of .env.production so pm2 injects it into the
// process's real OS env at spawn time -- same reason SUPABASE_SERVICE_ROLE_KEY
// below is pulled in this way instead of trusting the app's own dotenv load:
// api-gateway is ESM + pm2 cluster mode, and its in-process `configDotenv`
// call was observed (2026-08-24) NOT reliably landing PREVIEW_UPDATE_SECRET in
// process.env at request time, causing every preview-update proxy call to go
// out with no x-update-secret header -> preview-service 401s. Root cause in
// the ESM/cluster env-loading path wasn't pinned down; this sidesteps it by
// never depending on it.
function readEnvFileVar(name) {
    // VPS1 (api-gateway) keeps .env.production at the repo root; VPS2
    // (preview-service) keeps its own copy one level down. Same file is
    // deployed to both, so check both layouts.
    const candidates = [
        path.join(ROOT, '.env.production'),
        path.join(ROOT, 'preview-service', '.env.production'),
    ];
    for (const file of candidates) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const m = content.match(new RegExp('^' + name + '=(.*)$', 'm'));
            if (m) return m[1];
        } catch {
            // try next candidate
        }
    }
    return '';
}
// The FILE wins over the ambient env, not the other way round.
//
// With the old `process.env.X || file` order, VPS3 ran for an unknown period
// with three different values in play: deploy.sh wrote the correct secret into
// .env.production, but a stale PREVIEW_UPDATE_SECRET already present in the pm2
// start environment took precedence, so SMEsAgent-gen sent a value matching
// neither its own env file nor VPS2's. Measured 2026-08-24 (sha256, distinct):
// deploy source fca5db..., VPS3 file fca5db..., VPS3 runtime a539b1...,
// VPS2 runtime 98c8e5... -- every preview push 401'd, and because the push
// retries burn the agent's remaining budget, runs then hit AGENT_TIMEOUT_MS and
// salvaged back to the pre-agent snapshot, discarding all generated work.
//
// deploy.sh writes .env.production on every deploy, so the file is the only
// value that is always current. An ambient env var, by contrast, can outlive
// any number of deploys and fails silently -- a 401 looks like an auth bug, not
// a stale-config bug. Reading the file first makes a deploy authoritative.
const PREVIEW_UPDATE_SECRET = readEnvFileVar('PREVIEW_UPDATE_SECRET') || process.env.PREVIEW_UPDATE_SECRET || '';

module.exports = {
    apps: [
        // ──────────────────────────────────────────────────────────
        //  Preview Service   VPS2
        //  Serves generated React apps via Vite HMR
        // ──────────────────────────────────────────────────────────
        {
            name: 'SMEsAgent-preview',
            script: path.join(ROOT, 'preview-service', 'server.js'),
            cwd: path.join(ROOT, 'preview-service'),
            instances: 1,
            exec_mode: 'fork',
            node_args: '--no-deprecation',
            wait_ready: true,       // wait for process.send('ready') before routing traffic
            listen_timeout: 15000,  // fallback timeout for ready signal
            env: {
                NODE_ENV: 'production',
                PORT: PREVIEW_PORT,
                VITE_HMR_HOST: 'preview.SMEsAgent.app',
                VITE_HMR_PORT: '443',
                VITE_HMR_PROTOCOL: 'wss',
                SUPABASE_URL: 'https://api.SMEsAgent.dev',
                SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
                PREVIEW_UPDATE_SECRET,
            },
            max_memory_restart: '2000M',
            error_file: path.join(ROOT, 'logs', 'preview-error.log'),
            out_file:   path.join(ROOT, 'logs', 'preview-out.log'),
            log_file:   path.join(ROOT, 'logs', 'preview-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            // Single fork instance, no overlap during restart -- port 3001 is
            // unbound for this whole delay on every restart (deploy or crash),
            // which nginx surfaces to users as a 502 (connect() refused).
            // Was 5000ms; the process itself binds in well under 1s.
            restart_delay: 300,
            exp_backoff_restart_delay: 100,
            kill_timeout: 20000,
        },

        // ──────────────────────────────────────────────────────────
        //  Gen / Agent Server   VPS3 (generation-only)
        //  Serves gen.SMEsAgent.dev + agent.SMEsAgent.dev (port 5001)
        //  SERVICE_ROLE=gen mounts only /api/v1/ai   every other route group
        //  lives on SMEsAgent-api (VPS1) instead. See server/src/app.ts.
        //  Cluster mode: 2 instances → pm2 reload gives true zero-downtime
        //  (new worker starts + signals ready, then old worker drains and exits)
        // ──────────────────────────────────────────────────────────
        {
            name: 'SMEsAgent-gen',
            script: path.join(ROOT, 'server', 'dist', 'index.js'),
            cwd: path.join(ROOT, 'server'),
            instances: 2,
            exec_mode: 'cluster',
            wait_ready: true,       // wait for process.send('ready') before routing traffic
            listen_timeout: 12000,  // fallback: mark ready after 12s even without signal
            shutdown_with_message: true, // use IPC for graceful shutdown in cluster mode
            env: {
                NODE_ENV: 'production',
                PORT: GEN_API_PORT,
                SERVICE_ROLE: 'gen',
                TENANT_DB_API_URL: 'https://cloud.SMEsAgent.app',
                PREVIEW_UPDATE_SECRET,
                // Lets a local dev frontend (npm run dev, default Vite port) call
                // this production server directly -- see server/src/app.ts's
                // allowedOrigins, which reads this env var when NODE_ENV=production
                // (where the hardcoded localhost list is otherwise excluded).
                CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:8080',
            },
            max_memory_restart: '2000M',
            error_file: path.join(ROOT, 'logs', 'gen-error.log'),
            out_file:   path.join(ROOT, 'logs', 'gen-out.log'),
            log_file:   path.join(ROOT, 'logs', 'gen-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 5000,
            exp_backoff_restart_delay: 100,
            kill_timeout: 20000,
        },

        // ──────────────────────────────────────────────────────────
        //  API Server   VPS1 (everything except LLM generation)
        //  Serves api.SMEsAgent.dev/api/v1/* (port 5002), fronted by the
        //  same nginx server block that proxies Supabase/Kong   see
        //  infrastructure/nginx/vps1-SMEsAgent.dev.conf's /api/v1/ location.
        //  SERVICE_ROLE=api mounts everything except /api/v1/ai.
        // ──────────────────────────────────────────────────────────
        {
            name: 'SMEsAgent-api',
            script: path.join(ROOT, 'server', 'dist', 'index.js'),
            cwd: path.join(ROOT, 'server'),
            instances: 2,
            exec_mode: 'cluster',
            wait_ready: true,
            listen_timeout: 12000,
            shutdown_with_message: true,
            env: {
                NODE_ENV: 'production',
                PORT: API_SERVER_PORT,
                SERVICE_ROLE: 'api',
                TENANT_DB_API_URL: 'https://cloud.SMEsAgent.app',
                PREVIEW_SERVICE_URL: process.env.PREVIEW_SERVICE_URL || 'https://preview.SMEsAgent.app',
                ECG_AUTH_BASE_URL: process.env.ECG_AUTH_BASE_URL || 'https://auth.SMEsAgent.ai',
                ECG_AUTH_API_KEY: process.env.ECG_AUTH_API_KEY || '',
                ECG_AUTH_2FA_ACTIVE: process.env.ECG_AUTH_2FA_ACTIVE || 'false',
                PREVIEW_UPDATE_SECRET,
                // Lets a local dev frontend (npm run dev, default Vite port) call
                // this production server directly -- see server/src/app.ts's
                // allowedOrigins, which reads this env var when NODE_ENV=production
                // (where the hardcoded localhost list is otherwise excluded).
                CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:8080',
            },
            max_memory_restart: '2000M',
            error_file: path.join(ROOT, 'logs', 'api-error.log'),
            out_file:   path.join(ROOT, 'logs', 'api-out.log'),
            log_file:   path.join(ROOT, 'logs', 'api-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 5000,
            exp_backoff_restart_delay: 100,
            kill_timeout: 20000,
        },
    ],
};

