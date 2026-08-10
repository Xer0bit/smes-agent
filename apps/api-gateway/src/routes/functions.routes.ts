import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase, supabaseAuth } from '../config/database.js';
import { databaseService, verifyTenantJwt, getOwnerBySchema } from '../services/database.service.js';
import { runEdgeFunction, EcgContext, FunctionContext } from '../services/functionRunner.service.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';
import { safeErrorMessage } from '../utils/sendError.js';
import { createError } from '../middleware/error.middleware.js';

const router = Router();

// Previously IP-keyed (express-rate-limit's default), which meant one NAT/
// corporate egress IP shared a single 30/min budget across every user of
// every generated app behind it, while a distributed caller (or a leaked
// anon key hit from many source IPs) could trivially exceed any per-project
// limit entirely. Keyed on the caller's own bearer token/apikey instead --
// this runs BEFORE resolveInvokeAuth (auth verification does real work: a
// JWT check or a Supabase getUser() call, so it shouldn't be reachable
// unlimited-rate before rate limiting even applies), so the raw credential
// is the only caller-identifying value available yet. Hashed rather than
// stored raw as an in-memory rate-limit-store key.
function invokeRateLimitKey(req: AuthenticatedRequest): string {
  const authHeader = req.headers.authorization;
  const token = (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined) || (req.headers['apikey'] as string | undefined);
  if (token) return createHash('sha256').update(token).digest('hex');
  return req.ip || 'unknown';
}

const invokeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: invokeRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many function invocations. Limit: 30/min.' },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getProjectId(req: AuthenticatedRequest): string | undefined {
  return (req.query.project_id as string | undefined)
      || (req.body?.project_id as string | undefined)
      || (req.headers['x-project-id'] as string | undefined)
      || (req as AuthenticatedRequest & { tenantProjectId?: string }).tenantProjectId
      || undefined;
}

// ── Invoke auth: owner platform session OR the project's own public anon/
// service key (VITE_DB_ANON_KEY / VITE_DB_SERVICE_KEY) ──────────────────────
// Management routes (list/create/update/delete/logs) stay owner-only via
// authMiddleware. Invocation is the one path a generated app's own end users
// must be able to reach   they never have an EcomGear platform session, so
// they authenticate with the same public anon key already used for PostgREST
// calls, exactly like the hosted-database REST access pattern.
async function resolveInvokeAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['apikey'] as string | undefined;
  const token = (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined) || apiKeyHeader;

  if (!token) { res.status(401).json({ error: 'Missing Authorization/apikey header' }); return; }

  // 1. Try tenant anon/service JWT first (cheap, local HMAC check, no network call)
  const tenantPayload = verifyTenantJwt(token);
  if (tenantPayload && /_(anon|service)$/.test(tenantPayload.role)) {
    const schema = tenantPayload.role.replace(/_(anon|service)$/, '');
    const owner = await getOwnerBySchema(schema);
    if (owner) {
      req.user = { id: owner.user_id, email: '', role: 'tenant-public' };
      (req as AuthenticatedRequest & { tenantProjectId?: string }).tenantProjectId = owner.project_id ?? undefined;
      next();
      return;
    }
  }

  // 2. Fall back to an owner's EcomGear platform session (lets the project
  // owner test invocation from Settings without needing the anon key).
  try {
    const authResult = await Promise.race([
      supabaseAuth.auth.getUser(token),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Auth verification timed out')), 10_000)),
    ]);
    const { data, error } = authResult;
    if (!error && data.user) {
      req.user = { id: data.user.id, email: data.user.email || '', role: data.user.role };
      next();
      return;
    }
  } catch {
    // fall through to 401
  }

  res.status(401).json({ error: 'Invalid credentials' });
}

// Edge functions are project-scoped, not database-scoped   a function that
// doesn't touch the DB (e.g. a pure webhook handler) should be listable/
// manageable without one provisioned. Only /invoke needs DB credentials, and
// only lazily (if the function's own code calls db.*).
async function requireProjectAccess(userId: string, projectId: string, res: Response): Promise<boolean> {
  try {
    await projectService.getProject(projectId, userId);
    return true;
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return false;
  }
}

// ── GET /api/v1/functions ────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    // Scoped by project_id only, not user_id   write_edge_function.ts saves
    // rows under the PROJECT OWNER's user_id, not whoever's chatting, so a
    // collaborator viewing this list under their own req.user.id would see
    // nothing despite requireProjectAccess already confirming they may view
    // this project's functions.
    const { data, error } = await supabase
      .from('edge_functions')
      .select('id, name, description, is_active, created_at, updated_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ functions: data || [] });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── GET /api/v1/functions/:name ──────────────────────────────────────────────
router.get('/:name', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { data, error } = await supabase
      .from('edge_functions')
      .select('*')
      .eq('project_id', projectId)
      .eq('name', req.params.name)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { res.status(404).json({ error: 'Function not found.' }); return; }
    res.json(data);
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

// ── POST /api/v1/functions ───────────────────────────────────────────────────
// Locked: edge functions can only be created or modified by the AI agent.
// Ask the agent in the project editor to create or update an edge function.
router.post('/', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  res.status(403).json({
    error: 'Edge functions can only be created by the AI agent. Ask the agent to write or update your edge function.',
  });
});

// ── PATCH /api/v1/functions/:name ────────────────────────────────────────────
// Locked: edge functions can only be modified by the AI agent.
router.patch('/:name', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  res.status(403).json({
    error: 'Edge functions can only be modified by the AI agent. Ask the agent to update your edge function.',
  });
});

// ── DELETE /api/v1/functions/:name ──────────────────────────────────────────
// Locked: edge functions can only be deleted by the AI agent, same as create/
// modify above   a user manually deleting one out from under the agent's own
// understanding of the project is exactly the kind of drift this project
// keeps needing an audit to catch.
router.delete('/:name', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  res.status(403).json({
    error: 'Edge functions can only be deleted by the AI agent. Ask the agent to remove it.',
  });
});

// ── Shared bundle resolution   used by both the local /invoke route and the
// internal /_internal/bundle route the VPS5 function-runner calls. Pulled out
// so relocating execution to VPS5 doesn't duplicate this lookup logic. ──────
interface FunctionBundle {
  code: string;
  functionId: string;
  dbCtx?: FunctionContext;
  ecgCtx?: EcgContext;
  secrets?: Record<string, string>;
}

async function resolveFunctionBundle(
  callerId: string,
  callerRole: string,
  name: string,
  invokeProjectId: string | undefined,
): Promise<{ bundle?: FunctionBundle; error?: string; status?: number }> {
  // Resolve the project OWNER's user_id so credential lookups and function
  // fetches hit the right rows regardless of who is invoking. A collaborator
  // calling via their own platform session has a different user_id than the
  // owner who owns the edge_functions row + tenant_databases row   without
  // this resolution they get a false 404.
  let ownerId = callerId;
  if (invokeProjectId) {
    try {
      const project = await projectService.getProject(invokeProjectId, callerId);
      ownerId = project.user_id;
    } catch {
      // getProject throws if the caller has no access   but a tenant-public
      // caller was already validated via getOwnerBySchema before this is called.
      // Fall through with the original user id.
    }
  }

  // Optional   a function that never calls db.* should run fine without a
  // provisioned database. runEdgeFunction only errors on db.* calls if this
  // is undefined.
  const creds = await databaseService.getCredentials(ownerId, invokeProjectId);

  let fnQuery = supabase
    .from('edge_functions')
    .select('id, code, is_active, requires_service_role, is_public')
    .eq('user_id', ownerId)
    .eq('name', name);
  // Legacy rows written before project scoping have project_id NULL   only
  // match those when no project_id is known, never mix scoped/unscoped rows.
  fnQuery = invokeProjectId ? fnQuery.eq('project_id', invokeProjectId) : fnQuery.is('project_id', null);
  const { data: fn, error } = await fnQuery.maybeSingle();

  if (error) return { error: safeErrorMessage(error, 'Function lookup failed'), status: 500 };
  if (!fn) return { error: 'Function not found.', status: 404 };
  if (!fn.is_active) return { error: 'Function is disabled.', status: 400 };
  // Function-granularity authorization: a project's public anon/service key
  // used to authorize invoking EVERY function in the project, including ones
  // meant to be owner/admin-only -- there was no way to mark a function
  // private. is_public=false rejects any caller that isn't a verified owner
  // platform session (callerRole !== 'tenant-public', set by resolveInvokeAuth).
  if (!fn.is_public && callerRole === 'tenant-public') {
    return { error: 'This function requires an owner session and cannot be invoked with a project key.', status: 403 };
  }

  // Load ECG secrets for this project (if it has ECG integration)
  let ecgCtx: EcgContext | undefined;
  if (invokeProjectId) {
    const { data: ecgRows } = await supabase
      .from('project_secrets').select('key_name, key_value')
      .eq('project_id', invokeProjectId)
      .in('key_name', ['ECG_PORTAL_TOKEN', 'ECG_LLM_API_KEY', 'ECG_LLM_MODEL', 'ECG_LLM_PROVIDER']);
    const ecgMap = Object.fromEntries((ecgRows ?? []).map((r: { key_name: string; key_value: string }) => [r.key_name, r.key_value]));
    if (ecgMap['ECG_PORTAL_TOKEN']) {
      ecgCtx = {
        portalToken:  ecgMap['ECG_PORTAL_TOKEN'],
        portalApiUrl: process.env.ECG_PORTAL_URL || 'https://api.ecomgear.ai',
        llmApiKey:    ecgMap['ECG_LLM_API_KEY'],
        llmModel:     ecgMap['ECG_LLM_MODEL'],
        llmProvider:  ecgMap['ECG_LLM_PROVIDER'],
        projectId:    invokeProjectId,
      };
    }
  }

  // Least-privilege invocation: functionRunner's db.* helper only ever reads
  // ctx.serviceKey for its auth headers, so a function that opted out of
  // service-role access (requires_service_role=false) gets the anon key put
  // in that slot instead -- its db.* calls are then genuinely RLS-scoped
  // (the anon role only has USAGE+SELECT grants in tenant schemas, per
  // database.service.ts's role provisioning), not just labeled as such.
  const dbCtx: FunctionContext | undefined = creds ? {
    apiUrl:     creds.api_url,
    schema:     creds.schema,
    anonKey:    creds.anon_key,
    serviceKey: fn.requires_service_role ? creds.service_key : creds.anon_key,
  } : undefined;

  // Expose all saved project secrets as `secrets.KEY_NAME` inside the function
  // sandbox   values never leave this process, they're just readable by the
  // function's own server-side code.
  let secrets: Record<string, string> | undefined;
  if (invokeProjectId) {
    const { data: secretRows } = await supabase
      .from('project_secrets')
      .select('key_name, key_value')
      .eq('project_id', invokeProjectId);
    if (secretRows?.length) {
      secrets = Object.fromEntries(secretRows.map((r: { key_name: string; key_value: string }) => [r.key_name, r.key_value]));
    }
  }

  return { bundle: { code: fn.code, functionId: fn.id, dbCtx, ecgCtx, secrets } };
}

function persistInvokeLog(userId: string, projectId: string | undefined, functionId: string, params: unknown, result: Awaited<ReturnType<typeof runEdgeFunction>>) {
  supabase.from('edge_function_logs').insert({
    user_id:     userId,
    project_id:  projectId ?? null,
    function_id: functionId,
    params,
    result:      result.result,
    logs:        result.logs,
    duration_ms: result.durationMs,
    error:       result.error ?? null,
  }).then(() => {}, () => {});
}

// ── Temporary kill switch ────────────────────────────────────────────────────
// 2026-08 security audit found the vm sandbox used by runEdgeFunction() below
// is escapable to host-process RCE (Object.constructor.constructor chain --
// see audit report). Public invocation is disabled by default until that's
// replaced with a real isolate (isolated-vm or equivalent) plus AST-based
// static validation. Set EDGE_FUNCTIONS_INVOKE_ENABLED=true to re-enable
// (e.g. for local dev where the exposure is not attacker-reachable) --
// defaults CLOSED, not open, on any unset/misspelled value.
function invokeKillSwitch(_req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (process.env.EDGE_FUNCTIONS_INVOKE_ENABLED !== 'true') {
    res.status(503).json({
      error: 'Function invocation is temporarily disabled pending a security fix. Contact support if this persists.',
    });
    return;
  }
  next();
}

// ── POST /api/v1/functions/:name/invoke ─────────────────────────────────────
// Public path: a generated app's own end users call this with the project's
// VITE_DB_ANON_KEY (or VITE_DB_SERVICE_KEY)   see resolveInvokeAuth above.
router.post('/:name/invoke', invokeKillSwitch, invokeLimiter, resolveInvokeAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let invokeProjectId: string | undefined;
  try {
    invokeProjectId = getProjectId(req);
    const { bundle, error, status } = await resolveFunctionBundle(req.user!.id, req.user!.role ?? '', req.params.name, invokeProjectId);
    if (!bundle) { res.status(status ?? 500).json({ error }); return; }

    const params = req.body?.params ?? {};
    const result = await runEdgeFunction(bundle.code, params, bundle.dbCtx, bundle.ecgCtx, bundle.secrets);
    persistInvokeLog(req.user!.id, invokeProjectId, bundle.functionId, params, result);

    // Previously the full `logs` array (every console.log the function made)
    // went to EVERY caller, including anonymous end users holding only the
    // project's public anon/service key -- contradicting the documented
    // contract ("captured and shown to the project owner"). Only a verified
    // owner platform-session caller (not 'tenant-public', set by
    // resolveInvokeAuth above) gets logs back now.
    const isOwnerCaller = req.user!.role !== 'tenant-public';
    const responseBody = isOwnerCaller ? result : { ...result, logs: [] };

    if (result.error) {
      res.status(result.status ?? 422).json(responseBody);
    } else {
      res.status(result.status ?? 200).json(responseBody);
    }
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, invokeProjectId));
  }
});

// Note: this comment previously claimed edge-function EXECUTION happens
// entirely on VPS5 and that api.ecomgear.dev never serves tenant/end-user
// traffic. That is NOT what the code above does -- runEdgeFunction() at
// line 278 executes in-process, on this server, right now. Unresolved
// doc/behavior mismatch flagged by the 2026-08 security audit; needs a
// product decision on which side is correct (dispatch to VPS5 for real, or
// update this doc) before being closed. Not decided here.
// write_edge_function.ts and set_secret.ts push code/secrets directly to
// VPS5 (POST https://cloud.ecomgear.app/<schema>/functions/_sync and
// /secrets/_sync) after saving here, so this file's DB rows stay the source
// of truth for the editor/UI while VPS5 holds its own local, invoke-ready copy.

// ── GET /api/v1/functions/:name/logs ────────────────────────────────────────
router.get('/:name/logs', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { data: fn } = await supabase
      .from('edge_functions')
      .select('id')
      .eq('project_id', projectId)
      .eq('name', req.params.name)
      .maybeSingle();
    if (!fn) { res.status(404).json({ error: 'Function not found.' }); return; }

    const { data } = await supabase
      .from('edge_function_logs')
      .select('id, params, result, logs, duration_ms, error, invoked_at')
      .eq('function_id', fn.id)
      .order('invoked_at', { ascending: false })
      .limit(50);

    res.json({ logs: data || [] });
  } catch (err) {
    next(createError(safeErrorMessage(err), 500, projectId));
  }
});

export default router;
