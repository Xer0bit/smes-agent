const path = require('path');

// Single-server target: one box runs every process the 5-VPS layout used to
// split across machines. Source .env.production into the shell before
// `pm2 start` (matches scripts/deploy.sh's existing convention) — pm2 then
// inherits it via process.env below, same as the per-VPS ecosystem files did.
//
// Removed from the old ecosystem.config.cjs: the readEnvFileVar() workaround
// for PREVIEW_UPDATE_SECRET drifting between VPS2's and VPS3's copies of
// .env.production. That bug was two machines disagreeing about one file's
// contents — with one machine and one file there's nothing left to drift.
const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
    apps: [
        // SERVICE_ROLE left unset → defaults to 'all' (apps/api-gateway/src/app.ts)
        // mounts every route group in one process: what used to be
        // SMEsAgent-api (VPS1, :5002) and SMEsAgent-gen (VPS3, :5001).
        {
            name: 'ecg-api',
            script: path.join(ROOT, 'apps', 'api-gateway', 'dist', 'index.js'),
            cwd: path.join(ROOT, 'apps', 'api-gateway'),
            instances: 2,
            exec_mode: 'cluster',
            wait_ready: true,
            listen_timeout: 12000,
            shutdown_with_message: true,
            env: {
                NODE_ENV: 'production',
                PORT: 5001,
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

        {
            name: 'ecg-preview',
            script: path.join(ROOT, 'apps', 'preview-service', 'server.js'),
            cwd: path.join(ROOT, 'apps', 'preview-service'),
            instances: 1,
            exec_mode: 'fork',
            node_args: '--no-deprecation',
            wait_ready: true,
            listen_timeout: 15000,
            env: {
                NODE_ENV: 'production',
                PORT: 3001,
            },
            max_memory_restart: '2000M',
            error_file: path.join(ROOT, 'logs', 'preview-error.log'),
            out_file:   path.join(ROOT, 'logs', 'preview-out.log'),
            log_file:   path.join(ROOT, 'logs', 'preview-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 300,
            exp_backoff_restart_delay: 100,
            kill_timeout: 20000,
        },

        {
            name: 'ecg-hosting',
            script: path.join(ROOT, 'apps', 'hosting-service', 'server.js'),
            cwd: path.join(ROOT, 'apps', 'hosting-service'),
            instances: 1,
            exec_mode: 'fork',
            env: {
                NODE_ENV: 'production',
                HOSTING_PORT: 4000,
                HOSTING_PUBLIC_IP: process.env.HOSTING_PUBLIC_IP || '',
                SITES_ROOT: '/var/www/ecomgear/sites',
                CADDY_CONFIG_DIR: '/etc/caddy/sites',
                CADDY_MAIN_CONFIG: '/etc/caddy/Caddyfile',
            },
            max_memory_restart: '1000M',
            error_file: path.join(ROOT, 'logs', 'hosting-error.log'),
            out_file:   path.join(ROOT, 'logs', 'hosting-out.log'),
            log_file:   path.join(ROOT, 'logs', 'hosting-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 2000,
        },

        {
            name: 'ecg-tenant-functions',
            script: path.join(ROOT, 'apps', 'tenant-functions-runner', 'server.js'),
            cwd: path.join(ROOT, 'apps', 'tenant-functions-runner'),
            instances: 1,
            exec_mode: 'fork',
            env: {
                NODE_ENV: 'production',
                PORT: 4001,
                TENANT_DB_HOST: '127.0.0.1',
                TENANT_DB_PORT: 5432,
            },
            max_memory_restart: '500M',
            error_file: path.join(ROOT, 'logs', 'tenant-functions-error.log'),
            out_file:   path.join(ROOT, 'logs', 'tenant-functions-out.log'),
            log_file:   path.join(ROOT, 'logs', 'tenant-functions-combined.log'),
            time: true,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 2000,
        },
    ],
};
