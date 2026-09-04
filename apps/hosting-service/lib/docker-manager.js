/**
 * Docker Manager   creates/removes/controls tenant Docker containers.
 *
 * Each tenant gets 3 containers:
 *   ecg-{shortId}-postgres       Postgres 16
 *   ecg-{shortId}-postgrest      PostgREST (REST API on top of Postgres)
 *   ecg-{shortId}-edge           Supabase Edge Runtime (edge functions)
 *
 * All containers share the bridge network `ecg-tenant-net`.
 */

const { execSync, exec } = require('child_process');
const crypto = require('crypto');

const NETWORK_NAME = 'ecg-tenant-net';
const TENANT_DATA_ROOT = process.env.TENANT_DATA_ROOT || '/var/lib/SMEsAgent/tenants';
const LOCAL_DEV = process.env.LOCAL_DEV === '1' || process.env.NODE_ENV === 'development';

// Docker images
const IMAGES = {
  postgres: 'postgres:16-alpine',
  postgrest: 'postgrest/postgrest:v12.2.3',
  edge: 'supabase/edge-runtime:v1.62.2',
};

// Resource limits per container
const LIMITS = {
  postgres:  { memory: '512m', cpus: '0.5' },
  postgrest: { memory: '128m', cpus: '0.25' },
  edge:      { memory: '256m', cpus: '0.5' },
};

function shortId(projectId) {
  return projectId.split('-')[0];
}

function containerName(projectId, service) {
  return `ecg-${shortId(projectId)}-${service}`;
}

function run(cmd) {
  if (LOCAL_DEV) {
    console.log(`[Docker-DRY] ${cmd}`);
    return '';
  }
  return execSync(cmd, { encoding: 'utf-8', timeout: 60_000 }).trim();
}

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    if (LOCAL_DEV) {
      console.log(`[Docker-DRY] ${cmd}`);
      return resolve('');
    }
    exec(cmd, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// ── Network ────────────────────────────────────────────────────────────────
function ensureNetwork() {
  try {
    run(`docker network inspect ${NETWORK_NAME} > /dev/null 2>&1`);
  } catch {
    run(`docker network create ${NETWORK_NAME}`);
  }
}

// ── Container lifecycle ────────────────────────────────────────────────────

/**
 * Create the full Docker stack for a tenant.
 * Returns { containerId: { postgres, postgrest, edge }, dbPassword }
 */
async function createTenantStack(projectId, { postgresPort, postgrestPort, edgeRuntimePort, dbName, dbPassword }) {
  ensureNetwork();

  const pgContainer = containerName(projectId, 'postgres');
  const pgrContainer = containerName(projectId, 'postgrest');
  const edgeContainer = containerName(projectId, 'edge');
  const dataDir = `${TENANT_DATA_ROOT}/${projectId}/pgdata`;
  const edgeFunctionsDir = `${TENANT_DATA_ROOT}/${projectId}/functions`;

  // Ensure data dirs
  run(`mkdir -p "${dataDir}" "${edgeFunctionsDir}"`);

  // 1. Postgres
  const pgCmd = [
    'docker run -d',
    `--name ${pgContainer}`,
    `--network ${NETWORK_NAME}`,
    `--restart unless-stopped`,
    `-e POSTGRES_DB=${dbName}`,
    `-e POSTGRES_USER=${dbName}`,
    `-e POSTGRES_PASSWORD=${dbPassword}`,
    `-p 127.0.0.1:${postgresPort}:5432`,
    `-v ${dataDir}:/var/lib/postgresql/data`,
    `--memory=${LIMITS.postgres.memory}`,
    `--cpus=${LIMITS.postgres.cpus}`,
    IMAGES.postgres,
  ].join(' ');
  const pgId = await runAsync(pgCmd);

  // Wait for Postgres to be ready (up to 30s)
  await waitForPostgres(pgContainer, dbName, dbPassword);

  // 2. PostgREST
  const pgrCmd = [
    'docker run -d',
    `--name ${pgrContainer}`,
    `--network ${NETWORK_NAME}`,
    `--restart unless-stopped`,
    `-e PGRST_DB_URI=postgres://${dbName}:${dbPassword}@${pgContainer}:5432/${dbName}`,
    `-e PGRST_DB_SCHEMAS=public`,
    `-e PGRST_DB_ANON_ROLE=anon`,
    `-p 127.0.0.1:${postgrestPort}:3000`,
    `--memory=${LIMITS.postgrest.memory}`,
    `--cpus=${LIMITS.postgrest.cpus}`,
    IMAGES.postgrest,
  ].join(' ');
  const pgrId = await runAsync(pgrCmd);

  // 3. Edge Runtime
  const edgeCmd = [
    'docker run -d',
    `--name ${edgeContainer}`,
    `--network ${NETWORK_NAME}`,
    `--restart unless-stopped`,
    `-e SUPABASE_URL=http://${pgrContainer}:3000`,
    `-v ${edgeFunctionsDir}:/home/deno/functions`,
    `-p 127.0.0.1:${edgeRuntimePort}:9000`,
    `--memory=${LIMITS.edge.memory}`,
    `--cpus=${LIMITS.edge.cpus}`,
    IMAGES.edge,
    'start --main-service /home/deno/functions/main',
  ].join(' ');
  const edgeId = await runAsync(edgeCmd);

  // Create initial anon role in Postgres for PostgREST
  await initTenantDb(pgContainer, dbName, dbPassword);

  return {
    containerIds: { postgres: pgId, postgrest: pgrId, edge: edgeId },
    dbPassword,
  };
}

/**
 * Wait for Postgres container to accept connections.
 */
async function waitForPostgres(containerName, dbName, dbPassword, maxWait = 30) {
  for (let i = 0; i < maxWait; i++) {
    try {
      run(`docker exec ${containerName} pg_isready -U ${dbName} -d ${dbName} -q`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`Postgres container ${containerName} did not become ready in ${maxWait}s`);
}

/**
 * Create initial DB roles and schema for PostgREST.
 */
async function initTenantDb(pgContainerName, dbName, dbPassword) {
  const sql = `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
  `;
  const escaped = sql.replace(/"/g, '\\"');
  run(`docker exec ${pgContainerName} psql -U "${dbName}" -d "${dbName}" -c "${escaped}"`);
}

/**
 * Stop all containers for a tenant (keep data).
 */
async function stopTenantStack(projectId) {
  const services = ['edge', 'postgrest', 'postgres'];
  for (const svc of services) {
    const name = containerName(projectId, svc);
    try { await runAsync(`docker stop ${name}`); } catch { /* may not exist */ }
  }
}

/**
 * Start previously stopped containers.
 */
async function startTenantStack(projectId) {
  const services = ['postgres', 'postgrest', 'edge'];
  for (const svc of services) {
    const name = containerName(projectId, svc);
    try { await runAsync(`docker start ${name}`); } catch { /* may not exist */ }
  }
  // Wait for postgres before others fully connect
  const pgName = containerName(projectId, 'postgres');
  await waitForPostgres(pgName, '', '', 15).catch(() => {});
}

/**
 * Destroy all containers and optionally data for a tenant.
 */
async function destroyTenantStack(projectId, { removeData = false } = {}) {
  const services = ['edge', 'postgrest', 'postgres'];
  for (const svc of services) {
    const name = containerName(projectId, svc);
    try { await runAsync(`docker rm -f ${name}`); } catch { /* may not exist */ }
  }
  if (removeData) {
    const dataDir = `${TENANT_DATA_ROOT}/${projectId}`;
    run(`rm -rf "${dataDir}"`);
  }
}

/**
 * Get container status and health.
 */
function getTenantStatus(projectId) {
  const result = {};
  const services = ['postgres', 'postgrest', 'edge'];
  for (const svc of services) {
    const name = containerName(projectId, svc);
    try {
      const state = run(`docker inspect --format='{{.State.Status}}' ${name}`);
      const health = run(`docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ${name}`);
      result[svc] = { status: state, health };
    } catch {
      result[svc] = { status: 'not_found', health: 'none' };
    }
  }
  return result;
}

/**
 * Run a SQL migration on a tenant's Postgres container.
 */
async function runMigration(projectId, sql) {
  const pgName = containerName(projectId, 'postgres');
  // Use stdin to avoid shell escaping issues
  const { execSync } = require('child_process');
  if (LOCAL_DEV) {
    console.log(`[Docker-DRY] Migrate on ${pgName}: ${sql.slice(0, 100)}…`);
    return;
  }
  execSync(`echo "${sql.replace(/"/g, '\\"')}" | docker exec -i ${pgName} psql -U postgres`, {
    timeout: 30_000,
  });
}

/**
 * Generate a strong random DB password.
 */
function generateDbPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  ensureNetwork,
  createTenantStack,
  stopTenantStack,
  startTenantStack,
  destroyTenantStack,
  getTenantStatus,
  runMigration,
  generateDbPassword,
  containerName,
  IMAGES,
};
