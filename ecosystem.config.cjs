const path = require('path');
// VPS2: 72.62.126.99(Indonesia) — Preview Hosting + Generated Apps
// VPS3: 3.148.126.20 (USA) — LLM / Code Generation + Agent Runner
const ROOT = __dirname;
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || process.env.PORT || 3001);
const GEN_API_PORT = Number(process.env.GEN_API_PORT || process.env.PORT || 5001);

module.exports = {
    apps: [
        // ──────────────────────────────────────────────────────────
        //  Preview Service — VPS2
        //  Serves generated React apps via Vite HMR
        // ──────────────────────────────────────────────────────────
        {
            name: 'ecomgear-preview',
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
                VITE_HMR_HOST: 'preview.ecomgear.app',
                VITE_HMR_PORT: '443',
                VITE_HMR_PROTOCOL: 'wss',
                SUPABASE_URL: 'https://api.ecomgear.dev',
                SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
            },
            max_memory_restart: '2000M',
            error_file: path.join(ROOT, 'logs', 'preview-error.log'),
            out_file:   path.join(ROOT, 'logs', 'preview-out.log'),
            log_file:   path.join(ROOT, 'logs', 'preview-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 5000,
            exp_backoff_restart_delay: 100,
            kill_timeout: 20000,
        },

        // ──────────────────────────────────────────────────────────
        //  API / Gen Server — VPS3
        //  Serves gen.ecomgear.dev + agent.ecomgear.dev (port 5001)
        //  Cluster mode: 2 instances → pm2 reload gives true zero-downtime
        //  (new worker starts + signals ready, then old worker drains and exits)
        // ──────────────────────────────────────────────────────────
        {
            name: 'ecomgear-gen',
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
                TENANT_DB_API_URL: 'https://db.ecomgear.app',
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
    ],
};

