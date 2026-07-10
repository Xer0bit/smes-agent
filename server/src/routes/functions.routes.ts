import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase, supabaseAuth } from '../config/database.js';
import { databaseService, verifyTenantJwt, getOwnerBySchema } from '../services/database.service.js';
import { runEdgeFunction, EcgContext, FunctionContext } from '../services/functionRunner.service.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const invokeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
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
// must be able to reach — they never have an EcomGear platform session, so
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

// Edge functions are project-scoped, not database-scoped — a function that
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
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { data, error } = await supabase
      .from('edge_functions')
      .select('id, name, description, is_active, created_at, updated_at')
      .eq('user_id', req.user!.id)
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ functions: data || [] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/functions/:name ──────────────────────────────────────────────
router.get('/:name', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { data, error } = await supabase
      .from('edge_functions')
      .select('*')
      .eq('user_id', req.user!.id)
      .eq('project_id', projectId)
      .eq('name', req.params.name)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { res.status(404).json({ error: 'Function not found.' }); return; }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
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
router.delete('/:name', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { error } = await supabase
      .from('edge_functions')
      .delete()
      .eq('user_id', req.user!.id)
      .eq('project_id', projectId)
      .eq('name', req.params.name);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/v1/functions/:name/invoke ─────────────────────────────────────
// Public path: a generated app's own end users call this with the project's
// VITE_DB_ANON_KEY (or VITE_DB_SERVICE_KEY) — see resolveInvokeAuth above.
router.post('/:name/invoke', invokeLimiter, resolveInvokeAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const invokeProjectId = getProjectId(req);
    // Optional — a function that never calls db.* should run fine without a
    // provisioned database. runEdgeFunction only errors on db.* calls if this
    // is undefined.
    const creds = await databaseService.getCredentials(req.user!.id, invokeProjectId);

    let fnQuery = supabase
      .from('edge_functions')
      .select('id, code, is_active')
      .eq('user_id', req.user!.id)
      .eq('name', req.params.name);
    // Legacy rows written before project scoping have project_id NULL — only
    // match those when no project_id is known, never mix scoped/unscoped rows.
    fnQuery = invokeProjectId ? fnQuery.eq('project_id', invokeProjectId) : fnQuery.is('project_id', null);
    const { data: fn, error } = await fnQuery.maybeSingle();

    if (error) throw new Error(error.message);
    if (!fn) { res.status(404).json({ error: 'Function not found.' }); return; }
    if (!fn.is_active) { res.status(400).json({ error: 'Function is disabled.' }); return; }

    const params = req.body?.params ?? {};

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
        };
      }
    }

    const dbCtx: FunctionContext | undefined = creds ? {
      apiUrl:     creds.api_url,
      schema:     creds.schema,
      anonKey:    creds.anon_key,
      serviceKey: creds.service_key,
    } : undefined;

    // Expose all saved project secrets as `secrets.KEY_NAME` inside the function
    // sandbox — values never leave this process, they're just readable by the
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

    const result = await runEdgeFunction(fn.code, params, dbCtx, ecgCtx, secrets);

    // persist log (fire-and-forget)
    supabase.from('edge_function_logs').insert({
      user_id:     req.user!.id,
      project_id:  invokeProjectId ?? null,
      function_id: fn.id,
      params,
      result:      result.result,
      logs:        result.logs,
      duration_ms: result.durationMs,
      error:       result.error ?? null,
    }).then(() => {}, () => {});

    if (result.error) {
      res.status(422).json(result);
    } else {
      res.json(result);
    }
  } catch (err) {
    logger.error('[EdgeFunction] invoke error', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/functions/:name/logs ────────────────────────────────────────
router.get('/:name/logs', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const projectId = getProjectId(req);
  if (!projectId) { res.status(400).json({ error: 'project_id is required.' }); return; }
  if (!(await requireProjectAccess(req.user!.id, projectId, res))) return;
  try {
    const { data: fn } = await supabase
      .from('edge_functions')
      .select('id')
      .eq('user_id', req.user!.id)
      .eq('project_id', projectId)
      .eq('name', req.params.name)
      .maybeSingle();
    if (!fn) { res.status(404).json({ error: 'Function not found.' }); return; }

    const { data } = await supabase
      .from('edge_function_logs')
      .select('id, params, result, logs, duration_ms, error, invoked_at')
      .eq('user_id', req.user!.id)
      .eq('function_id', fn.id)
      .order('invoked_at', { ascending: false })
      .limit(50);

    res.json({ logs: data || [] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
