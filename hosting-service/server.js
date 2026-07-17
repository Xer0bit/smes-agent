/**
 * eComGear Hosting Service
 *
 * Serves published applications as static sites.
 * Manages Caddy configuration for custom domains with automatic HTTPS.
 * Provides DNS verification for domain ownership.
 * Runs on any VPS — public IP is configured via HOSTING_PUBLIC_IP env.
 *
 * Endpoints:
 *   POST   /deploy/:projectId       — Receive and store a published build
 *   DELETE /deploy/:projectId       — Remove a published build
 *   GET    /health                  — Health check
 *   POST   /domains/verify          — Verify DNS records for a custom domain
 *   POST   /domains/activate        — Activate a verified domain in Caddy
 *   DELETE /domains/:domain         — Remove a custom domain from Caddy
 *   GET    /domains/list            — List all active custom domain mappings
 *
 * Static serving:
 *   Caddy serves sites directly from /var/www/ecomgear/sites/<projectId>/
 *   This service manages the Caddy config and file deployments.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { execSync } = require('child_process');

// Tenant lifecycle modules
const dockerManager = require('./lib/docker-manager');
const portAllocator = require('./lib/port-allocator');
const tenantCaddy = require('./lib/tenant-caddy');

// ── Configuration ─────────────────────────────────────────────────────────────
const LOCAL_DEV = process.env.LOCAL_DEV === '1' || process.env.NODE_ENV === 'development';
const PORT = process.env.HOSTING_PORT || 4000;
const SITES_ROOT = process.env.SITES_ROOT || (LOCAL_DEV ? path.join(__dirname, '.local-sites') : '/var/www/ecomgear/sites');
const CADDY_CONFIG_DIR = process.env.CADDY_CONFIG_DIR || (LOCAL_DEV ? path.join(__dirname, '.local-caddy') : '/etc/caddy/sites');
const CADDY_MAIN_CONFIG = process.env.CADDY_MAIN_CONFIG || '/etc/caddy/Caddyfile';
const DEPLOY_SECRET = process.env.HOSTING_DEPLOY_SECRET || '';
const HOSTING_PUBLIC_IP = process.env.HOSTING_PUBLIC_IP || (LOCAL_DEV ? '127.0.0.1' : '');
const DEFAULT_DOMAIN = process.env.DEFAULT_DOMAIN || (LOCAL_DEV ? 'localhost.test' : 'apps.ecomgear.app');
const LETSENCRYPT_EMAIL = process.env.LETSENCRYPT_EMAIL || '';
const NODE_NAME = process.env.HOSTING_NODE_NAME || (LOCAL_DEV ? 'local-dev' : 'hosting-1');
const DNS_TXT_PREFIX = '_ecomgear-verify';

if (LOCAL_DEV) {
  console.log('\n  ⚡ LOCAL DEV MODE — Caddy reload skipped, DNS verification mocked\n');
} else {
  // Production safety: HOSTING_PUBLIC_IP is required for DNS verification and domain config.
  if (!HOSTING_PUBLIC_IP) {
    console.error('[FATAL] HOSTING_PUBLIC_IP env var is required in production. Exiting.');
    process.exit(1);
  }
}

// Ensure required directories exist
[SITES_ROOT, CADDY_CONFIG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Domain registry: domain → projectId ───────────────────────────────────────
const DOMAINS_FILE = path.join(SITES_ROOT, '.domains.json');
function loadDomainRegistry() {
  try {
    if (fs.existsSync(DOMAINS_FILE))
      return new Map(Object.entries(JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf-8'))));
  } catch (e) { console.error('[Domains] Load error:', e.message); }
  return new Map();
}
function saveDomainRegistry(map) {
  try {
    const tmpFile = DOMAINS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(map), null, 2));
    fs.renameSync(tmpFile, DOMAINS_FILE);
  } catch (e) { console.error('[Domains] Save error:', e.message); }
}
const domainRegistry = loadDomainRegistry();
console.log(`[Domains] Loaded ${domainRegistry.size} custom domain(s)`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function isValidProjectId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

function isValidDomain(d) {
  return typeof d === 'string' && d.length < 253 && DOMAIN_RE.test(d);
}

function authCheck(req, res) {
  if (!DEPLOY_SECRET) {
    if (LOCAL_DEV) return true;
    // Production: reject all mutating requests when no secret is configured
    console.error('[Auth] HOSTING_DEPLOY_SECRET not set — rejecting request');
    res.status(500).json({ error: 'Server misconfigured — deploy secret not set' });
    return false;
  }
  const token = req.headers['x-deploy-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== DEPLOY_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function log(tag, msg, details) {
  const d = details ? ` — ${JSON.stringify(details)}` : '';
  console.log(`[${tag}] ${msg}${d}`);
}

// ── DNS verification ──────────────────────────────────────────────────────────
function lookupDNS(domain, type) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);
    const method = type === 'A' ? 'resolve4' : type === 'TXT' ? 'resolveTxt' : type === 'CNAME' ? 'resolveCname' : 'resolve';
    resolver[method](domain, (err, records) => {
      if (err) return resolve([]);
      if (type === 'TXT') return resolve(records.flat());
      resolve(records || []);
    });
  });
}

// Known Cloudflare anycast IP prefixes (updated Apr 2026)
const CLOUDFLARE_IP_PREFIXES = [
  '172.64.', '172.65.', '172.66.', '172.67.', '172.68.', '172.69.', '172.70.', '172.71.',
  '104.16.', '104.17.', '104.18.', '104.19.', '104.20.', '104.21.', '104.22.', '104.23.',
  '104.24.', '104.25.', '104.26.', '104.27.', '104.28.', '104.29.', '104.30.', '104.31.',
  '141.101.', '108.162.', '190.93.', '188.114.', '197.234.', '198.41.',
  '162.158.', '162.159.', '103.21.244.', '103.22.200.', '103.31.4.',
];

function isCloudflareIP(ip) {
  return CLOUDFLARE_IP_PREFIXES.some(prefix => ip.startsWith(prefix));
}

function generateVerifyToken(domain) {
  // Deterministic token from domain — same as frontend
  return `ecg_${Buffer.from(domain).toString('base64').slice(0, 16)}`;
}

async function verifyDomainOwnership(domain) {
  if (!HOSTING_PUBLIC_IP) {
    return { verified: false, error: 'HOSTING_PUBLIC_IP not configured on this node' };
  }

  // Detect apex vs subdomain: apex = exactly 2 dot-separated parts
  const parts = domain.split('.');
  const isApex = parts.length <= 2;
  const hostPart = isApex ? null : parts.slice(0, parts.length - 2).join('.');

  // In local dev, skip real DNS lookups and auto-verify
  if (LOCAL_DEV) {
    const expectedToken = generateVerifyToken(domain);
    log('DNS', `Local dev — auto-verifying ${domain} (${isApex ? 'apex' : 'subdomain'})`);
    return {
      verified: true,
      domain_type: isApex ? 'apex' : 'subdomain',
      a_record: isApex ? { expected: '127.0.0.1', found: ['127.0.0.1'], ok: true } : undefined,
      cname_record: !isApex ? { expected: DEFAULT_DOMAIN, found: [DEFAULT_DOMAIN], ok: true } : undefined,
      txt_record: { expected: expectedToken, host: `${DNS_TXT_PREFIX}.${domain}`, found: [expectedToken], ok: true },
    };
  }

  const expectedToken = generateVerifyToken(domain);

  // TXT host differs for subdomains: _ecomgear-verify.<subdomain-part>.<root>
  const txtHost = isApex
    ? `${DNS_TXT_PREFIX}.${domain}`
    : `${DNS_TXT_PREFIX}.${hostPart}.${parts.slice(parts.length - 2).join('.')}`;

  let pointingOk = false;
  let pointingRecord;

  if (isApex) {
    // Apex domain: must have A record pointing to our IP
    const aRecords = await lookupDNS(domain, 'A');
    const cfProxied = aRecords.length > 0 && aRecords.every(ip => isCloudflareIP(ip));
    pointingOk = aRecords.includes(HOSTING_PUBLIC_IP);
    pointingRecord = {
      type: 'A',
      expected: HOSTING_PUBLIC_IP,
      found: aRecords,
      ok: pointingOk,
      ...(cfProxied && !pointingOk ? { cloudflare_proxied: true } : {}),
    };
  } else {
    // Subdomain: A record to our IP is the primary method.
    // Also accept CNAME to hosting.ecomgear.app for backward compat.
    const aRecords = await lookupDNS(domain, 'A');
    const cfProxied = aRecords.length > 0 && aRecords.every(ip => isCloudflareIP(ip));
    pointingOk = aRecords.includes(HOSTING_PUBLIC_IP);
    if (pointingOk) {
      pointingRecord = {
        type: 'A',
        expected: HOSTING_PUBLIC_IP,
        found: aRecords,
        ok: true,
      };
    } else {
      // Fallback: check CNAME (legacy users may still have CNAME to hosting.ecomgear.app)
      const cnameRecords = await lookupDNS(domain, 'CNAME');
      const cnameOk = cnameRecords.some(r => {
        const normalized = r.replace(/\.$/, '').toLowerCase();
        return normalized === 'hosting.ecomgear.app' || normalized === DEFAULT_DOMAIN.toLowerCase();
      });
      if (cnameOk) {
        pointingOk = true;
        pointingRecord = { type: 'A', expected: HOSTING_PUBLIC_IP, found: cnameRecords, ok: true };
      } else {
        pointingRecord = {
          type: 'A',
          expected: HOSTING_PUBLIC_IP,
          found: aRecords.length > 0 ? aRecords : cnameRecords,
          ok: false,
          ...(cfProxied ? { cloudflare_proxied: true } : {}),
        };
      }
    }
  }

  // Check TXT verification record
  const txtRecords = await lookupDNS(txtHost, 'TXT');
  const txtOk = txtRecords.some(r => r.trim() === expectedToken);

  const cfProxied = !!(pointingRecord.cloudflare_proxied);
  return {
    verified: pointingOk && txtOk,
    cloudflare_proxied: cfProxied,
    domain_type: isApex ? 'apex' : 'subdomain',
    a_record: pointingRecord,
    txt_record: { expected: expectedToken, host: txtHost, found: txtRecords, ok: txtOk },
  };
}

// ── Caddy config management ──────────────────────────────────────────────────
function writeCaddySiteConfig(domain, projectId) {
  const siteDir = path.join(SITES_ROOT, projectId);
  const configPath = path.join(CADDY_CONFIG_DIR, `${domain}.caddy`);
  // Only add explicit TLS directive in production with email configured.
  // Caddy's automatic HTTPS handles Let's Encrypt by default; the email
  // directive ensures renewal notifications are sent properly.
  const tlsLine = (!LOCAL_DEV && LETSENCRYPT_EMAIL) ? `\n  tls ${LETSENCRYPT_EMAIL}` : '';
  const config = `${domain} {${tlsLine}
  root * ${siteDir}
  encode gzip zstd
  file_server
  try_files {path} {path}/index.html /index.html

  header {
    X-Frame-Options "SAMEORIGIN"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  handle_errors {
    respond "{err.status_code} {err.status_text}" {err.status_code}
  }
}
`;
  fs.writeFileSync(configPath, config);
  log('Caddy', `Wrote config for ${domain} → ${projectId}`);
}

function removeCaddySiteConfig(domain) {
  const configPath = path.join(CADDY_CONFIG_DIR, `${domain}.caddy`);
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    log('Caddy', `Removed config for ${domain}`);
  }
}

function reloadCaddy() {
  if (LOCAL_DEV) {
    log('Caddy', 'Reload skipped (LOCAL_DEV)');
    return true;
  }
  try {
    execSync('caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1', {
      timeout: 10000,
    });
    log('Caddy', 'Reloaded successfully');
    return true;
  } catch (e) {
    log('Caddy', 'Reload failed', { error: e.message });
    return false;
  }
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
const ALLOWED_ORIGINS = [
  'https://www.ecomgear.dev',
  'https://ecomgear.dev',
  'http://localhost:8080',
  'http://localhost:5173',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(bodyParser.json({ limit: '50mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ecomgear-hosting',
    node: NODE_NAME,
    publicIp: HOSTING_PUBLIC_IP || null,
    sites: fs.readdirSync(SITES_ROOT).filter(f => !f.startsWith('.')).length,
    domains: domainRegistry.size,
    uptime: process.uptime(),
  });
});

// Config endpoint — frontend discovers the hosting node's public IP
app.get('/config', (_req, res) => {
  res.json({
    publicIp: HOSTING_PUBLIC_IP || null,
    defaultDomain: DEFAULT_DOMAIN,
    node: NODE_NAME,
  });
});

// ── Local dev: serve deployed sites at /sites/:projectId/* ────────────────────
if (LOCAL_DEV) {
  app.use('/sites', express.static(SITES_ROOT, { extensions: ['html'] }));
  app.get('/sites/:projectId/*', (req, res) => {
    // SPA fallback — serve index.html for any unmatched path
    const indexPath = path.join(SITES_ROOT, req.params.projectId, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.status(404).send('Not found');
  });
}

// ── Deploy a build ────────────────────────────────────────────────────────────
app.post('/deploy/:projectId', (req, res) => {
  if (!authCheck(req, res)) return;

  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  const { files, slug } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] is required' });
  }

  const siteDir = path.join(SITES_ROOT, projectId);
  log('Deploy', `${projectId} — ${files.length} files`);

  // Clean existing site dir and write new files
  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
  fs.mkdirSync(siteDir, { recursive: true });

  let written = 0;
  for (const file of files) {
    if (!file?.path || typeof file.content !== 'string') continue;
    // Sanitize path to prevent directory traversal
    const safePath = path.normalize(file.path).replace(/^(\.\.([\/\\]|$))+/, '');
    const fullPath = path.resolve(siteDir, safePath);
    // Final guard: resolved path must be inside the site directory
    if (!fullPath.startsWith(siteDir + path.sep) && fullPath !== siteDir) continue;
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (file.encoding === 'base64') {
      fs.writeFileSync(fullPath, Buffer.from(file.content, 'base64'));
    } else {
      fs.writeFileSync(fullPath, file.content);
    }
    written++;
  }

  log('Deploy', `${projectId} — wrote ${written} files to ${siteDir}`);

  // If a default domain mapping exists, update Caddy
  // Validate slug to prevent Caddy config injection
  const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  const defaultSubdomain = (slug && SLUG_RE.test(slug)) ? `${slug}.${DEFAULT_DOMAIN}` : null;
  if (defaultSubdomain) {
    writeCaddySiteConfig(defaultSubdomain, projectId);
    domainRegistry.set(defaultSubdomain, projectId);
    saveDomainRegistry(domainRegistry);
    reloadCaddy();
  }

  res.json({
    success: true,
    projectId,
    filesWritten: written,
    siteUrl: defaultSubdomain ? `https://${defaultSubdomain}` : null,
  });
});

// Remove a deployed project
app.delete('/deploy/:projectId', (req, res) => {
  if (!authCheck(req, res)) return;

  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  const siteDir = path.join(SITES_ROOT, projectId);
  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }

  // Remove all domain mappings for this project
  for (const [domain, pid] of domainRegistry.entries()) {
    if (pid === projectId) {
      removeCaddySiteConfig(domain);
      domainRegistry.delete(domain);
    }
  }
  saveDomainRegistry(domainRegistry);
  reloadCaddy();

  log('Deploy', `Removed ${projectId}`);
  res.json({ success: true });
});

// ── DNS Verification ──────────────────────────────────────────────────────────
app.post('/domains/verify', async (req, res) => {
  // No auth required — read-only DNS lookup, safe for public access.
  const { domain } = req.body || {};
  if (!domain || !isValidDomain(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }

  try {
    const result = await verifyDomainOwnership(domain);
    res.json(result);
  } catch (e) {
    log('DNS', 'Verification error', { domain, error: e.message });
    res.status(500).json({ error: 'DNS verification failed', detail: e.message });
  }
});

// ── Activate a verified domain ────────────────────────────────────────────────
app.post('/domains/activate', async (req, res) => {
  if (!authCheck(req, res)) return;

  const { domain, projectId, skipVerify } = req.body || {};
  if (!domain || !isValidDomain(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }
  if (!projectId || !isValidProjectId(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  const siteDir = path.join(SITES_ROOT, projectId);
  if (!fs.existsSync(siteDir)) {
    // Auto-create site directory so a domain can be activated before the first deploy.
    // Caddy needs a non-empty root to serve — write a placeholder until the project is published.
    fs.mkdirSync(siteDir, { recursive: true });
    const placeholder = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coming Soon</title><style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}.box{text-align:center;padding:2rem}h1{color:#111827;margin-bottom:.5rem}p{color:#6b7280}</style></head><body><div class="box"><h1>Coming Soon</h1><p>This site is being set up. Publish your project to go live.</p></div></body></html>`;
    fs.writeFileSync(path.join(siteDir, 'index.html'), placeholder);
    log('Domains', `Auto-created site dir for ${projectId} (no prior deploy)`);
  }

  // Require DNS verification before activating (unless explicitly skipped for default subdomains)
  if (!skipVerify) {
    try {
      const dnsResult = await verifyDomainOwnership(domain);
      if (!dnsResult.verified) {
        return res.status(400).json({
          error: 'DNS verification failed — configure your DNS records first',
          dns: dnsResult,
        });
      }
    } catch (e) {
      return res.status(500).json({ error: 'DNS check failed', detail: e.message });
    }
  }

  writeCaddySiteConfig(domain, projectId);
  domainRegistry.set(domain, projectId);
  saveDomainRegistry(domainRegistry);

  const reloaded = reloadCaddy();
  if (!reloaded) {
    // Roll back — config may be invalid
    removeCaddySiteConfig(domain);
    domainRegistry.delete(domain);
    saveDomainRegistry(domainRegistry);
    return res.status(500).json({ error: 'Caddy reload failed — domain not activated' });
  }

  log('Domains', `Activated ${domain} → ${projectId}`);
  res.json({ success: true, domain, projectId, sslStatus: 'provisioning' });
});

// ── Remove a custom domain ───────────────────────────────────────────────────
app.delete('/domains/:domain', (req, res) => {
  if (!authCheck(req, res)) return;

  const domain = req.params.domain;
  if (!isValidDomain(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }

  removeCaddySiteConfig(domain);
  domainRegistry.delete(domain);
  saveDomainRegistry(domainRegistry);
  reloadCaddy();

  log('Domains', `Removed ${domain}`);
  res.json({ success: true });
});

// ── List all domain mappings ──────────────────────────────────────────────────
app.get('/domains/list', (req, res) => {
  if (!authCheck(req, res)) return;
  const entries = [];
  for (const [domain, projectId] of domainRegistry.entries()) {
    entries.push({ domain, projectId });
  }
  res.json({ domains: entries });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Tenant Lifecycle Endpoints ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /tenants/provision
 * Create a full Docker stack (Postgres + PostgREST + Edge Runtime) for a project.
 * Body: { projectId, subdomain? }
 */
app.post('/tenants/provision', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId, subdomain } = req.body || {};
  if (!projectId || !isValidProjectId(projectId)) {
    return res.status(400).json({ error: 'Invalid projectId' });
  }

  // Check if already provisioned
  const existingPorts = portAllocator.get(projectId);
  if (existingPorts) {
    return res.status(409).json({ error: 'Tenant already provisioned', ports: existingPorts });
  }

  try {
    log('Tenant', `Provisioning ${projectId}`);
    const ports = await portAllocator.allocate(projectId);
    const dbName = `tenant_${projectId.split('-')[0]}`;
    const dbPassword = dockerManager.generateDbPassword();

    const result = await dockerManager.createTenantStack(projectId, {
      postgresPort: ports.postgres,
      postgrestPort: ports.postgrest,
      edgeRuntimePort: ports.edge,
      dbName,
      dbPassword,
    });

    // Set up default subdomain Caddy config if provided
    const defaultDomain = subdomain
      ? `${subdomain}.${DEFAULT_DOMAIN}`
      : `${projectId.split('-')[0]}.${DEFAULT_DOMAIN}`;

    tenantCaddy.writeTenantConfig(defaultDomain, projectId, {
      postgrestPort: ports.postgrest,
      edgeRuntimePort: ports.edge,
    });

    // Ensure site directory exists for static files
    const siteDir = path.join(SITES_ROOT, projectId);
    if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

    tenantCaddy.reloadCaddy();

    log('Tenant', `Provisioned ${projectId}`, { ports, domain: defaultDomain });
    res.json({
      success: true,
      projectId,
      ports,
      dbName,
      containerIds: result.containerIds,
      domain: defaultDomain,
      siteUrl: `https://${defaultDomain}`,
    });
  } catch (e) {
    log('Tenant', `Provision failed: ${e.message}`);
    // Cleanup on failure
    portAllocator.release(projectId);
    await dockerManager.destroyTenantStack(projectId, { removeData: true }).catch(() => {});
    res.status(500).json({ error: 'Provision failed', detail: e.message });
  }
});

/**
 * POST /tenants/:projectId/deploy
 * Deploy latest frontend build + optional edge functions.
 * Body: { files: [{path, content}], edgeFunctions?: [{name, code}] }
 */
app.post('/tenants/:projectId/deploy', (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  const ports = portAllocator.get(projectId);
  if (!ports) return res.status(404).json({ error: 'Tenant not provisioned' });

  const { files, edgeFunctions } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] is required' });
  }

  const siteDir = path.join(SITES_ROOT, projectId);

  // Write static files
  if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
  fs.mkdirSync(siteDir, { recursive: true });

  let written = 0;
  for (const file of files) {
    if (!file?.path || typeof file.content !== 'string') continue;
    const safePath = path.normalize(file.path).replace(/^(\.\.([\/\\]|$))+/, '');
    const fullPath = path.resolve(siteDir, safePath);
    if (!fullPath.startsWith(siteDir + path.sep) && fullPath !== siteDir) continue;
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
    written++;
  }

  // Write edge functions if provided
  const TENANT_DATA_ROOT = process.env.TENANT_DATA_ROOT || '/var/lib/ecomgear/tenants';
  if (Array.isArray(edgeFunctions) && edgeFunctions.length > 0) {
    const fnDir = path.join(TENANT_DATA_ROOT, projectId, 'functions');
    if (!fs.existsSync(fnDir)) fs.mkdirSync(fnDir, { recursive: true });
    for (const fn of edgeFunctions) {
      if (!fn?.name || typeof fn.code !== 'string') continue;
      const safeName = fn.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const fnPath = path.join(fnDir, safeName, 'index.ts');
      fs.mkdirSync(path.dirname(fnPath), { recursive: true });
      fs.writeFileSync(fnPath, fn.code);
    }
  }

  log('Tenant', `Deployed ${projectId} — ${written} files`);
  res.json({ success: true, projectId, filesWritten: written });
});

/**
 * POST /tenants/:projectId/suspend
 * Stop containers, keep data.
 */
app.post('/tenants/:projectId/suspend', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  try {
    await dockerManager.stopTenantStack(projectId);
    log('Tenant', `Suspended ${projectId}`);
    res.json({ success: true, status: 'suspended' });
  } catch (e) {
    res.status(500).json({ error: 'Suspend failed', detail: e.message });
  }
});

/**
 * POST /tenants/:projectId/resume
 * Restart previously suspended containers.
 */
app.post('/tenants/:projectId/resume', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  try {
    await dockerManager.startTenantStack(projectId);
    log('Tenant', `Resumed ${projectId}`);
    res.json({ success: true, status: 'running' });
  } catch (e) {
    res.status(500).json({ error: 'Resume failed', detail: e.message });
  }
});

/**
 * DELETE /tenants/:projectId
 * Full teardown — remove containers, data, Caddy config.
 */
app.delete('/tenants/:projectId', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  try {
    await dockerManager.destroyTenantStack(projectId, { removeData: true });
    portAllocator.release(projectId);

    // Remove site directory
    const siteDir = path.join(SITES_ROOT, projectId);
    if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });

    // Remove any domain configs for this tenant
    for (const [domain, pid] of domainRegistry.entries()) {
      if (pid === projectId) {
        tenantCaddy.removeTenantConfig(domain);
        removeCaddySiteConfig(domain);
        domainRegistry.delete(domain);
      }
    }
    saveDomainRegistry(domainRegistry);
    tenantCaddy.reloadCaddy();

    log('Tenant', `Destroyed ${projectId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Destroy failed', detail: e.message });
  }
});

/**
 * GET /tenants/:projectId/status
 * Container health, ports, domain status.
 */
app.get('/tenants/:projectId/status', (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  const ports = portAllocator.get(projectId);
  if (!ports) return res.status(404).json({ error: 'Tenant not provisioned' });

  const containers = dockerManager.getTenantStatus(projectId);
  res.json({ projectId, ports, containers });
});

/**
 * GET /tenants/list
 * All tenants on this hosting node with their ports.
 */
app.get('/tenants/list', (req, res) => {
  if (!authCheck(req, res)) return;
  const allPorts = portAllocator.listAll();
  const tenants = Object.entries(allPorts).map(([projectId, ports]) => ({
    projectId,
    ports,
    containers: dockerManager.getTenantStatus(projectId),
  }));
  res.json({ node: NODE_NAME, tenants });
});

/**
 * POST /tenants/:projectId/db/migrate
 * Run SQL migration on a tenant's Postgres.
 * Body: { sql }
 */
app.post('/tenants/:projectId/db/migrate', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  const { sql } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql is required' });

  try {
    await dockerManager.runMigration(projectId, sql);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Migration failed', detail: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const BIND_HOST = '0.0.0.0';
app.listen(PORT, BIND_HOST, () => {
  log('Server', `Hosting service running on ${BIND_HOST}:${PORT}`, {
    sites: SITES_ROOT,
    caddyConfig: CADDY_CONFIG_DIR,
    defaultDomain: DEFAULT_DOMAIN,
  });
});
