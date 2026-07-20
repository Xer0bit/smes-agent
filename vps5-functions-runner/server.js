import express from 'express';
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { runEdgeFunction } from './runEdgeFunction.js';

const PORT = process.env.PORT || 4001;
const TENANT_DB_JWT_SECRET = process.env.TENANT_DB_JWT_SECRET;
const FUNCTIONS_INTERNAL_SECRET = process.env.FUNCTIONS_INTERNAL_SECRET;

// Same Postgres instance PostgREST already serves tenant schemas from   this
// service reads/writes its own tables here (public.tenant_functions,
// public.tenant_secrets), never anything under a tenant_xxxx schema itself.
const PG_HOST = process.env.TENANT_DB_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.TENANT_DB_PORT || '5432', 10);
const PG_USER = process.env.TENANT_DB_SUPERUSER || 'ecg_provisioner';
const PG_PASSWORD = process.env.TENANT_DB_SUPERUSER_PASSWORD;
const PG_DATABASE = process.env.TENANT_DB_NAME || 'ecg_tenants';

if (!TENANT_DB_JWT_SECRET || !FUNCTIONS_INTERNAL_SECRET || !PG_PASSWORD) {
  console.error('Missing TENANT_DB_JWT_SECRET, FUNCTIONS_INTERNAL_SECRET or TENANT_DB_SUPERUSER_PASSWORD env vars');
  process.exit(1);
}

const pool = new pg.Pool({
  host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
  ssl: process.env.TENANT_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.tenant_functions (
      schema_name text NOT NULL,
      name        text NOT NULL,
      code        text NOT NULL,
      is_active   boolean NOT NULL DEFAULT true,
      project_id  uuid,
      user_id     uuid,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_name, name)
    );
    CREATE TABLE IF NOT EXISTS public.tenant_secrets (
      schema_name text NOT NULL,
      key_name    text NOT NULL,
      key_value   text NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_name, key_name)
    );
  `);
}

// Ported from database.service.ts's verifyTenantJwt   must stay byte-for-byte
// compatible since both sides sign/verify against the same shared secret.
function verifyTenantJwt(token) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const expectedSig = createHmac('sha256', TENANT_DB_JWT_SECRET).update(`${header}.${body}`).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.role !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

function requireInternalSecret(req, res, next) {
  if (req.headers['x-internal-secret'] !== FUNCTIONS_INTERNAL_SECRET) {
    res.status(401).json({ error: 'Invalid internal secret.' });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── POST /:schema/functions/_sync   internal-only, called by
// write_edge_function.ts right after it saves to the platform DB. This is the
// only write path for a function's VPS5-side copy. ──────────────────────────
app.post('/:schema/functions/_sync', requireInternalSecret, async (req, res) => {
  const { schema } = req.params;
  const { name, code, is_active, project_id, user_id } = req.body ?? {};
  if (!name || typeof code !== 'string') { res.status(400).json({ error: 'name and code are required.' }); return; }
  try {
    await pool.query(
      `INSERT INTO public.tenant_functions (schema_name, name, code, is_active, project_id, user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (schema_name, name) DO UPDATE SET
         code = EXCLUDED.code, is_active = EXCLUDED.is_active,
         project_id = EXCLUDED.project_id, user_id = EXCLUDED.user_id, updated_at = now()`,
      [schema, name, code, is_active !== false, project_id ?? null, user_id ?? null],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[functions-runner] sync error', err);
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// ── POST /:schema/secrets/_sync   internal-only, called by set_secret.ts.
// Full-replace semantics (delete + insert), matching the preview-service
// secrets push this mirrors. ─────────────────────────────────────────────────
app.post('/:schema/secrets/_sync', requireInternalSecret, async (req, res) => {
  const { schema } = req.params;
  const secrets = Array.isArray(req.body?.secrets) ? req.body.secrets : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM public.tenant_secrets WHERE schema_name = $1', [schema]);
    for (const s of secrets) {
      if (!s?.key_name) continue;
      await client.query(
        `INSERT INTO public.tenant_secrets (schema_name, key_name, key_value, updated_at) VALUES ($1, $2, $3, now())`,
        [schema, s.key_name, s.key_value ?? ''],
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[functions-runner] secrets sync error', err);
    res.status(500).json({ error: err.message ?? String(err) });
  } finally {
    client.release();
  }
});

// ── POST /:schema/functions/:name/invoke   public path, a generated app's own
// end users call this with the project's anon/service key. Fully local: reads
// tenant_functions/tenant_secrets from this box's own Postgres, never calls
// api.ecomgear.dev. ──────────────────────────────────────────────────────────
async function handleInvoke(req, res) {
  const { schema, name } = req.params;

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['apikey'];
  const token = (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined) || apiKeyHeader;
  if (!token) { res.status(401).json({ error: 'Missing Authorization/apikey header' }); return; }

  const payload = verifyTenantJwt(token);
  if (!payload || !/_(anon|service)$/.test(payload.role)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const tokenSchema = payload.role.replace(/_(anon|service)$/, '');
  if (tokenSchema !== schema) {
    res.status(403).json({ error: "Token does not match this project's schema." });
    return;
  }

  try {
    const { rows } = await pool.query(
      'SELECT code, is_active FROM public.tenant_functions WHERE schema_name = $1 AND name = $2',
      [schema, name],
    );
    const fn = rows[0];
    if (!fn) { res.status(404).json({ error: 'Function not found.' }); return; }
    if (!fn.is_active) { res.status(400).json({ error: 'Function is disabled.' }); return; }

    const { rows: secretRows } = await pool.query(
      'SELECT key_name, key_value FROM public.tenant_secrets WHERE schema_name = $1',
      [schema],
    );
    const secrets = Object.fromEntries(secretRows.map((r) => [r.key_name, r.key_value]));

    const apiUrl = `${req.protocol}://${req.get('host')}/${schema}`.replace(/^http:/, 'https:');
    const dbCtx = { apiUrl, schema, anonKey: '', serviceKey: token };
    // Note: serviceKey here is whichever key the caller authenticated with  
    // db.* calls made from a function invoked with the anon key run with
    // anon-level Postgres GRANTs, not elevated service-role access. This
    // matches the documented no-RLS, GRANT-scoped isolation model.

    const ecgCtx = secrets.ECG_PORTAL_TOKEN ? {
      portalToken: secrets.ECG_PORTAL_TOKEN,
      portalApiUrl: process.env.ECG_PORTAL_URL || 'https://api.ecomgear.ai',
      llmApiKey: secrets.ECG_LLM_API_KEY,
      llmModel: secrets.ECG_LLM_MODEL,
      llmProvider: secrets.ECG_LLM_PROVIDER,
    } : undefined;

    const params = req.body?.params ?? {};
    const result = await runEdgeFunction(fn.code, params, dbCtx, ecgCtx, secrets);
    res.status(result.error ? 422 : 200).json(result);
  } catch (err) {
    console.error('[functions-runner] invoke error', err);
    res.status(500).json({ error: err.message ?? String(err) });
  }
}

app.post('/:schema/functions/:name/invoke', handleInvoke);
// Compatibility alias: some generated apps' client code calls
// `${VITE_FUNCTIONS_API_URL}/api/v1/functions/<name>/invoke` instead of the
// documented flat `${VITE_FUNCTIONS_API_URL}/<name>/invoke` (VITE_FUNCTIONS_API_URL
// already includes `/functions`) — the model pattern-matched this platform's
// own `/api/v1/functions` route prefix instead of the edge-function invoke
// pattern in app-builder.prompt.ts. Accepting the mistaken shape here fixes
// every already-generated app hitting this 404 without needing to regenerate
// or hand-edit their source.
app.post('/:schema/functions/api/v1/functions/:name/invoke', handleInvoke);

ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`[functions-runner] listening on :${PORT}`)))
  .catch((err) => { console.error('[functions-runner] schema init failed', err); process.exit(1); });
