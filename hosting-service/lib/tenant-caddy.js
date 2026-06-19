/**
 * Tenant Caddy Config — generates per-tenant Caddy config snippets.
 *
 * Each tenant gets a single-domain config with path-based routing:
 *   /rest/v1/*      → PostgREST
 *   /functions/v1/* → Edge Runtime
 *   /*              → static files (SPA)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOCAL_DEV = process.env.LOCAL_DEV === '1' || process.env.NODE_ENV === 'development';
const CADDY_CONFIG_DIR = process.env.CADDY_CONFIG_DIR || (LOCAL_DEV ? path.join(__dirname, '..', '.local-caddy') : '/etc/caddy/sites');
const SITES_ROOT = process.env.SITES_ROOT || (LOCAL_DEV ? path.join(__dirname, '..', '.local-sites') : '/var/www/ecomgear/sites');

/**
 * Write a Caddy config for a tenant's domain.
 * Handles static files + reverse-proxy to PostgREST and Edge Runtime.
 */
function writeTenantConfig(domain, projectId, { postgrestPort, edgeRuntimePort }) {
  const siteDir = path.join(SITES_ROOT, projectId);
  const configPath = path.join(CADDY_CONFIG_DIR, `tenant-${domain}.caddy`);

  const config = `# Tenant: ${projectId}
${domain} {
  # PostgREST API
  handle_path /rest/v1/* {
    reverse_proxy 127.0.0.1:${postgrestPort} {
      header_up X-Tenant-Id "${projectId}"
    }
  }

  # Edge Functions
  handle_path /functions/v1/* {
    reverse_proxy 127.0.0.1:${edgeRuntimePort} {
      header_up X-Tenant-Id "${projectId}"
    }
  }

  # Static frontend (SPA)
  handle {
    root * ${siteDir}
    encode gzip zstd
    try_files {path} /index.html
    file_server
  }

  header {
    X-Frame-Options "SAMEORIGIN"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    X-Tenant-Id "${projectId}"
    -Server
  }

  handle_errors {
    respond "{err.status_code} {err.status_text}" {err.status_code}
  }
}
`;

  if (!fs.existsSync(CADDY_CONFIG_DIR)) {
    fs.mkdirSync(CADDY_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(configPath, config);
  console.log(`[TenantCaddy] Wrote config for ${domain} → ${projectId}`);
}

/**
 * Remove a tenant's Caddy config.
 */
function removeTenantConfig(domain) {
  const configPath = path.join(CADDY_CONFIG_DIR, `tenant-${domain}.caddy`);
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    console.log(`[TenantCaddy] Removed config for ${domain}`);
  }
}

/**
 * Reload Caddy to pick up config changes.
 */
function reloadCaddy() {
  if (LOCAL_DEV) {
    console.log('[TenantCaddy] Reload skipped (LOCAL_DEV)');
    return true;
  }
  try {
    execSync('caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1', {
      timeout: 10_000,
    });
    console.log('[TenantCaddy] Reloaded successfully');
    return true;
  } catch (e) {
    console.error('[TenantCaddy] Reload failed:', e.message);
    return false;
  }
}

/**
 * Write config and reload in one step. Rolls back on reload failure.
 */
function activateTenantDomain(domain, projectId, ports) {
  writeTenantConfig(domain, projectId, ports);
  const ok = reloadCaddy();
  if (!ok) {
    removeTenantConfig(domain);
    return false;
  }
  return true;
}

module.exports = {
  writeTenantConfig,
  removeTenantConfig,
  reloadCaddy,
  activateTenantDomain,
};
