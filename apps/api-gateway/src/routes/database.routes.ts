import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { databaseService, buildProjectEnvSecrets } from '../services/database.service.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { projectService } from '../services/project.service.js';
import { safeErrorMessage } from '../utils/sendError.js';
import { createError } from '../middleware/error.middleware.js';

const router = Router();
router.use(authMiddleware);

const dbProvisionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many provision requests, try again later.' } });
const dbQueryLimiter    = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Query rate limit exceeded.' } });

// ── Extract project_id from request (query param, body, or header) ───────────
function getProjectId(req: AuthenticatedRequest): string | undefined {
  return (req.query.project_id as string | undefined)
      || (req.body?.project_id as string | undefined)
      || (req.headers['x-project-id'] as string | undefined)
      || undefined;
}

// ── Plan gate ────────────────────────────────────────────────────────────────
// Verifies BOTH that the org has a paid plan AND that the requesting user is
// actually a member of that org (prevents org_id forgery from the request body).
async function requirePaidPlan(req: AuthenticatedRequest, res: Response, organizationId?: string | null): Promise<boolean> {
  const projectId = getProjectId(req);
  let orgId = organizationId ?? null;
  if (!orgId) {
    const existing = await databaseService.getStatus(req.user!.id, projectId);
    orgId = existing?.organization_id ?? null;
  }
  if (!orgId) {
    res.status(403).json({ error: 'Hosted databases require a Pro or Agency plan.' });
    return false;
  }

  // Verify membership + plan in one query   prevents org_id forgery
  const { data } = await supabase
    .from('organizations')
    .select('plan_tier, org_members!inner(user_id)')
    .eq('id', orgId)
    .eq('org_members.user_id', req.user!.id)
    .maybeSingle();

  if (!data) {
    res.status(403).json({ error: 'Organization not found or you are not a member.' });
    return false;
  }
  const tier = (data as any)?.plan_tier || 'free';
  if (tier === 'free') {
    res.status(403).json({ error: 'Hosted databases require a Pro or Agency plan.' });
    return false;
  }
  return true;
}

// getStatus()/getCredentials()/etc below filter purely by project_id and never
// verify the caller owns it   any authenticated user who knows/guesses another
// project's ID could read or act on that project's hosted database. These two
// helpers close that gap; read ops accept any accepted role (owner down to
// viewer/client), write/destructive/export ops require editor+.
async function requireProjectView(req: AuthenticatedRequest, res: Response, projectId?: string): Promise<boolean> {
  // 2026-08 audit flagged this as fail-open. It isn't a bypass: every
  // downstream operation on the legacy (pre-project-scoping) path filters by
  // req.user!.id itself (see databaseService.getStatus/getCredentials's
  // projectId-undefined branch), so a caller can only ever reach their OWN
  // resources this way regardless of this check. Left as fail-open-by-design
  // rather than flipped to fail-closed: doing that would 404 every legacy
  // tenant-database row (provisioned before project_id existed) outright.
  // The real invariant this relies on: any NEW route added here must keep
  // scoping its own projectId-undefined branch by the caller's user_id --
  // this helper alone does not enforce that for a future caller.
  if (!projectId) return true;
  try {
    await projectService.getProject(projectId, req.user!.id);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}
async function requireProjectEdit(req: AuthenticatedRequest, res: Response, projectId?: string): Promise<boolean> {
  if (!projectId) return true;
  try {
    await projectService.assertCanEditProject(projectId, req.user!.id);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// ── GET /api/v1/database/status ──────────────────────────────────────────────
router.get('/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!(await requireProjectView(req, res, projectId))) return;
    const record = await databaseService.getStatus(req.user!.id, projectId);
    res.json({ database: record });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── GET /api/v1/database/credentials ────────────────────────────────────────
// Returns keys regenerated on-demand (never stored). Plan check enforced so
// downgraded users cannot keep retrieving live JWT keys.
router.get('/credentials', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const creds = await databaseService.getCredentials(req.user!.id, projectId);
    if (!creds) { res.status(404).json({ error: 'No active database' }); return; }
    logger.info('security_event', { event: 'sensitive_data_access', userId: req.user!.id, ip: req.ip, resource: 'project_secrets', projectId, outcome: 'success' });
    res.json(creds);
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── POST /api/v1/database/sync-secrets ──────────────────────────────────────
// The Settings "Sync" button. getCredentials() only upserts VITE_DB_*/
// VITE_FUNCTIONS_API_URL into the project_secrets TABLE   it never reaches the
// live preview, which only reads a .env.local file written by the preview
// service's own /secrets endpoint. Without this, the running app's
// import.meta.env.VITE_DB_API_URL stays undefined ("Database API URL is not
// configured") even though the row exists in project_secrets. This pushes the
// full current secret set to the preview so it takes effect immediately.
router.post('/sync-secrets', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
    if (!(await requireProjectEdit(req, res, projectId))) return;

    // buildProjectEnvSecrets is the single source of truth (see database.service.ts)  
    // it upserts auth + DB/functions rows as a side effect and returns the full merged
    // set, so this route never needs its own derivation logic to drift out of sync.
    const secrets = await buildProjectEnvSecrets(req.user!.id, projectId);

    const previewBase = (process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
    const previewRes = await fetch(`${previewBase}/preview/${projectId}/secrets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ secrets: secrets ?? [] }),
    });
    if (!previewRes.ok) throw new Error(`Preview service responded ${previewRes.status}`);
    const previewResult = await previewRes.json().catch(() => ({})) as { restarted?: boolean };

    logger.info('security_event', { event: 'sensitive_data_access', userId: req.user!.id, ip: req.ip, resource: 'project_secrets', projectId, outcome: 'success' });
    res.json({ synced: (secrets ?? []).length, restarted: Boolean(previewResult.restarted) });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── POST /api/v1/database/preview-update ────────────────────────────────────
// Proxies a file push to the preview service so the browser never has to hold
// PREVIEW_UPDATE_SECRET. Previously src/services/previewHealthService.ts sent
// this secret straight from the client as VITE_PREVIEW_UPDATE_SECRET, which
// Vite bundles into the public JS   anyone could pull it out of the built
// output and hit the preview service's /update endpoint directly. The secret
// stays server-side now; the client just needs to be an authenticated owner
// of the project.
// NOT centralized: this route's catch returns { success: false, error }, a
// different response shape than errorHandler's { error } -- routing it
// through createError would silently drop the `success` field API
// consumers may check. Left as-is deliberately, not an oversight.
router.post('/preview-update', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
    const files = req.body?.files;
    if (!Array.isArray(files)) { res.status(400).json({ error: 'files array is required.' }); return; }
    const fullSync = req.body?.fullSync !== false;

    if (!(await requireProjectEdit(req, res, projectId))) return;

    const previewBase = (process.env.PREVIEW_SERVICE_URL || process.env.VITE_PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
    const previewRes = await fetch(`${previewBase}/preview/${projectId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ files, fullSync, baseSeq: req.body?.baseSeq }),
      // Must exceed preview-service's own internal worst-case processing
      // budget (materialize + warmupInstance's own 30s ceiling + build
      // check, all before it responds) -- see previewHealthService.ts's
      // matching client-side timeout for the full explanation. A proxy
      // timeout equal to that inner ceiling meant this hop could abort the
      // request out from under a preview-service call that was still
      // legitimately working and would have succeeded.
      signal: AbortSignal.timeout(60_000),
    });
    if (!previewRes.ok) {
      const text = await previewRes.text().catch(() => '');
      // Pass through preview-service's real status (429 rate-limited, 423
      // project-locked, 401, etc.) instead of flattening every failure into
      // an opaque 502 -- callers need to tell "another generation is running,
      // retry shortly" apart from "the preview host is actually down".
      let upstreamError = text;
      let upstreamCode: string | undefined;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error) upstreamError = parsed.error;
        if (typeof parsed?.code === 'string') upstreamCode = parsed.code;
      } catch {
        // Not JSON -- use the raw text as-is.
      }
      const status = previewRes.status >= 400 && previewRes.status < 600 ? previewRes.status : 502;
      res.status(status).json({ success: false, error: upstreamError, code: upstreamCode });
      return;
    }
    const data = await previewRes.json().catch(() => ({}));
    res.json({ success: true, session: (data as any)?.session });
  } catch (err) {
    logger.error('preview-update error', err);
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/database/preview-sync-revision ─────────────────────────────
// Council review 2026-08-18: five confirmed "images disappear on reload"
// root causes (concurrent download failures pruning the server, orphaned
// asset references, UTF-8-mangled binaries, stale-workspace resurrection --
// see docs/plans/deep-dive-2026-08-17.md) reduced to ONE architectural
// defect, independently named by 3 of 5 council advisors: the browser sat
// in the write path for tenant file bytes it never authored. Every incident
// was some version of "the client downloaded N files, something went wrong
// in the browser, and it pushed the result back over the live preview."
//
// This route replaces that entire class for the one operation that caused
// every incident: syncing the preview to a project's head (or given)
// revision on editor load. The server now does this itself --
// server-to-server, byte-safe, no browser involved:
//   - fetches the revision manifest from Postgres directly (service role)
//   - downloads every file body from Storage as raw bytes via
//     arrayBuffer(), NEVER blob.text()/response.text() -- the exact API
//     that UTF-8-mangled binaries in the browser (root cause C) structurally
//     cannot be called here, because the code path that called it doesn't
//     exist in this route.
//   - forwards to preview-service with the SAME manifest file count the
//     server itself just verified, so the floor-check on the preview side
//     (2026-08-18 fix) sees an honest fullSync, never a partial one.
// The client's job shrinks to "tell the server which revision", which
// removes an entire tier of failure modes rather than adding a guard
// against one more of them.
router.post('/preview-sync-revision', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
    if (!(await requireProjectEdit(req, res, projectId))) return;
    if (!supabase) { res.status(500).json({ success: false, error: 'Database not configured' }); return; }

    const requestedRevisionId = req.body?.revisionId as string | undefined;
    const { data: revRow, error: revErr } = requestedRevisionId
      ? await supabase.from('revisions').select('id, created_at, generated_files').eq('id', requestedRevisionId).eq('project_id', projectId).maybeSingle()
      : await supabase.from('revisions').select('id, created_at, generated_files').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (revErr || !revRow) {
      res.status(404).json({ success: false, error: 'No revision found for this project.' });
      return;
    }

    const generatedFiles = revRow.generated_files as { format?: string; files?: Array<{ path: string; hash: string; source_revision: string }> } | null;
    const STORAGE_BUCKET = 'user-projects-free';
    const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip|svg)$/i;
    const BINARY_SENTINEL = '__ECOMGEAR_BIN64__';

    let files: Array<{ path: string; content: string }>;
    if (generatedFiles?.format === 'manifest-v1' && Array.isArray(generatedFiles.files)) {
      const manifest = generatedFiles.files;
      const downloadOne = async (entry: { path: string; source_revision: string }): Promise<{ path: string; content: string } | null> => {
        const storagePath = `projects/${projectId}/${entry.source_revision}/${entry.path}`;
        const { data: blob, error: dlErr } = await supabase.storage.from(STORAGE_BUCKET).download(storagePath);
        if (dlErr || !blob) return null;
        if (BINARY_EXT_RE.test(entry.path)) {
          // Raw bytes, server-side, never routed through a text decoder --
          // the exact operation that mangled binaries when the browser did
          // it via blob.text(). Sentinel-wrap unconditionally regardless of
          // what the stored object already held (some historical rows hold
          // raw bytes, not the sentinel format) so preview-service always
          // sees the same shape.
          const buf = Buffer.from(await blob.arrayBuffer());
          const alreadySentineled = buf.subarray(0, BINARY_SENTINEL.length).toString('utf8') === BINARY_SENTINEL;
          const content = alreadySentineled ? buf.toString('utf8') : `${BINARY_SENTINEL}${buf.toString('base64')}`;
          return { path: entry.path, content };
        }
        return { path: entry.path, content: await blob.text() };
      };

      const BATCH = 12;
      const results: Array<{ path: string; content: string } | null> = [];
      for (let i = 0; i < manifest.length; i += BATCH) {
        const batch = await Promise.all(manifest.slice(i, i + BATCH).map(downloadOne));
        results.push(...batch);
      }
      const failed = manifest.filter((_, i) => results[i] === null);
      if (failed.length > 0) {
        logger.error(`[preview-sync-revision] ${failed.length}/${manifest.length} file(s) failed to download for project ${projectId}, revision ${revRow.id}`);
        res.status(502).json({ success: false, error: `${failed.length} file(s) failed to download from storage; sync aborted rather than pushing a partial set.` });
        return;
      }
      files = results.filter((f): f is { path: string; content: string } => f !== null);
    } else if (generatedFiles?.files && Array.isArray((generatedFiles as any).files) && (generatedFiles as any).files[0]?.content !== undefined) {
      // Legacy inline-JSONB format: content already in the row (no storage
      // download, so no arrayBuffer() step is possible here). Still apply
      // the same sentinel-wrap guarantee the manifest-v1 branch above gives
      // binaries: the browser-side writer that produced these rows always
      // base64-encoded binary content before it ever reached JSONB (JSONB
      // can't hold raw bytes), sentinel-prefixed via the same convention --
      // but treat "not already sentineled" the same defensive way as above
      // rather than assuming every historical row followed it.
      const rawFiles = (generatedFiles as any).files as Array<{ path: string; content: string }>;
      files = rawFiles.map((f) => {
        if (!BINARY_EXT_RE.test(f.path) || f.content.startsWith(BINARY_SENTINEL)) return f;
        return { path: f.path, content: `${BINARY_SENTINEL}${f.content}` };
      });
    } else {
      res.status(404).json({ success: false, error: 'Revision has no file content to sync.' });
      return;
    }

    const previewBase = (process.env.PREVIEW_SERVICE_URL || process.env.VITE_PREVIEW_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
    const previewRes = await fetch(`${previewBase}/preview/${projectId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PREVIEW_UPDATE_SECRET ? { 'x-update-secret': process.env.PREVIEW_UPDATE_SECRET } : {}),
      },
      body: JSON.stringify({ files, fullSync: true, baseSeq: revRow.created_at }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!previewRes.ok) {
      const text = await previewRes.text().catch(() => '');
      let upstreamError = text;
      let upstreamCode: string | undefined;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error) upstreamError = parsed.error;
        if (typeof parsed?.code === 'string') upstreamCode = parsed.code;
      } catch { /* raw text */ }
      const status = previewRes.status >= 400 && previewRes.status < 600 ? previewRes.status : 502;
      res.status(status).json({ success: false, error: upstreamError, code: upstreamCode });
      return;
    }
    const data = await previewRes.json().catch(() => ({}));
    res.json({ success: true, revisionId: revRow.id, filesSynced: files.length, session: (data as any)?.session });
  } catch (err) {
    logger.error('preview-sync-revision error', err);
    res.status(500).json({ success: false, error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/database/provision ─────────────────────────────────────────
router.post('/provision', dbProvisionLimiter, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    const { organization_id } = req.body;
    if (!(await requireProjectEdit(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res, organization_id))) return;
    const record = await databaseService.provision(req.user!.id, organization_id || null, projectId);
    const creds  = await databaseService.getCredentials(req.user!.id, projectId);
    res.status(201).json({ database: record, credentials: creds });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('already_provisioned') ? 409 : 500;
    // 409's message is a known, safe, internally-generated string ("already_provisioned"),
    // not upstream error detail   fine to return as-is. Anything reaching the 500
    // branch is unexpected and gets sanitized like every other 500 in this file.
    next(createError(status === 409 ? msg : safeErrorMessage(err, 'Provision error'), status, projectId));
  }
});

// ── DELETE /api/v1/database/deprovision ─────────────────────────────────────
// No plan gate: if you own the database you can always delete it.
// Irreversible (DROP SCHEMA ... CASCADE, see database.service.ts) -- requires
// the caller to echo the tenant's exact schema_name as a typed confirmation,
// so a single accidental/forged DELETE can't wipe a tenant database outright.
// Rate-limited to match /provision's existing pattern (this route had none).
router.delete('/deprovision', dbProvisionLimiter, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!(await requireProjectEdit(req, res, projectId))) return;

    const status = await databaseService.getStatus(req.user!.id, projectId);
    if (!status) { res.status(404).json({ error: 'No database provisioned for this project.' }); return; }

    const confirm = (req.body?.confirm as string | undefined)?.trim();
    if (confirm !== status.schema_name) {
      res.status(400).json({
        error: 'Confirmation required. Pass { "confirm": "<schema_name>" } in the request body, exactly matching the database to delete.',
        schema_name: status.schema_name,
      });
      return;
    }

    await databaseService.deprovision(req.user!.id, projectId);
    res.json({ success: true });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── GET /api/v1/database/ping ───────────────────────────────────────────────
router.get('/ping', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const result = await databaseService.testConnection(req.user!.id, projectId);
    res.json(result);
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── GET /api/v1/database/dump ───────────────────────────────────────────────
// Returns a downloadable .sql dump (schema + data) of the tenant's schema.
// Full data export   editor+ only, same bar as /query with role=service.
router.get('/dump', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!(await requireProjectEdit(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const { sql, schema, truncated } = await databaseService.dumpDatabase(req.user!.id, projectId);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${schema}-dump-${Date.now()}.sql"`);
    if (truncated) res.setHeader('X-Dump-Truncated', 'true');
    res.send(sql);
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── GET /api/v1/database/tables ──────────────────────────────────────────────
router.get('/tables', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const tables = await databaseService.listTables(req.user!.id, projectId);
    res.json({ tables });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── GET /api/v1/database/tables/:table/rows ──────────────────────────────────
router.get('/tables/:table/rows', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = getProjectId(req);
    if (!(await requireProjectView(req, res, projectId))) return;
    if (!(await requirePaidPlan(req, res))) return;
    const limit  = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
    const offset = parseInt(req.query.offset as string || '0', 10);
    const result = await databaseService.queryTable(req.user!.id, req.params.table, limit, offset, projectId);
    res.json(result);
  } catch (err) {
    // Raw message intentionally NOT sanitized here: this is an owner-only
    // (requireProjectView-gated) table-browser tool, not an end-user-facing
    // endpoint -- the caller needs the real DB error to debug their own
    // schema/query, same reasoning as /query below.
    const msg = (err as Error).message;
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// ── POST /api/v1/database/query ──────────────────────────────────────────────
// role=anon (default) → SELECT only, viewer+; role=service → full access
// (bypasses RLS, agent uses this) → editor+ only.
router.post('/query', dbQueryLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sql, role } = req.body as { sql: string; role?: 'anon' | 'service' };
    if (!sql?.trim()) { res.status(400).json({ error: 'sql required' }); return; }

    const projectId = getProjectId(req);
    const accessOk = role === 'service'
      ? await requireProjectEdit(req, res, projectId)
      : await requireProjectView(req, res, projectId);
    if (!accessOk) return;

    // Both roles require a paid plan (anon could otherwise be used by downgraded users)
    if (!(await requirePaidPlan(req, res))) return;

    const result = await databaseService.runQuery(req.user!.id, sql, role || 'anon', projectId);
    res.json(result);
  } catch (err) {
    // Raw message intentionally NOT sanitized: this endpoint runs the
    // caller's own SQL (a DB console/REPL tool, owner-gated above) -- they
    // need the real Postgres error ("column does not exist", syntax error,
    // etc.) to fix their query. Sanitizing would break the feature.
    const msg = (err as Error).message;
    res.status(msg.includes('Only SELECT') || msg.includes('blocked') ? 403 : 500).json({ error: msg });
  }
});

// ── Admin-mode SQL: agent stages, only a human confirms ──────────────────────
// query_database.ts (agent tool, admin-mode only) stages a dangerous
// statement (schema-mutating, or an unqualified UPDATE/DELETE) as a row here
// instead of executing it. The agent has NO tool that can confirm its own
// pending change (see agentToolSet.ts's AGENT_NEVER_CONFIRMS_TOOLS) -- only
// this route, triggered by a real click in the chat UI, can execute it.

// ── GET /api/v1/database/admin-sql/pending ───────────────────────────────────
router.get('/admin-sql/pending', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  try {
    if (!projectId) { res.status(400).json({ error: 'project_id required' }); return; }
    if (!(await requireProjectEdit(req, res, projectId))) return;
    const { data, error } = await supabase
      .from('admin_sql_pending_changes')
      .select('id, sql_text, status, created_at, staged_by_user_id')
      .eq('project_id', projectId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ pending: data ?? [] });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── POST /api/v1/database/admin-sql/:id/confirm ──────────────────────────────
// Executes a staged admin SQL change. Requires edit access to the project the
// change was staged against -- same bar as query_database itself (any
// authenticated collaborator, not owner-only), re-checked here independently
// of whoever staged it, since the confirming user may be a different
// collaborator than the one chatting with the agent.
router.post('/admin-sql/:id/confirm', dbQueryLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const { data: pending, error: fetchErr } = await supabase
      .from('admin_sql_pending_changes')
      .select('id, project_id, sql_text, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!pending) { res.status(404).json({ error: 'No pending admin SQL change found for this id.' }); return; }
    if (pending.status !== 'pending') { res.status(409).json({ error: `This change is already ${pending.status}.` }); return; }

    if (!(await requireProjectEdit(req, res, pending.project_id))) return;
    if (!(await requirePaidPlan(req, res))) return;

    try {
      const result = await databaseService.runQuery(req.user!.id, pending.sql_text, 'service', pending.project_id);
      await supabase.from('admin_sql_pending_changes').update({
        status: 'executed', executed_at: new Date().toISOString(), executed_by_user_id: req.user!.id,
      }).eq('id', id);
      res.json({ success: true, ...result });
    } catch (execErr) {
      const msg = (execErr as Error).message;
      await supabase.from('admin_sql_pending_changes').update({
        status: 'rejected', executed_at: new Date().toISOString(), executed_by_user_id: req.user!.id, error_message: msg,
      }).eq('id', id);
      // Raw message intentionally NOT sanitized: same reasoning as /query --
      // the confirming user needs the real Postgres error to understand why
      // the change they just approved failed.
      res.status(500).json({ error: msg });
    }
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── POST /api/v1/database/admin-sql/:id/reject ───────────────────────────────
router.post('/admin-sql/:id/reject', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const { data: pending, error: fetchErr } = await supabase
      .from('admin_sql_pending_changes')
      .select('id, project_id, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!pending) { res.status(404).json({ error: 'No pending admin SQL change found for this id.' }); return; }
    if (pending.status !== 'pending') { res.status(409).json({ error: `This change is already ${pending.status}.` }); return; }
    if (!(await requireProjectEdit(req, res, pending.project_id))) return;

    await supabase.from('admin_sql_pending_changes').update({
      status: 'rejected', executed_at: new Date().toISOString(), executed_by_user_id: req.user!.id,
    }).eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

export default router;
