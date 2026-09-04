/**
 * Port Allocator   assigns unique host ports per tenant.
 *
 * Strategy: base port + sequential offset.
 *   Postgres:      10000 + (offset * 10) + 0
 *   PostgREST:     10000 + (offset * 10) + 1
 *   Edge Runtime:  10000 + (offset * 10) + 2
 *
 * The offset is derived from the count of existing tenants on this server.
 * A .ports.json file persists allocations across restarts.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');

const BASE_PORT = parseInt(process.env.TENANT_PORT_BASE || '10000', 10);
const PORT_STRIDE = 10; // ports reserved per tenant
const LOCAL_DEV = process.env.LOCAL_DEV === '1' || process.env.NODE_ENV === 'development';
const SITES_ROOT = process.env.SITES_ROOT || (LOCAL_DEV ? path.join(__dirname, '..', '.local-sites') : '/var/www/SMEsAgent/sites');

const PORTS_FILE = path.join(SITES_ROOT, '.ports.json');

function loadPortMap() {
  try {
    if (fs.existsSync(PORTS_FILE)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(PORTS_FILE, 'utf-8'))));
    }
  } catch (e) {
    console.error('[Ports] Load error:', e.message);
  }
  return new Map();
}

function savePortMap(map) {
  try {
    const dir = path.dirname(PORTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PORTS_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch (e) {
    console.error('[Ports] Save error:', e.message);
  }
}

const portMap = loadPortMap(); // projectId -> { postgres, postgrest, edge }

/**
 * Check if a port is available on the host.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Allocate ports for a new tenant.
 * Returns { postgres, postgrest, edge } port numbers.
 */
async function allocate(projectId) {
  // Already allocated?
  if (portMap.has(projectId)) {
    return portMap.get(projectId);
  }

  // Find next available offset
  const usedOffsets = new Set();
  for (const [, ports] of portMap) {
    const offset = Math.floor((ports.postgres - BASE_PORT) / PORT_STRIDE);
    usedOffsets.add(offset);
  }

  let offset = 0;
  while (usedOffsets.has(offset)) offset++;

  const ports = {
    postgres:  BASE_PORT + (offset * PORT_STRIDE),
    postgrest: BASE_PORT + (offset * PORT_STRIDE) + 1,
    edge:      BASE_PORT + (offset * PORT_STRIDE) + 2,
  };

  // Verify ports are actually available
  for (const [svc, port] of Object.entries(ports)) {
    const available = await isPortAvailable(port);
    if (!available) {
      throw new Error(`Port ${port} (${svc}) is already in use`);
    }
  }

  portMap.set(projectId, ports);
  savePortMap(portMap);
  console.log(`[Ports] Allocated for ${projectId}: pg=${ports.postgres} pgr=${ports.postgrest} edge=${ports.edge}`);
  return ports;
}

/**
 * Release ports for a removed tenant.
 */
function release(projectId) {
  if (portMap.has(projectId)) {
    const ports = portMap.get(projectId);
    portMap.delete(projectId);
    savePortMap(portMap);
    console.log(`[Ports] Released for ${projectId}: pg=${ports.postgres} pgr=${ports.postgrest} edge=${ports.edge}`);
  }
}

/**
 * Get ports for an existing tenant.
 */
function get(projectId) {
  return portMap.get(projectId) || null;
}

/**
 * Get all allocations.
 */
function listAll() {
  return Object.fromEntries(portMap);
}

module.exports = {
  allocate,
  release,
  get,
  listAll,
};
