# eComGear Multi-Server Tenant Hosting   Setup & Admin Guide

## Overview

The hosting system lets you publish eComGear projects as isolated, production-ready applications on VPS servers. Each tenant gets its own Postgres database, PostgREST API, Edge Runtime, and static file serving   all managed through Docker containers and Caddy reverse proxy.

**Architecture:**
- **VPS1**   Frontend + Supabase (central DB with `hosting_servers`, `tenant_deployments`, `tenant_domains` tables)
- **VPS4+**   Hosting nodes running the hosting-service (Express on port 4000), Docker, and Caddy
- **Admin Panel**   React pages at `/admin/hosting`, `/admin/servers`, `/admin/tenant/:projectId`

---

## 1. Local Development Setup

### Prerequisites
- Node.js 20+
- Supabase CLI (`supabase start` running locally)
- Docker (optional   local dev mode dry-runs container commands)

### Quick Start

```bash
# 1. Apply database migrations
supabase db push --local

# 2. Install hosting-service deps
cd hosting-service && npm install

# 3. Start hosting service in dev mode (port 4000)
npm run dev
# Or: bash start-local.sh

# 4. Start frontend (port 8080)
cd .. && npm run dev
```

### Or use the all-in-one script:
```bash
./start-dev.sh
```
This starts Supabase, Preview Service, Hosting Service, and Frontend together.

### Local Dev Mode Behavior

When `NODE_ENV=development` or `LOCAL_DEV=1`:
- **Docker commands are dry-run**   logged to console but not executed
- **Caddy reload is skipped**   config files are written but not loaded
- **DNS verification auto-passes**   no real DNS checks needed
- **Files stored in** `hosting-service/.local-sites/`
- **Caddy configs written to** `hosting-service/.local-caddy/`

### Environment Variables (`.env.local`)

```bash
VITE_HOSTING_SERVICE_URL="http://localhost:4000"
```

This is already configured in the existing `.env.local` file.

---

## 2. Admin Panel   Server Management

Navigate to **Admin → Hosting Servers** (`/admin/servers`).

### Adding a VPS Hosting Node

1. Click **"Add Server"**
2. Fill in:
   - **Name**   Friendly label (e.g., "VPS4-Singapore")
   - **IP Address**   Public IP of the VPS
   - **SSH User**   Usually `root`
   - **Region**   Geographic region label
   - **Service Port**   Hosting service port (default: 4000)
   - **API Key**   The `HOSTING_DEPLOY_SECRET` configured on that VPS
   - **Max Tenants**   Capacity limit (default: 20)
3. Click **"Add Server"** to save

The server record is stored in the `hosting_servers` table.

### Testing Connectivity

Click the **"Test"** button next to a server. This calls the `/health` endpoint on the VPS and shows connectivity status.

### Server Status

- **Online**   Accepting new tenant deployments
- **Maintenance**   Existing tenants keep running, no new deployments
- Toggle via the status button on each server row

### Server Stats Dashboard

The top cards show:
- **Total Servers**   All registered hosting nodes
- **Online**   Currently accepting deployments
- **Total Tenants**   Sum of all deployed tenants across all nodes
- **Available Slots**   Remaining capacity (`max_tenants - current_tenants`)

---

## 3. Admin Panel   Tenant Deployments

Navigate to **Admin → Hosting** (`/admin/hosting`).

### Viewing Deployments

The Tenant Deployments table shows all published projects with:
- Project name
- Hosting server
- Status badge (active/suspended/provisioning/failed)
- Domain
- Port assignments (Postgres/PostgREST/Edge)
- Deployment date

### Suspend / Resume

- **Suspend**   Stops all Docker containers for a tenant. Data is preserved. Click the pause button.
- **Resume**   Restarts all containers. Click the play button.

### Tenant Detail

Click a tenant row or navigate to `/admin/tenant/:projectId` to see:
- Server info (name, IP, region)
- Domain and SSL status
- Database connection details
- Individual container status (postgres/postgrest/edge)
- Lifecycle actions: Suspend, Resume, Destroy

### Destroying a Tenant

In the Tenant Detail page, click **"Destroy Tenant"**. This:
1. Removes all Docker containers
2. Deletes persistent data volumes
3. Removes Caddy configuration
4. Releases allocated ports
5. Deletes the deployment record

**This action is irreversible.**

---

## 4. Publishing a Project (Programmatic Flow)

The publish pipeline in `src/eCG/Publish/domainService.ts` provides:

### Step 1: Pick a Server
```typescript
const servers = await domainService.getAvailableServers();
const server = await domainService.pickServer(); // Auto round-robin / least-loaded
```

### Step 2: Provision Tenant
```typescript
const result = await domainService.provisionTenant(projectId, serverId, 'my-app');
// Returns: { ports, domain, containerIds }
```

### Step 3: Deploy
```typescript
await domainService.deployToTenant(projectId, files, edgeFunctions);
// files: Array<{ path: string, content: string }>
```

### Step 4: Check Status
```typescript
const status = await domainService.getTenantStatus(projectId);
// Returns: { exists, status, domain, serverId }
```

---

## 5. Hosting Service API Reference

All endpoints require `Authorization: Bearer <HOSTING_DEPLOY_SECRET>` in production. In local dev mode, auth is skipped.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check   returns status, site count, domain count, uptime |
| `POST` | `/tenants/provision` | Create new tenant stack (Postgres + PostgREST + Edge) |
| `POST` | `/tenants/:id/deploy` | Deploy frontend files + optional edge functions |
| `POST` | `/tenants/:id/suspend` | Stop all tenant containers |
| `POST` | `/tenants/:id/resume` | Restart all tenant containers |
| `DELETE` | `/tenants/:id` | Destroy tenant (containers + data) |
| `GET` | `/tenants/:id/status` | Get container status and port info |
| `GET` | `/tenants/list` | List all provisioned tenants |
| `POST` | `/tenants/:id/db/migrate` | Run SQL migration on tenant's Postgres |
| `POST` | `/deploy/:id` | Deploy static site files (non-tenant) |
| `DELETE` | `/deploy/:id` | Remove static site |
| `POST` | `/domains/verify` | Verify DNS records for custom domain |
| `POST` | `/domains/activate` | Activate custom domain in Caddy |
| `DELETE` | `/domains/:domain` | Remove custom domain |
| `GET` | `/domains/list` | List all active domain mappings |

### Example: Provision a Tenant

```bash
curl -X POST http://localhost:4000/tenants/provision \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "550e8400-e29b-41d4-a716-446655440000",
    "subdomain": "my-store"
  }'
```

Response:
```json
{
  "success": true,
  "projectId": "550e8400-e29b-41d4-a716-446655440000",
  "ports": { "postgres": 10000, "postgrest": 10001, "edge": 10002 },
  "dbName": "tenant_550e8400",
  "containerIds": { "postgres": "abc123...", "postgrest": "def456...", "edge": "ghi789..." },
  "domain": "my-store.apps.ecomgear.app",
  "siteUrl": "https://my-store.apps.ecomgear.app"
}
```

### Example: Deploy Files

```bash
curl -X POST http://localhost:4000/tenants/550e8400-e29b-41d4-a716-446655440000/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {"path": "index.html", "content": "<html>...</html>"},
      {"path": "assets/app.js", "content": "..."}
    ],
    "edgeFunctions": [
      {"name": "hello", "code": "Deno.serve(() => new Response(\"Hello\"))"}
    ]
  }'
```

---

## 6. Production VPS Bootstrap

To set up a new hosting VPS node:

```bash
# From your local machine
./scripts/bootstrap-hosting-server.sh <VPS_IP> [SSH_USER]

# Example
./scripts/bootstrap-hosting-server.sh 187.77.157.231 root
```

This script installs Docker, Caddy, Node.js 20, PM2, pulls required images, configures UFW firewall, and deploys the hosting-service code.

### Post-Bootstrap Checklist

1. **Set environment variables** on the VPS:
   ```bash
   # /etc/environment or PM2 ecosystem config
   HOSTING_DEPLOY_SECRET=your-secret-key-here
   HOSTING_PUBLIC_IP=<VPS_PUBLIC_IP>
   HOSTING_NODE_NAME=hosting-1
   DEFAULT_DOMAIN=apps.ecomgear.app
   ```

2. **Register the server** in the Admin Panel (see Section 2)

3. **Test connectivity** using the Admin Panel "Test" button

4. **Configure DNS**   Point `*.apps.ecomgear.app` (wildcard A record) to the VPS IP

---

## 7. Database Schema

Three tables in the central Supabase database:

### `hosting_servers`
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `name` | text | Server display name |
| `ip_address` | inet | VPS public IP |
| `ssh_user` | text | SSH login user |
| `region` | text | Geographic region |
| `status` | text | `online` or `maintenance` |
| `current_tenants` | int | Number of active tenants |
| `max_tenants` | int | Capacity limit |
| `api_key` | text | Hosting service auth secret |
| `service_port` | int | Port (default 4000) |
| `last_health_check` | timestamptz | Last successful health check |
| `health_status` | jsonb | Latest health response data |

### `tenant_deployments`
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `project_id` | uuid | FK to projects table |
| `server_id` | uuid | FK to hosting_servers |
| `status` | text | `provisioning`, `active`, `suspended`, `failed`, `destroying` |
| `subdomain` | text | Assigned subdomain |
| `postgres_port` | int | Host port for Postgres |
| `postgrest_port` | int | Host port for PostgREST |
| `edge_runtime_port` | int | Host port for Edge Runtime |
| `container_ids` | jsonb | Docker container IDs |
| `db_name` | text | Tenant database name |
| `deployed_at` | timestamptz | Initial deployment time |
| `last_deploy_at` | timestamptz | Last file deployment time |

### `tenant_domains`
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `deployment_id` | uuid | FK to tenant_deployments |
| `domain` | text | Custom domain name |
| `dns_verified` | boolean | DNS verification passed |
| `ssl_status` | text | `pending`, `active`, `failed` |
| `verified_at` | timestamptz | DNS verification timestamp |

---

## 8. Testing

### Run Integration Tests

```bash
cd hosting-service
npm test
# Runs: node test-hosting-local.js
```

This tests: health check, config, deploy, DNS verification, domain activation, path traversal protection, cleanup.

### Manual Tenant Lifecycle Test

```bash
# From hosting-service directory
node -e "
const BASE = 'http://localhost:4000';
const ID = '00000000-0000-4000-a000-000000000001';

async function run() {
  // Provision
  let r = await fetch(BASE + '/tenants/provision', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ projectId: ID, subdomain: 'test' })
  });
  console.log('Provision:', (await r.json()));

  // Deploy
  r = await fetch(BASE + '/tenants/' + ID + '/deploy', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      files: [{path: 'index.html', content: '<h1>Hello</h1>'}]
    })
  });
  console.log('Deploy:', (await r.json()));

  // Status
  r = await fetch(BASE + '/tenants/' + ID + '/status');
  console.log('Status:', (await r.json()));

  // Cleanup
  r = await fetch(BASE + '/tenants/' + ID, { method: 'DELETE' });
  console.log('Destroy:', (await r.json()));
}
run();
"
```

---

## 9. Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 4000 already in use | `kill $(lsof -t -i:4000)` then restart |
| Migration not applied | `supabase db push --local` |
| Hosting service auth rejected | Set `HOSTING_DEPLOY_SECRET` env var or use `NODE_ENV=development` |
| Admin pages show empty tables | Ensure Supabase is running and migration was applied |
| Container status shows empty in local dev | Expected   Docker commands are dry-run in dev mode |
| `Cannot find module './lib/docker-manager'` | Run `npm install` in `hosting-service/` |
| VPS health check fails | Verify VPS IP, port 4000 open in firewall, hosting-service is running via PM2 |

---

## 10. File Structure

```
hosting-service/
├── server.js              # Main Express server (endpoints + tenant lifecycle)
├── package.json           # Dependencies: express, cors, body-parser, dns2
├── start-local.sh         # Local dev startup script
├── test-hosting-local.js  # Integration test suite
├── lib/
│   ├── docker-manager.js  # Docker container lifecycle (create/stop/start/destroy)
│   ├── port-allocator.js  # Dynamic port allocation (base 10000, stride 10)
│   └── tenant-caddy.js   # Caddy config generation per tenant
├── .local-sites/          # Local dev: deployed files stored here
├── .local-caddy/          # Local dev: Caddy configs stored here
└── .ports.json            # Port allocation registry (auto-generated)

src/pages/admin/
├── AdminApp.tsx           # Admin router with Hosting Servers + Tenant routes
├── Hosting.tsx            # Tenant deployments table + suspend/resume
├── Servers.tsx            # Server management (add/test/remove VPS nodes)
└── TenantDetail.tsx       # Per-tenant detail + lifecycle actions

src/eCG/Publish/
└── domainService.ts       # Multi-server publish pipeline methods

supabase/migrations/
└── 20260403120000_hosting_servers_tenants.sql  # Schema for 3 hosting tables

scripts/
└── bootstrap-hosting-server.sh  # VPS bootstrap (Docker, Caddy, Node, PM2)
```

---

## 11. Binary File Sync (Images, Fonts, Media)

### Architecture

When a user uploads an image (e.g. a logo) via chat attachments or the AI agent copies an asset into the project, the file must travel from the gen server to the preview service. Since the sync payload is JSON, binary files are base64-encoded with a sentinel prefix.

**Flow:**

```
User uploads image
  → saved to /tmp on gen server
  → AI agent copies to project dir (~/.ecomgear/preview/{projectId}/public/assets/)
  → collectDiskFiles() reads binary → base64 encodes with sentinel
  → JSON POST to preview service /sync endpoint
  → materializeProjectFiles() detects sentinel → decodes → writes binary
  → Vite serves the image at /assets/logo.png (or wherever it was placed)
```

### Sentinel Format

Binary file content in the sync payload uses this format:

```
__ECOMGEAR_BIN64__<base64-encoded-content>
```

- **Sentinel constant**: `BINARY_SENTINEL = '__ECOMGEAR_BIN64__'`
- Defined in both `server/src/services/agentLoopService.ts` and detected in `preview-service/server.js`

### Supported Binary Extensions

```
.png .jpg .jpeg .gif .ico .svg .woff .woff2 .ttf .eot .otf .webp .mp4 .mp3 .pdf .zip
```

Defined in `BINARY_EXTS_SET` in `agentLoopService.ts`.

### Key Code Locations

| Component | File | Function |
|-----------|------|----------|
| Encode binaries | `server/src/services/agentLoopService.ts` | `collectDiskFiles()` |
| Skip binary in text reads | `server/src/services/agentLoopService.ts` | `agentWrittenFiles` filter |
| Decode binaries | `preview-service/server.js` | `materializeProjectFiles()` |
| Prune stale files | `preview-service/server.js` | `pruneProjectFiles()` |

### JSON Body Limits

Both the gen server (`server/src/app.ts`) and preview service (`preview-service/server.js`) accept up to **50 MB** JSON bodies to accommodate base64-encoded images:

```js
// Gen server (app.ts)
express.json({ limit: '50mb' })

// Preview service (server.js)
bodyParser.json({ limit: '50mb' })
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Image returns 404 in preview | Binary file not in sync payload | Check `collectDiskFiles()` includes the extension in `BINARY_EXTS_SET` |
| Image appears corrupted | Sentinel prefix missing or wrong | Verify `BINARY_SENTINEL` matches in both server and preview-service |
| 413 Payload Too Large | Image exceeds body limit | Increase `limit` in both `express.json()` and `bodyParser.json()` |
| Changes not reflected after code edit | Preview service doesn't auto-reload | Restart preview service: `kill $(lsof -t -i:3001) && cd preview-service && node server.js` |
| `ReferenceError: Cannot access before initialization` | Constants declared after usage (const hoisting) | Ensure `BINARY_EXTS_SET`, `BINARY_SENTINEL` are declared before any code that references them |
