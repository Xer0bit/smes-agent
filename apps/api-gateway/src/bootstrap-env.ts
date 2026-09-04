/**
 * Load every env file BEFORE any application module evaluates.
 *
 * This file must stay the FIRST import of index.ts, and must itself import
 * nothing from src/. ESM hoists and fully evaluates every static import before
 * a single top-level statement runs, so when these configDotenv() calls lived
 * as statements in index.ts, the entire ./app.js import graph — the winston
 * logger included — had already evaluated against whatever env pm2 happened to
 * inject at fork. Winston froze at level 'info' because LOG_LEVEL only existed
 * in .env.production, which was read twelve lines too late (proven at runtime
 * on VPS3, 2026-08-30: logger stuck at info with LOG_LEVEL=debug on line 38 of
 * the deployed .env.production).
 *
 * Production only worked at all because deploy.sh's remote script does
 * `set -a && . ./.env.production` before `pm2 start`, so pm2's cluster wrapper
 * injected a snapshot of the file into the child. That snapshot goes stale the
 * moment the file is edited without a redeploy — pm2 restart --update-env was
 * observed NOT to refresh it (same class of failure ecosystem.config.cjs:14
 * documents for PREVIEW_UPDATE_SECRET). This module removes that dependency:
 * the file itself is authoritative on every boot.
 *
 * A side-effect import evaluates before later imports, which is the entire
 * mechanism — do not convert this to a function someone has to remember to
 * call.
 */
import { configDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/bootstrap-env.js -> server/dist -> ROOT = /var/www/SMEsAgent on a host;
// identical resolution to what index.ts used, so paths do not change.
const ROOT = path.resolve(__dirname, '..', '..');

// Same three loads, same order, same override semantics as before — only the
// timing moves. CWD .env first (what `import 'dotenv/config'` did), then
// .env.local (local dev overrides), then .env.production (server secrets that
// survive pm2 restarts). override:false throughout: earlier wins.
configDotenv({ override: false });
configDotenv({ path: path.join(ROOT, '.env.local'), override: false });
configDotenv({ path: path.join(ROOT, '.env.production'), override: false });
