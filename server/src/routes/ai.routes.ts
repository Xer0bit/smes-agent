import { Router, Response } from 'express';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getLlmControlState, getUserPlanTier } from '../services/llm-control.service.js';
import { testAndAutoDisableProviders } from '../services/llm-health.service.js';
import { runAgentLoop, restoreSnapshot } from '../services/agentLoopService.js';
import { DEFAULT_FREE_MODEL } from '../config/models.js';
import { projectService } from '../services/project.service.js';
import { initProjectFromTemplate, ensureBaseTemplate } from '../services/baseTemplateService.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import multer from 'multer';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { classifyRequest, isCheapTier, TIER_MAX_STEPS } from '../services/intentClassifier.js';
import { indexFiles, deleteProjectEmbeddings } from '../knowledgebase/index.js';
import { applySeoToHtml } from './seo.routes.js';

const router = Router();

// Guest model: Gemini Flash for unauthenticated (guest) users   fast, free tier.
const GUEST_MODEL = DEFAULT_FREE_MODEL;
const GUEST_MAX_REQUESTS = 3;
const FINGERPRINT_RE = /^[a-z0-9]{6,40}$/;

// ─── Temp file upload storage ────────────────────────────────────────────────

const UPLOAD_BASE = path.join(os.tmpdir(), 'ecomgear-chat-uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const UPLOAD_TTL_MS = 60 * 60 * 1000;   // 1 hour

// Allowed MIME types
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// Use a single staging directory so multer doesn't need req.body during destination
// (req.body may not be populated yet when diskStorage.destination fires).
// The route handler validates projectId and moves the file to the correct subdir.
const UPLOAD_STAGING = path.join(UPLOAD_BASE, '_staging');

const upload = multer({
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_STAGING, { recursive: true });
      cb(null, UPLOAD_STAGING);
    },
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
});

// Upload attachment → temp storage (no Supabase bucket needed)
router.post('/upload-attachment', authMiddleware, upload.single('file'), (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Validate projectId here   req.body is guaranteed populated by this point.
    const projectId = (req.body as Record<string, string>)?.projectId || '';
    if (!/^[a-f0-9-]{36}$/i.test(projectId)) {
      fs.unlinkSync(req.file.path); // clean up staging file
      res.status(400).json({ error: 'Invalid project ID' });
      return;
    }

    // Move from staging into the project-scoped directory.
    const projectDir = path.join(UPLOAD_BASE, projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    const destPath = path.join(projectDir, path.basename(req.file.path));
    fs.renameSync(req.file.path, destPath);

    // Magic-byte validation for image uploads   prevent disguised executables
    const mime = req.file.mimetype;
    if (mime.startsWith('image/')) {
      let valid = false;
      try {
        const buf = Buffer.alloc(16);
        const fd = fs.openSync(destPath, 'r');
        fs.readSync(fd, buf, 0, 16, 0);
        fs.closeSync(fd);
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) valid = true; // JPEG
        else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
                 buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) valid = true; // PNG
        else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) valid = true; // GIF
        else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                 buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) valid = true; // WebP
        else if (buf[0] === 0x3C || (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF && buf[3] === 0x3C)) valid = true; // SVG (< or BOM+<)
        else {
          // ICO signature
          if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) valid = true;
        }
      } catch { /* if we can't read the file, reject it */ }
      if (!valid) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        res.status(400).json({ error: 'Uploaded file is not a valid image' });
        return;
      }
    }

    logger.info(`[upload-attachment] Stored ${req.file.originalname} (${req.file.size} bytes) → ${destPath}`);
    res.json({
      tempPath: destPath,
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
    });
  } catch (err: any) {
    // Clean up staging file on any unexpected error
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    logger.error(`[upload-attachment] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Auto-cleanup: remove files older than 1 hour every 10 minutes
setInterval(() => {
  try {
    if (!fs.existsSync(UPLOAD_BASE)) return;
    const now = Date.now();
    for (const projectDir of fs.readdirSync(UPLOAD_BASE)) {
      if (projectDir === '_staging') continue; // skip the staging directory
      const projectPath = path.join(UPLOAD_BASE, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;
      for (const fileName of fs.readdirSync(projectPath)) {
        const filePath = path.join(projectPath, fileName);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > UPLOAD_TTL_MS) {
          fs.unlinkSync(filePath);
          logger.info(`[upload-cleanup] Removed expired ${filePath}`);
        }
      }
      // Remove empty project dirs
      if (fs.readdirSync(projectPath).length === 0) {
        fs.rmdirSync(projectPath);
      }
    }
  } catch (err) {
    logger.warn(`[upload-cleanup] ${(err as Error).message}`);
  }
}, 10 * 60 * 1000);

// Per-project concurrency guard   prevents two simultaneous agent runs on the same project.
// Stores abort controller, start time, event bus, and raw SSE chunk buffer for fan-out.
interface ActiveRun {
    abort: () => void;
    startedAt: number;
    bus: EventEmitter;   // fan-out: subscribers (rejoining connections) listen on 'chunk' / 'end'
    buffer: string[];    // raw SSE chunks emitted so far   replayed to new subscribers
}
const activeAgentRuns = new Map<string, ActiveRun>();

// ── Cross-process lock ────────────────────────────────────────────────────
// `activeAgentRuns` above is a module-level Map   it only exists in the memory
// of THIS PM2 worker process. This server runs in PM2 cluster mode (multiple
// worker processes sharing the same filesystem but NOT the same memory), so
// two requests for the same project can land on different workers and never
// see each other's in-memory guard at all. Both then read/write the SAME
// shared project directory on disk with zero coordination   a genuine race
// where one run's file write (or its end-of-run rollback) can be silently
// stomped by the other run's concurrent write, moments apart, with nothing in
// any log to explain why. A plain file lock works here because   unlike the
// in-memory Map   the filesystem itself IS shared across every worker.
// Generous ceiling above the longest real AGENT_TIMEOUT_MS (see agentLoopService.ts
// getDefaultAgentTimeoutMs) so a genuinely still-running request is never treated
// as stale, while a lock left behind by a crashed/killed worker doesn't wedge a
// project forever.
const AGENT_LOCK_STALE_MS = 15 * 60_000;

// Lock lives in the `agent_locks` DB table (not a local tmpfile) because the
// preview-service pushing files for a run lives on a *different machine*
// (VPS2) than the gen workers (VPS3) that hold this lock. A local file lock
// only ever protected same-node PM2-cluster races; it was invisible to
// preview-service's own /update endpoint, which happily accepted any push  
// including a direct manual push racing a live agent run on another actor
// entirely (a real production incident: a direct file push during an active
// run silently stomped the run's own writes, moments apart). The DB row is
// visible to every VPS via PostgREST, and the token in it lets preview-service
// tell "this push came from the run that holds the lock" apart from anything
// else   see preview-service/server.js's /update handler.
function randomToken(): string {
    return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Try to acquire the cross-process, cross-machine lock for a project. Returns
 *  the lock token to use on this run's preview-service pushes if acquired
 *  (including by reclaiming a stale lock left behind by a dead worker), or
 *  null if another worker genuinely holds it right now. */
async function tryAcquireAgentLock(projectId: string): Promise<string | null> {
    const token = randomToken();
    const { error: insertError } = await supabase
        .from('agent_locks')
        .insert({ project_id: projectId, token, owner: `pid:${process.pid}` });

    if (!insertError) return token;

    // Row already exists   check whether it's stale (a worker that crashed/was
    // killed without reaching the finally-block release below).
    const { data: existing, error: selectError } = await supabase
        .from('agent_locks')
        .select('acquired_at')
        .eq('project_id', projectId)
        .maybeSingle();

    if (selectError) {
        // Unexpected error (network, RLS, etc.)   fail open rather than
        // blocking every generation request because locking itself broke.
        logger.warn(`[agent-lock] Unexpected error checking lock for ${projectId}, allowing request: ${selectError.message}`);
        return token;
    }

    const age = existing ? Date.now() - new Date(existing.acquired_at).getTime() : Infinity;
    if (age > AGENT_LOCK_STALE_MS) {
        logger.warn(`[agent-lock] Reclaiming stale lock for ${projectId} (age ${Math.round(age / 1000)}s)`);
        const { error: updateError } = await supabase
            .from('agent_locks')
            .update({ token, owner: `pid:${process.pid}`, acquired_at: new Date().toISOString() })
            .eq('project_id', projectId);
        if (!updateError) return token;
    }

    return null;
}

async function releaseAgentLock(projectId: string): Promise<void> {
    try {
        await supabase.from('agent_locks').delete().eq('project_id', projectId);
    } catch { /* best-effort   a stale-lock reclaim will clean up eventually */ }
}

// ─── Per-user rate limiting for /agent-stream ────────────────────────────────
// Sliding window: max N requests per user within WINDOW_MS.
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;           // max 10 agent starts per minute per user
const userRequestTimestamps = new Map<string, number[]>();
const INCREMENT_AI_GEN_SIGNATURE_RE = /(function\s+increment_ai_gen\([^)]*\)\s+does\s+not\s+exist|could\s+not\s+find\s+the\s+function\s+.*increment_ai_gen|could\s+not\s+choose\s+the\s+best\s+candidate\s+function\s+between)/i;

function isRateLimited(userId: string): boolean {
    const now = Date.now();
    const timestamps = userRequestTimestamps.get(userId) ?? [];
    // Prune entries outside the window
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
        userRequestTimestamps.set(userId, recent);
        return true;
    }
    recent.push(now);
    userRequestTimestamps.set(userId, recent);
    return false;
}

async function resolveEffectiveOrgIdForEco(userId: string, projectId: string, requestedOrgId?: string): Promise<string | null> {
    const orgCandidates = new Set<string>();

    try {
        const { data: memberships, error: membershipsError } = await supabase
            .from('org_members')
            .select('org_id')
            .eq('user_id', userId);

        if (membershipsError) {
            logger.warn(`[agent-stream] Failed to read org memberships for ${userId}: ${membershipsError.message}`);
        }

        for (const row of memberships ?? []) {
            const oid = (row as { org_id?: string | null }).org_id;
            if (typeof oid === 'string' && oid.length > 0) {
                orgCandidates.add(oid);
            }
        }
    } catch (err) {
        logger.warn(`[agent-stream] Membership lookup failed for ${userId}: ${(err as Error).message}`);
    }

    // Prefer an explicitly selected org when it is one of the user's memberships.
    if (requestedOrgId && orgCandidates.has(requestedOrgId)) {
        return requestedOrgId;
    }

    // Fallback: use project org when membership sync has not happened yet.
    try {
        const project = await projectService.getProject(projectId, userId) as unknown as Record<string, unknown>;
        const projectOrgId = typeof project.org_id === 'string' ? project.org_id : '';
        if (projectOrgId) {
            orgCandidates.add(projectOrgId);
            if (requestedOrgId && requestedOrgId === projectOrgId) {
                return requestedOrgId;
            }
        }
    } catch (err) {
        logger.warn(`[agent-stream] Project org lookup failed for ${projectId}: ${(err as Error).message}`);
    }

    // Fallback: org owner flow (users who created an org but are missing membership rows).
    try {
        if (requestedOrgId) {
            const { data: ownedRequested } = await supabase
                .from('organizations')
                .select('id')
                .eq('id', requestedOrgId)
                .eq('created_by', userId)
                .limit(1)
                .maybeSingle();
            if (ownedRequested?.id) {
                return ownedRequested.id;
            }
        }

        const { data: ownedOrg, error: ownedOrgError } = await supabase
            .from('organizations')
            .select('id')
            .eq('created_by', userId)
            .limit(1)
            .maybeSingle();

        if (ownedOrgError) {
            logger.warn(`[agent-stream] Owned org lookup failed for ${userId}: ${ownedOrgError.message}`);
        }

        if (ownedOrg?.id) {
            orgCandidates.add(ownedOrg.id);
        }
    } catch (err) {
        logger.warn(`[agent-stream] Organization fallback lookup failed for ${userId}: ${(err as Error).message}`);
    }

    return orgCandidates.values().next().value ?? null;
}


async function isWithinEcoPolicyLimit(orgId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('organizations')
        .select('ai_gens_limit, ai_gens_used, ai_gens_reset_at')
        .eq('id', orgId)
        .limit(1)
        .maybeSingle();

    if (error || !data) {
        logger.warn(`[agent-stream] Failed to read eco policy inputs for org ${orgId}: ${error?.message || 'not found'}`);
        return true;
    }

    const d = data as Record<string, unknown>;
    // Use the DB column (set by sync_org_plan_limits trigger) so admin overrides are respected.
    const policyLimit = Number(d.ai_gens_limit ?? 10);
    const used = Number(d.ai_gens_used ?? 0);
    const resetAtRaw = d.ai_gens_reset_at;
    const resetAt = typeof resetAtRaw === 'string' ? Date.parse(resetAtRaw) : NaN;

    // If the reset window has elapsed, allow this request and let DB RPC roll usage forward.
    if (Number.isFinite(resetAt) && resetAt <= Date.now()) {
        return true;
    }

    return used < policyLimit;
}

async function incrementEcoUsage(orgId: string): Promise<{ allowed: boolean; source: 'v2' | 'legacy'; error?: string }> {
    // Each code-writing run costs exactly 1 eco unit regardless of token count.
    // Token-based scaling was removed because thinking models (gemini-3.1-pro-preview)
    // can use 100K+ tokens per run, which would drain free-tier budgets in a single request.
    // The DB function increment_ai_gen already enforces the limit atomically with FOR UPDATE,
    // so the redundant pre-check here is omitted.
    const v2 = await supabase.rpc('increment_ai_gen', {
        p_org_id: orgId,
        p_tokens: 1,
    } as any);

    if (!v2.error) {
        return { allowed: v2.data !== false, source: 'v2' };
    }

    const message = v2.error.message || '';
    const shouldTryLegacy = INCREMENT_AI_GEN_SIGNATURE_RE.test(message);
    if (!shouldTryLegacy) {
        return { allowed: false, source: 'v2', error: message || 'increment_ai_gen failed' };
    }

    logger.warn(`[agent-stream] increment_ai_gen v2 unavailable, trying legacy signature for org ${orgId}`);
    const legacy = await supabase.rpc('increment_ai_gen', { p_org_id: orgId } as any);
    if (legacy.error) {
        return {
            allowed: false,
            source: 'legacy',
            error: legacy.error.message || message || 'increment_ai_gen failed',
        };
    }

    return { allowed: legacy.data !== false, source: 'legacy' };
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [uid, ts] of userRequestTimestamps) {
        const recent = ts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length === 0) userRequestTimestamps.delete(uid);
        else userRequestTimestamps.set(uid, recent);
    }
}, 5 * 60_000).unref();

// Legacy non-stream endpoint retired in favor of /agent-stream.
router.post('/generate', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const operationId = (req.headers['x-operation-id'] as string | undefined) || `generate-${Date.now()}`;
    const apiVersion = (req.headers['x-api-version'] as string | undefined) || '1.0';

    res.status(410).json({
        success: false,
        error: 'The /generate endpoint is retired. Use /api/v1/ai/agent-stream instead.',
        operationId,
        apiVersion,
        migrationPath: '/api/v1/ai/agent-stream',
    });
});

// Re-test all LLM providers and auto-disable failing ones.
// Called by the admin Settings panel "Test Providers" button.
router.post('/test-providers', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (!req.user?.id) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
        }
        const { data, error: roleError } = await supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', req.user.id)
            .in('role', ['super_admin', 'admin'])
            .maybeSingle();
        if (roleError || !data) {
            res.status(403).json({ success: false, error: 'Admin access required' });
            return;
        }
        const results = await testAndAutoDisableProviders();
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// Allowed AI models for frontend selector   gated by subscription tier.
// Guests:      Gemini Flash (fast, free)
// Free users:  DeepSeek (everyday tasks) + Gemini Flash (fast, free)
// Paid users:  Claude (EcomSmart) + DeepSeek (everyday) + Gemini (fast)
router.get('/models', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const control = await getLlmControlState();
        const keyConfigured = {
            anthropic: Boolean(control.apiKeys.anthropic),
            deepseek: Boolean(control.apiKeys.deepseek),
            gemini: Boolean(control.apiKeys.gemini),
            zai: Boolean(control.apiKeys.zai),
        };

        const providerEnabled = {
            anthropic: control.providers.anthropic.enabled,
            deepseek: control.providers.deepseek.enabled,
            gemini: control.providers.gemini.enabled,
            zai: control.providers.zai.enabled,
        };

        const allAllowed = control.models.allowed.filter((entry) => {
            const provider = entry.provider;
            return providerEnabled[provider] && keyConfigured[provider];
        });

        if (allAllowed.length === 0) {
            return res.status(503).json({
                success: false,
                error: 'No AI providers are currently configured. Add at least one API key in Admin settings.',
            });
        }

        // Determine the user's tier and restrict accordingly.
        const userId = req.user?.id;

        // Dev mode: expose all configured models without auth so local testing works
        if (!userId && process.env.NODE_ENV === 'development') {
            const primary = allAllowed.find((m) => m.id === control.models.primary) || allAllowed[0];
            return res.json({ success: true, primary: primary.id, allowed: allAllowed });
        }

        // Guest (no token)   only Gemini
        if (!userId) {
            const guestEntry = allAllowed.find((m) => m.id === GUEST_MODEL) || allAllowed[0];
            return res.json({ success: true, primary: guestEntry.id, allowed: [guestEntry], isGuest: true });
        }

        const tier = await getUserPlanTier(userId);

        if (tier === 'free') {
            // Free users get only DeepSeek + Gemini 2.5 models.
            const freeModels = allAllowed.filter((m) => {
                const id = m.id.toLowerCase();
                return id.includes('deepseek') || id.includes('gemini-2.5');
            });
            const freeModelId = control.models.freeModel || DEFAULT_FREE_MODEL;
            const defaultFree = freeModels.find((m) => m.id === freeModelId) || freeModels[0] || allAllowed[0];
            return res.json({ success: true, primary: defaultFree.id, allowed: freeModels.length > 0 ? freeModels : [defaultFree] });
        }

        // Paid users get all enabled models: Claude (primary/EcomSmart) + DeepSeek (everyday) + Gemini (fast)
        const primary = allAllowed.some((m) => m.id === control.models.primary)
            ? control.models.primary
            : (allAllowed[0]?.id || control.models.primary);

        res.json({
            success: true,
            primary,
            allowed: allAllowed,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: (error as Error).message,
        });
    }
});

function sseWrite(res: Response, event: string, data: unknown): void {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const EXECUTE_BUILD_RE = /\b(execute|apply (?:the )?plan|build (?:it|this|now)|implement (?:it|this|now)|start (?:building|coding)|go ahead(?: and)? (?:build|implement)|continue(?: (?:with )?(?:build|implementation))?|ship it|do you know what to do|do it|go on|let's go|lets go|proceed|begin(?: building| coding)?|yes[,!.\s]*(go|build|do it|please|let's|lets)|^(?:yes|yep|yeah|ok|okay|sure|yup|go|build|start|begin|do it)[.!\s]*$)\b/i;

function shouldAutoPlan(prompt: string): boolean {
    const text = prompt.trim();
    if (!text) return false;

    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const bulletLines = lines.filter((line) => /^([-*]|\d+[).\]])\s+/.test(line)).length;
    const sectionLines = lines.filter((line) => /^#{1,6}\s+/.test(line) || /:\s*$/.test(line)).length;
    const requirementHits = (text.match(/\b(requirements?|must|should|constraints?|deliverables?|acceptance criteria|architecture|database|api|routes?|pages?|features?|workflow|integrations?)\b/gi) ?? []).length;

    const longPrompt = words >= 140 || text.length >= 900;
    const structuredPrompt = bulletLines >= 4 || sectionLines >= 2;
    const constrainedPrompt = requirementHits >= 4 && words >= 80;

    return longPrompt || (structuredPrompt && words >= 70) || constrainedPrompt;
}

function resolveAgentMode(prompt: string, clientMode?: 'build' | 'plan'): 'build' | 'plan' {
    if (clientMode === 'build' || clientMode === 'plan') {
        return clientMode;
    }

    if (EXECUTE_BUILD_RE.test(prompt)) {
        return 'build';
    }

    return shouldAutoPlan(prompt) ? 'plan' : 'build';
}

// Trim conversation history to a token budget (newest-first), instead of a fixed
// message count   long messages no longer blow the context window. ~4 chars/token.
function trimHistoryToTokenBudget(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    maxTokens: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
    if (!history || history.length === 0 || maxTokens <= 0) return [];
    let total = 0;
    const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const content = history[i].content;
        const msgChars = typeof content === 'string' ? content.length : JSON.stringify(content).length;
        const msgTokens = Math.ceil(msgChars / 4);
        if (total + msgTokens > maxTokens) break;
        result.unshift(history[i]);
        total += msgTokens;
    }
    return result;
}

const HISTORY_TOKEN_BUDGET: Record<string, number> = {
    micro: 0, fix: 1000, edit: 2000, feature: 4000, build: 8000,
};

// Streaming agent endpoint used by frontend promptService/AgentChatPanel.
// Supports both authenticated users and guest (unauthenticated) users.
// Guests must provide a `fingerprint` and are limited to GUEST_MAX_REQUESTS total.
router.post('/agent-stream', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { prompt, projectId, orgId, existingFiles, model, mode, history, olderSummary, attachments, fingerprint } = req.body as {
        prompt?: string;
        projectId?: string;
        orgId?: string;
        existingFiles?: Array<{ path: string; content: string }>;
        model?: string;
        mode?: 'build' | 'plan';
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
        olderSummary?: string;
        attachments?: Array<{
            name: string;
            type: string;
            category: 'image' | 'document';
            tempPath: string;
        }>;
        fingerprint?: string;
    };

    if (!prompt || !projectId) {
        res.status(400).json({ error: 'prompt and projectId are required' });
        return;
    }

    const isGuest = !req.user;

    // ── Guest validation ─────────────────────────────────────────────────
    if (isGuest) {
        if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
            res.status(401).json({ error: 'Authentication required. Please log in or provide a valid guest fingerprint.' });
            return;
        }

        // Check guest AI request limit (max 3)
        try {
            const { data, error } = await supabase
                .rpc('check_and_increment_guest_ai_request', { p_fingerprint: fingerprint });
            if (error) {
                logger.error(`[agent-stream] Guest RPC error: ${error.message}`);
                res.status(500).json({ error: 'Failed to validate guest session' });
                return;
            }
            if (data === false) {
                res.status(403).json({
                    error: 'guest_limit_reached',
                    message: `You've used all ${GUEST_MAX_REQUESTS} free generations. Please sign up to continue.`,
                    requestsUsed: GUEST_MAX_REQUESTS,
                    requestsLimit: GUEST_MAX_REQUESTS,
                });
                return;
            }
        } catch (err) {
            logger.error(`[agent-stream] Guest limit check failed: ${(err as Error).message}`);
            res.status(500).json({ error: 'Guest validation failed' });
            return;
        }

        logger.info(`[agent-stream] Guest request (fp=${fingerprint.slice(0, 8)}...) for project ${projectId}`);
    }

    // Per-user rate limit   prevent abuse / accidental rapid-fire requests
    const rateLimitUserId = req.user?.id || (fingerprint ? `guest:${fingerprint}` : undefined);
    if (rateLimitUserId && isRateLimited(rateLimitUserId)) {
        res.status(429).json({ error: 'Too many requests. Please wait a moment before starting another generation.' });
        return;
    }

    // Concurrency guard   if a run is already active for this project, subscribe this new
    // SSE connection to it (fan-out) rather than starting a new run and charging eco again.
    // Must be checked BEFORE eco deduction so reconnects don't double-count usage.
    const existingRunEarly = activeAgentRuns.get(projectId);
    if (existingRunEarly) {
        const ageMs = Date.now() - existingRunEarly.startedAt;
        logger.info(`[agent-stream] Project ${projectId} has active run (age ${ageMs}ms)   subscribing new connection`);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        for (const chunk of existingRunEarly.buffer) {
            if (!res.writableEnded) res.write(chunk);
        }

        const onChunkEarly = (chunk: string) => { if (!res.writableEnded) res.write(chunk); };
        const onEndEarly = () => { if (!res.writableEnded) res.end(); };
        existingRunEarly.bus.on('chunk', onChunkEarly);
        existingRunEarly.bus.once('end', onEndEarly);
        req.on('close', () => {
            existingRunEarly.bus.off('chunk', onChunkEarly);
            existingRunEarly.bus.off('end', onEndEarly);
        });
        return;
    }

    // ── Backend eco enforcement ─────────────────────────────────────────────
    // Check budget BEFORE running the agent (no deduction yet   charge only if
    // files are actually written). Ghost runs (text-only answers) are free.
    // Guests use their own separate limit (checked above), so skip here.
    // Set DISABLE_ECO_ENFORCEMENT=true in .env to bypass for local development.
    const ecoEnforced = process.env.DISABLE_ECO_ENFORCEMENT !== 'true';
    // Org that will be charged after the run if files were written.
    let ecoOrgId: string | null = null;
    if (!isGuest && req.user?.id && ecoEnforced) {
        try {
            const effectiveOrgId = await resolveEffectiveOrgIdForEco(req.user.id, projectId, orgId);
            ecoOrgId = effectiveOrgId ?? null;
            if (!effectiveOrgId) {
                // No org context   log and allow rather than block. Eco will not be tracked
                // for this run, but we should not prevent the user from using the product.
                logger.warn(`[agent-stream] No org found for eco debit (user=${req.user.id}, project=${projectId})   allowing request without eco tracking`);
            } else {
                // Budget check only   no deduction. Deduction happens post-run if files written.
                const withinLimit = await isWithinEcoPolicyLimit(effectiveOrgId);
                if (!withinLimit) {
                    // Genuine limit reached   block
                    logger.info(`[agent-stream] Eco limit reached for user ${req.user.id} (org ${effectiveOrgId})`);
                    res.status(429).json({
                        error: 'Monthly eco limit reached. Please upgrade your plan or wait for the reset.',
                        code: 'ECO_LIMIT_REACHED',
                    });
                    return;
                }
            }
        } catch (ecoErr) {
            // Eco system unavailable   log and allow rather than block the user
            logger.warn(`[agent-stream] Eco validation error (allowing request): ${(ecoErr as Error).message}`);
        }
    }

    // Cross-process guard   see tryAcquireAgentLock's comment above. The
    // in-memory `activeAgentRuns` check earlier only catches a duplicate on
    // THIS worker; this catches one on any other worker in the cluster. There
    // is no cheap way to fan out this second worker's SSE stream to the first
    // (would need real cross-process IPC), so unlike the in-memory case this
    // just rejects cleanly instead of silently racing on the shared project
    // files.
    const agentLockToken = await tryAcquireAgentLock(projectId);
    if (!agentLockToken) {
        res.status(429).json({
            error: 'A generation is already running for this project (on another server process). Please wait for it to finish before starting another.',
            code: 'PROJECT_LOCKED',
        });
        return;
    }

    const routeAbortController = new AbortController();
    const abortRun = () => {
        if (!routeAbortController.signal.aborted) {
            routeAbortController.abort();
        }
    };

    const currentRunBus = new EventEmitter();
    currentRunBus.setMaxListeners(50);
    const currentRun: ActiveRun = { abort: abortRun, startedAt: Date.now(), bus: currentRunBus, buffer: [] };
    activeAgentRuns.set(projectId, currentRun);

    req.on('close', () => {
        // Give the client 5 minutes to navigate back and reconnect before aborting the run.
        // This allows the agent to keep running in the background when the user leaves the page.
        if (!res.writableEnded) {
            setTimeout(() => {
                if (!routeAbortController.signal.aborted && currentRun.bus.listenerCount('chunk') === 0) {
                    abortRun();
                }
            }, 300_000);
        }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    // Intercept res.write so every SSE chunk is also broadcast to fan-out subscribers.
    // Cap the replay buffer at 2000 entries to prevent unbounded memory growth for
    // very long generations. Reconnecting clients will still get the most recent
    // output; they'll only miss very old chunks from the start of the run.
    const SSE_BUFFER_CAP = 2000;
    const originalWrite = res.write.bind(res);
    (res as any).write = (chunk: any, ...args: any[]): boolean => {
        const str: string = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (currentRun.buffer.length < SSE_BUFFER_CAP) {
            currentRun.buffer.push(str);
        }
        currentRun.bus.emit('chunk', str);
        return originalWrite(chunk, ...args);
    };

    let agentResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;

    try {
        // ── Model selection ─────────────────────────────────────────────
        let effectiveModel: string;
        const userId = req.user?.id || `guest:${fingerprint || 'unknown'}`;
        const control = await getLlmControlState();

        // Fetch project record once (authenticated path only)   reused for both
        // model selection and server-path resolution below to avoid a double DB hit.
        let projectRecord: Record<string, unknown> = {};
        if (isGuest) {
            // Guests are forced to Gemini   no choice
            effectiveModel = GUEST_MODEL;
            logger.info(`[agent-stream] Guest user   forcing model to "${effectiveModel}"`);
        } else {
            // Authenticated user   normal tier logic
            projectRecord = await projectService.getProject(projectId, req.user!.id) as unknown as Record<string, unknown>;

            // getProject() above only checks "has ANY access"   it doesn't distinguish
            // a full editor from a read-only viewer/client collaborator. Without this,
            // any accepted collaborator (regardless of the role they were invited with)
            // could invoke the agent to generate/modify code, since role was never
            // enforced anywhere. Owners/admins/editors can generate; viewers/clients
            // cannot   this is the actual "edit the project" action.
            const projectRole = await projectService.getUserRole(projectId, req.user!.id);
            if (projectRole === 'viewer' || projectRole === 'client') {
                res.status(403).json({ error: 'You have read-only access to this project and cannot generate or modify code.' });
                return;
            }

            const tier = await getUserPlanTier(req.user!.id);
   
               if (tier === 'free') {
                   // Free users: GLM models only (fast, cost-effective).
                   const allowedFreeModels = ['glm-4.5-flash', 'glm-4.7-flash', 'glm-4.5'];
                   effectiveModel = (model && allowedFreeModels.some(m => model.toLowerCase() === m.toLowerCase()))
                       ? model
                       : (control.models.freeModel || DEFAULT_FREE_MODEL);
               } else {
                   // Paid users: Gemini / Sonnet via admin-configured primary, or user's picker choice.
                   effectiveModel = model || control.models.primary;
               }

               if (tier === 'free' && model && !['glm'].some(m => model.toLowerCase().includes(m))) {
                   logger.info(`[agent-stream] Free user ${req.user!.id} requested restricted model "${model}"   overriding to "${effectiveModel}"`);
               }
        }

        const effectiveMode = resolveAgentMode(prompt, mode);
        logger.info(`[agent-stream] Mode resolved: ${effectiveMode} (clientMode=${mode ?? 'auto'})`);

        const projectServerPath = typeof (projectRecord as any).server_path === 'string'
            ? (projectRecord as any).server_path
            : '';
        const projectKnowledge = {
            customSystemPrompt: typeof (projectRecord as any).custom_system_prompt === 'string' ? (projectRecord as any).custom_system_prompt.trim() : '',
            contextNotes: typeof (projectRecord as any).context_notes === 'string' ? (projectRecord as any).context_notes.trim() : '',
        };

        // Fetch project secrets (key=value pairs injected as env vars for the agent).
        // buildProjectEnvSecrets is the SINGLE source of truth for auth/DB/functions
        // env vars   do not re-derive any of these locally here. This file used to
        // independently recompute VITE_FUNCTIONS_API_URL/VITE_SUPABASE_* with its own
        // fallback logic and silently diverged from database.service.ts (wrong
        // gen.ecomgear.dev fallback, missing VITE_SUPABASE_URL entirely).
        let projectSecrets: Array<{ key_name: string; key_value: string }> = [];
        try {
            const { buildProjectEnvSecrets } = await import('../services/database.service.js');
            projectSecrets = await buildProjectEnvSecrets(userId, projectId);
        } catch {
            // Non-fatal   agent can still discover credentials via get_database_schema tool
        }

        // Sync VITE_* secrets to the preview service so the live preview actually has
        // real values for import.meta.env.VITE_DB_API_URL etc.   previously nothing wrote
        // these anywhere the running Vite dev server could see them, so every hosted-DB/
        // auth/edge-function call in the preview silently had no real URL/key to use.
        // Fire-and-forget: this must never block or fail the agent run.
        (async () => {
            try {
                const viteSecrets = projectSecrets.filter(s => s.key_name.startsWith('VITE_'));
                if (viteSecrets.length === 0) return;
                const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001';
                const previewUpdateSecret = process.env.PREVIEW_UPDATE_SECRET || '';
                await fetch(`${previewServiceUrl}/preview/${projectId}/secrets`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(previewUpdateSecret ? { 'x-update-secret': previewUpdateSecret } : {}),
                    },
                    body: JSON.stringify({ secrets: viteSecrets }),
                    signal: AbortSignal.timeout(10_000),
                });
            } catch {
                // Non-fatal   preview will just lack real secrets until the next successful sync
            }
        })();

        // Resolve the agent working directory.
        //
        // Priority:
        //  1. DB-stored server_path (set explicitly for production deployments)
        //  2. SERVER_PROJECTS_DIR env var → persistent directory
        //  3. Production: /var/ecomgear/projects/{projectId} (persistent, survives restarts)
        //  4. Local dev: ~/.ecomgear/preview/{projectId}
        const IS_PRODUCTION = process.env.NODE_ENV === 'production';
        let appPath: string;
        if (projectServerPath) {
            appPath = String(projectServerPath);
        } else if (process.env.SERVER_PROJECTS_DIR) {
            appPath = path.join(process.env.SERVER_PROJECTS_DIR, projectId);
        } else if (IS_PRODUCTION) {
            appPath = path.join('/var/ecomgear/projects', projectId);
        } else {
            const localBase = process.env.LOCAL_PREVIEW_DATA
                || path.join(os.homedir(), '.ecomgear', 'preview');
            appPath = path.join(localBase, projectId);
        }

        await fs.promises.mkdir(appPath, { recursive: true });

        // Copy pre-installed node_modules from the golden template (near-instant
        // via hard links). Race against a 10 s timeout so a slow npm install
        // (first-run template bootstrap) never blocks the agent from starting.
        try {
            await Promise.race([
                initProjectFromTemplate(appPath),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('template init timeout')), 10_000)
                ),
            ]);
        } catch (templateErr) {
            logger.warn(`[agent-stream] Template init skipped: ${(templateErr as Error).message}`);
        }

        // ── Intent classification + cost routing ─────────────────────────────
        // Classify the request tier (zero LLM cost   pure regex) so we can:
        //   1. Right-size MAX_STEPS in the agent loop
        //   2. Route micro requests to the cheap model (Gemini Flash)
        // isEmptyProject: no user files on disk = this is a fresh project.
        const projectHasFiles = fs.existsSync(appPath)
            && fs.readdirSync(appPath).some(f => !['node_modules', '.git', 'dist'].includes(f));

        // Detect auto-repair prompts (from the frontend Repair button or auto-fix escalation).
        // These MUST use the user's selected model with full context   routing them to a cheap
        // model with a stripped prompt is what causes infinite repair loops.
        const isRepairPrompt = /build errors that could not be auto-repaired|please fix all of them|auto.?repair|🔧/i.test(prompt);
        const requestTier = isRepairPrompt ? 'feature' : classifyRequest(prompt, !projectHasFiles);

        // Tier-based model routing:
        //   micro → Gemini Flash  (visual tweaks, $0.075/MTok   40× cheaper than Sonnet)
        //   micro → free model (glm-4.7-flash by default   visual tweaks)
        //   fix   → fallback model (glm-5 by default   error diagnosis)
        //   edit/feature/build → user's selected model / admin primary
        // Guests always stay on GUEST_MODEL regardless.
        if (!isGuest) {
            if (isCheapTier(requestTier)) {
                const cheapModel = process.env.CHEAP_TASK_MODEL || control.models.freeModel || DEFAULT_FREE_MODEL;
                logger.info(`[agent-stream] Tier=${requestTier} → cheap model: ${cheapModel} (was ${effectiveModel})`);
                effectiveModel = cheapModel;
            } else if (requestTier === 'fix') {
                const fixModel = process.env.FIX_TIER_MODEL || control.models.fallback || DEFAULT_FREE_MODEL;
                logger.info(`[agent-stream] Tier=fix → fix model: ${fixModel} (was ${effectiveModel})`);
                effectiveModel = fixModel;
            }
        }

        logger.info(`[agent-stream] Request tier=${requestTier} maxSteps=${TIER_MAX_STEPS[requestTier]} model=${effectiveModel}`);

        // ── Fast path: pure questions / chit-chat skip the full agent loop ─────
        // Conversational messages that aren't about existing project code can be
        // answered directly by a cheap model   no tool calls, no file syncing.
        const QUESTION_RE = /^(what|how|why|where|when|explain|describe|tell me|show me|can you tell|does|is |are |who|which)\b/i;
        const GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|sure|great|nice|cool|perfect|sounds good)\b[.!?]?\s*$/i;
        const trimmedPrompt = prompt.trim();
        const isConversational = (QUESTION_RE.test(trimmedPrompt) || GREETING_RE.test(trimmedPrompt))
            && trimmedPrompt.length < 200
            && !projectHasFiles; // questions about existing code still need the agent

        if (isConversational) {
            logger.info(`[agent-stream] Fast path (conversational)   bypassing agent loop`);
            sseWrite(res, 'start', { projectId, model: 'fast-path', mode: effectiveMode });

            const anthropicKey = process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
            const geminiKey = process.env.GEMINI_API_KEY;
            let fastModel: any = null;
            if (anthropicKey && process.env.AI_DISABLE_ANTHROPIC !== '1') {
                fastModel = createAnthropic({ apiKey: anthropicKey })('claude-haiku-4-5-20251001');
            } else if (geminiKey && process.env.AI_DISABLE_GEMINI !== '1') {
                fastModel = createGoogleGenerativeAI({ apiKey: geminiKey })('gemini-flash-latest');
            }

            if (fastModel) {
                try {
                    const { text } = await generateText({
                        model: fastModel,
                        maxOutputTokens: 400,
                        temperature: 0.5,
                        system: `You are EcomGear AI, an app builder. Answer briefly and helpfully. Rules: NO emojis. Do not use the em dash character. Sound like a calm human teammate, not a bot. Never start a reply with phrases like "Great question", "Absolutely", "Of course", or "I would be happy to".`,
                        prompt: trimmedPrompt,
                    });
                    sseWrite(res, 'text-delta', { text });
                } catch (fastErr) {
                    logger.warn(`[agent-stream] Fast path LLM failed, falling back to agent loop: ${(fastErr as Error).message}`);
                    fastModel = null; // fall through to the agent loop below
                }
            }

            if (fastModel) {
                sseWrite(res, 'done', { mode: effectiveMode, summary: '', tokensUsed: 0 });
                return;
            }
        }

        agentResult = await runAgentLoop({
            prompt,
            projectId,
            appPath,
            model: effectiveModel,
            mode: effectiveMode,
            existingFiles: Array.isArray(existingFiles) ? existingFiles : [],
            history: (() => {
              if (!Array.isArray(history)) return [];
              // Trim by token budget per tier (not message count) so long messages
              // can't blow the context window   micro tasks are one-shot, no context.
              const budget = HISTORY_TOKEN_BUDGET[requestTier] ?? 2000;
              const bounded = trimHistoryToTokenBudget(history, budget);
              return bounded.length > 0 && bounded[0].role !== 'user' ? bounded.slice(1) : bounded;
            })(),
            olderSummary: typeof olderSummary === 'string' ? olderSummary : undefined,
            attachments: Array.isArray(attachments) ? attachments : undefined,
            projectKnowledge,
            projectSecrets,
            promptIntent: {
                requestTier,
                isWebsiteBuild: requestTier === 'build',
                hasIntegrationRequest: /\b(database|supabase|api|connect|integration|webhook|backend)\b/i.test(prompt),
            },
            sink: {
                emit: (event, data) => sseWrite(res, event, data),
                heartbeat: () => { if (!res.writableEnded) res.write(': heartbeat\n\n'); },
            },
            userId,
            abortSignal: routeAbortController.signal,
            agentLockToken,
        });

        // Auto-reapply saved SEO settings whenever the agent writes a new index.html.
        // This prevents agent rebuilds from overwriting previously-synced SEO tags.
        if (agentResult && projectId && !isGuest) {
            const wroteIndex = (agentResult.filesToWrite ?? []).some(
                f => f.path === 'index.html' || f.path === '/index.html',
            );
            if (wroteIndex) {
                // fire-and-forget   never block the response
                (async () => {
                    try {
                        const { data: setting } = await supabase
                            .from('project_settings')
                            .select('setting_value')
                            .eq('project_id', projectId)
                            .eq('setting_key', 'seo')
                            .maybeSingle();
                        const seo = setting?.setting_value as Record<string, string> | null;
                        if (seo && (seo.title || seo.description)) {
                            const htmlPath = path.join(appPath, 'index.html');
                            if (fs.existsSync(htmlPath)) {
                                const html = fs.readFileSync(htmlPath, 'utf8');
                                const updated = applySeoToHtml(html, seo);
                                if (updated !== html) {
                                    fs.writeFileSync(htmlPath, updated, 'utf8');
                                    logger.info(`[agent-stream] Auto-applied SEO tags to rebuilt index.html for ${projectId}`);
                                }
                            }
                        }
                    } catch (seoErr) {
                        logger.warn(`[agent-stream] Auto-SEO reapply failed: ${(seoErr as Error).message}`);
                    }
                })();
            }
        }
    } catch (error) {
        if ((error as { clientAborted?: boolean }).clientAborted || routeAbortController.signal.aborted) {
            logger.warn(`[agent-stream] Client disconnected, cancelled run for project ${projectId}`);
        } else {
            const message = (error as Error).message;
            logger.error(`[agent-stream] Error: ${message}`);

            if (!(error as { sseErrorEmitted?: boolean }).sseErrorEmitted) {
                sseWrite(res, 'error', { message });
            }
        }
    } finally {
        // Charge eco only if the agent actually wrote or deleted files.
        // Ghost runs (text-only answers, plan proposals) are free.
        const wroteFiles = (agentResult?.filesToWrite?.length ?? 0) > 0
            || (agentResult?.filesToDelete?.length ?? 0) > 0;
        if (ecoOrgId && wroteFiles) {
            // 1 eco per code-writing run (flat). Token-based scaling removed   see incrementEcoUsage.
            incrementEcoUsage(ecoOrgId).catch((err) =>
                logger.warn(`[agent-stream] Eco charge failed for org ${ecoOrgId}: ${(err as Error).message}`),
            );
        }

        activeAgentRuns.delete(projectId);
        await releaseAgentLock(projectId);
        currentRun.bus.emit('end');
        currentRun.bus.removeAllListeners();
        if (!res.writableEnded) {
            res.end();
        }
    }
});

// Find the outermost JSON array using bracket-depth counting (handles nested brackets in suggestions)
function extractOutermostJsonArray(text: string): unknown[] | null {
    const cleaned = text.replace(/```(?:json)?\n?/g, '').trim();
    let start = -1, depth = 0, inStr = false, escape = false;
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') { if (depth === 0) start = i; depth++; }
        else if (ch === ']') {
            depth--;
            if (depth === 0 && start !== -1) {
                try {
                    const arr = JSON.parse(cleaned.slice(start, i + 1));
                    if (Array.isArray(arr) && arr.length > 0) return arr;
                } catch { /* keep looking */ }
                start = -1;
            }
        }
    }
    return null;
}

// Generate contextual follow-up suggestions via Gemini Flash based on what was just built.
router.post('/suggestions', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { summary, filePaths = [], userPrompt = '' } = req.body as {
        summary?: string;
        filePaths?: string[];
        userPrompt?: string;
    };
    if (!summary?.trim() && !userPrompt?.trim()) {
        res.json({ suggestions: [] });
        return;
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || process.env.AI_DISABLE_GEMINI === '1') {
        res.json({ suggestions: [] });
        return;
    }

    try {
        const model = createGoogleGenerativeAI({ apiKey: geminiKey })('gemini-flash-latest');

        const fileContext = filePaths.length > 0
            ? `\nFiles changed: ${filePaths.slice(0, 8).join(', ')}`
            : '';

        const requestContext = userPrompt?.trim()
            ? `\nUser's original request: "${userPrompt.slice(0, 200)}"`
            : '';

        const { text } = await generateText({
            model,
            maxOutputTokens: 300,
            temperature: 0.6,
            // Disable thinking budget   saves tokens on this tiny task
            providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
            prompt: `You are a product assistant inside an AI web app builder. The user just completed a task and you need to suggest 3 smart follow-up actions they might want to take next.

Context:
- What was built/changed: ${(summary || '').slice(0, 600)}${requestContext}${fileContext}

Your goal: suggest the 3 most USEFUL next steps that naturally extend what was JUST built.
Think like a product designer   what would make this feature more complete, polished, or useful?

Rules:
- Each suggestion is a short imperative sentence (6–12 words max)
- Must be DIRECTLY related to what was just built   no unrelated features
- Vary the suggestions: one UX polish, one content/data, one functional enhancement
- Write as direct instructions to the AI builder, e.g. "Make the navbar sticky on scroll"
- Return ONLY a raw JSON array of exactly 3 strings   no markdown, no explanation

["suggestion 1","suggestion 2","suggestion 3"]`,
        });

        const parsed = extractOutermostJsonArray(text);
        if (parsed && parsed.length > 0) {
            const suggestions = parsed.slice(0, 3).map((s: unknown) => String(s).trim()).filter(Boolean);
            res.json({ suggestions });
            return;
        }
        res.json({ suggestions: [] });
    } catch (err) {
        logger.warn('[/suggestions] Gemini call failed:', (err as Error)?.message);
        res.json({ suggestions: [] });
    }
});

// Check if a project has an active agent run (used by frontend to auto-reconnect)
router.get('/active-run/:projectId', optionalAuthMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    const run = activeAgentRuns.get(projectId);
    if (run) {
        res.json({ active: true, startedAt: run.startedAt, ageMs: Date.now() - run.startedAt });
    } else {
        res.json({ active: false });
    }
});

// Get generation history
router.get('/history/:projectId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { data, error } = await supabase
            .from('ai_generations')
            .select('id, prompt, model, status, generation_time_ms, files_generated, files_modified, created_at')
            .eq('project_id', req.params.projectId)
            .eq('user_id', req.user!.id)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(error.message);
        }

        res.json({ generations: data || [] });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Get single generation
router.get('/generation/:generationId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { data, error } = await supabase
            .from('ai_generations')
            .select('*')
            .eq('id', req.params.generationId)
            .eq('user_id', req.user!.id)
            .single();

        if (error) {
            res.status(404).json({ error: 'Generation not found' });
            return;
        }

        res.json({ generation: data });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// ── POST /generate-app ────────────────────────────────────────────────────────
// Legacy endpoint retired in favor of /agent-stream.
router.post('/generate-app', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const operationId = (req.headers['x-operation-id'] as string | undefined) || `generate-app-${Date.now()}`;
    const apiVersion = (req.headers['x-api-version'] as string | undefined) || '1.0';
    logger.warn(`[generate-app] Legacy endpoint hit. Returning 410. operationId=${operationId}`);

    res.status(410).json({
        success: false,
        error: 'The /generate-app endpoint is retired. Use /api/v1/ai/agent-stream instead.',
        operationId,
        apiVersion,
        migrationPath: '/api/v1/ai/agent-stream',
    });
});

// ── POST /rollback ─────────────────────────────────────────────────────────────
// Restore a project to its state before the last agent run.
// Accepts either `snapshotId` (direct) or `runId` (looked up from agent_runs).
router.post('/rollback', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { snapshotId: rawSnapshotId, projectId, runId } = req.body as {
        snapshotId?: string;
        projectId?: string;
        runId?: string;
    };

    if (!projectId) {
        res.status(400).json({ error: 'projectId is required' });
        return;
    }

    // Resolve snapshotId: either direct or via runId → agent_runs lookup
    let snapshotId = rawSnapshotId;
    if (!snapshotId && runId && supabase) {
        const { data, error } = await supabase
            .from('agent_runs')
            .select('snapshot_id, project_id, user_id')
            .eq('id', runId)
            .single();
        if (error || !data) {
            res.status(404).json({ error: 'Agent run not found' });
            return;
        }
        if (data.project_id !== projectId || data.user_id !== req.user!.id) {
            res.status(403).json({ error: 'Not authorized to roll back this version' });
            return;
        }
        if (!data.snapshot_id) {
            res.status(404).json({ error: 'This version has no snapshot (it may have been pruned)' });
            return;
        }
        snapshotId = data.snapshot_id as string;
    }

    if (!snapshotId) {
        res.status(400).json({ error: 'snapshotId or runId is required' });
        return;
    }

    // Validate snapshotId format and ownership to prevent path traversal.
    // Format: {projectId(UUID)}_{runId(hex UUID without dashes)}
    if (!/^[a-f0-9-]{36}_[a-f0-9]{32}$/.test(snapshotId)) {
        res.status(400).json({ error: 'Invalid snapshotId format' });
        return;
    }
    if (!snapshotId.startsWith(projectId)) {
        res.status(403).json({ error: 'Not authorized to roll back this snapshot' });
        return;
    }

    // Verify project ownership
    try {
        await projectService.getProject(projectId, req.user!.id);
    } catch (err) {
        const msg = (err as Error).message;
        res.status(msg.includes('not found') ? 404 : 403).json({ error: msg });
        return;
    }

    // Resolve appPath (same logic as agent-stream)
    const IS_PRODUCTION = process.env.NODE_ENV === 'production';
    let appPath: string;
    try {
        const project = await projectService.getProject(projectId, req.user!.id) as unknown as Record<string, unknown>;
        const serverPath = typeof project.server_path === 'string' ? project.server_path : '';
        if (serverPath) {
            appPath = serverPath;
        } else if (IS_PRODUCTION) {
            appPath = path.join(os.tmpdir(), 'ecomgear-preview', projectId);
        } else {
            const localBase = process.env.LOCAL_PREVIEW_DATA || path.join(os.homedir(), '.ecomgear', 'preview');
            appPath = path.join(localBase, projectId);
        }
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
    }

    // Resolve snapshot dir   check persistent store first, fall back to /tmp
    const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR
        ? path.resolve(process.env.SNAPSHOTS_DIR)
        : path.join(os.homedir(), '.ecomgear', 'snapshots');
    const persistentDir = path.join(SNAPSHOTS_DIR, snapshotId);
    const legacyDir = path.join(os.tmpdir(), 'ecomgear-snapshots', snapshotId);
    const snapshotDir = fs.existsSync(persistentDir) ? persistentDir : legacyDir;

    if (!fs.existsSync(snapshotDir)) {
        res.status(404).json({ error: 'Snapshot not found or already pruned. This version can no longer be restored.' });
        return;
    }

    try {
        await restoreSnapshot(snapshotDir, appPath);

        // Collect restored files for both preview push and DB persistence.
        const restoredFiles: Array<{ path: string; content: string }> = [];
        const walkRestored = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) { walkRestored(fp); continue; }
                const ext = path.extname(e.name).toLowerCase();
                const BINARY = new Set(['.png','.jpg','.jpeg','.gif','.ico','.woff','.woff2','.ttf','.webp','.mp4','.mp3','.pdf','.zip']);
                const rel = path.relative(appPath, fp);
                try {
                    restoredFiles.push({
                        path: rel,
                        content: BINARY.has(ext)
                            ? `__ECOMGEAR_BIN64__${fs.readFileSync(fp).toString('base64')}`
                            : fs.readFileSync(fp, 'utf8'),
                    });
                } catch { /* skip */ }
            }
        };
        try { walkRestored(appPath); } catch { /* non-fatal */ }

        // Push restored files to the preview service so the preview updates immediately.
        try {
            const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001';
            const updateUrl = `${previewServiceUrl}/preview/${projectId}/update`;
            await fetch(updateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: restoredFiles, fullSync: true }),
                signal: AbortSignal.timeout(20_000),
            }).catch(() => {/* best-effort */});
        } catch { /* preview push failure is non-fatal */ }

        // Persist a new DB revision with the restored files so that refreshing the
        // editor loads these files instead of the previous latest revision.
        try {
            if (supabase && restoredFiles.length > 0) {
                // Postgres JSON rejects null bytes ( ) — strip them before insert.
                const sanitize = (s: string) => s.replace(/ /g, '');
                const textFiles = restoredFiles.filter((f: { path: string; content: string }) => !f.content.startsWith('__ECOMGEAR_BIN64__'));
                const htmlFile = textFiles.find((f: { path: string; content: string }) => f.path === 'index.html' || f.path.endsWith('.html')) || textFiles[0];

                const { data: insertData, error: insertErr } = await supabase
                    .from('revisions')
                    .insert({
                        project_id: projectId,
                        user_id: req.user!.id,
                        created_by: req.user!.id,
                        prompt: `Rolled back to snapshot ${snapshotId.slice(-8)}`,
                        generated_code: sanitize(htmlFile?.content || ''),
                        generated_files: {
                            files: textFiles.map((f: { path: string; content: string }) => ({ path: f.path, content: sanitize(f.content) })),
                        },
                    })
                    .select('id')
                    .single();

                if (insertErr) {
                    logger.warn(`[rollback] Failed to persist rollback revision: ${insertErr.message}`);
                } else {
                    logger.info(`[rollback] Persisted rollback as new revision ${insertData?.id}`);
                }
            }
        } catch (revErr) {
            logger.warn(`[rollback] Non-fatal: could not persist rollback revision: ${(revErr as Error).message}`);
        }

        res.json({ success: true });
    } catch (err) {
        logger.error(`[rollback] Failed to restore snapshot ${snapshotId}: ${(err as Error).message}`);
        res.status(500).json({ error: 'Rollback failed' });
    }
});

// ── GET /versions/:projectId ─────────────────────────────────────────────────
// Returns all completed agent run versions for a project (max 20).
// Each entry has the snapshotId, run metadata, and `available` flag indicating
// whether the snapshot dir still exists on disk.
router.get('/versions/:projectId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;

    if (!/^[0-9a-f-]{36}$/.test(projectId)) {
        res.status(400).json({ error: 'Invalid projectId' });
        return;
    }

    // Verify project ownership
    try {
        await projectService.getProject(projectId, req.user!.id);
    } catch (err) {
        const msg = (err as Error).message;
        res.status(msg.includes('not found') ? 404 : 403).json({ error: msg });
        return;
    }

    if (!supabase) {
        res.status(503).json({ error: 'Database not configured' });
        return;
    }

    // Auto-fix stuck "running" runs older than 10 minutes — they died without cleanup
    const stuckCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    supabase
        .from('agent_runs')
        .update({ status: 'failed', error_message: 'Run timed out (auto-fixed)' })
        .eq('project_id', projectId)
        .eq('status', 'running')
        .lt('created_at', stuckCutoff)
        .then(() => {});

    // Fetch only completed runs that actually wrote files — plan-only or no-op runs are excluded.
    // A run without file changes has no restore point and adds noise to the history panel.
    const { data, error } = await supabase
        .from('agent_runs')
        .select('id, prompt, summary, files_written, files_deleted, steps_taken, snapshot_id, created_at')
        .eq('project_id', projectId)
        .eq('status', 'completed')
        .gt('files_written', 0)
        .order('created_at', { ascending: false })
        .limit(20);

    if (error) {
        logger.error(`[versions] Query failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch versions' });
        return;
    }

    const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR
        ? path.resolve(process.env.SNAPSHOTS_DIR)
        : path.join(os.homedir(), '.ecomgear', 'snapshots');

    // Annotate each version with whether its snapshot is still on disk
    const versions = (data ?? []).map((row: any) => {
        const sid = row.snapshot_id as string | null;
        let available = false;
        if (sid) {
            const persistentPath = path.join(SNAPSHOTS_DIR, sid);
            const legacyPath = path.join(os.tmpdir(), 'ecomgear-snapshots', sid);
            available = fs.existsSync(persistentPath) || fs.existsSync(legacyPath);
        }
        return { ...row, available };
    });

    res.json({ versions });
});

// ─── KB: re-index a project on demand ────────────────────────────────────────
router.post('/kb/:projectId/reindex', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(projectId)) { res.status(400).json({ error: 'Invalid projectId' }); return; }

    // Resolve project path
    const serverPath = supabase
        ? ((await supabase.from('projects').select('server_path').eq('id', projectId).single()).data as any)?.server_path
        : null;
    const localBase = process.env.SERVER_PROJECTS_DIR || path.join(os.homedir(), '.ecomgear', 'projects');
    const appPath = serverPath || path.join(localBase, projectId);

    if (!fs.existsSync(appPath)) { res.status(404).json({ error: 'Project files not found on server' }); return; }

    // Walk the project directory
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache']);
    const files: Array<{ path: string; content: string }> = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (SKIP.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); }
            else {
                const rel = path.relative(appPath, full);
                try { files.push({ path: rel, content: fs.readFileSync(full, 'utf8') }); } catch {}
            }
        }
    };
    walk(appPath);

    // Run in background
    res.json({ status: 'indexing', files: files.length });
    await deleteProjectEmbeddings(projectId);
    indexFiles(projectId, files).catch(err => logger.warn('[kb/reindex] failed:', err));
});

// ─── KB: stats for a project ─────────────────────────────────────────────────
router.get('/kb/:projectId/stats', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(projectId)) { res.status(400).json({ error: 'Invalid projectId' }); return; }
    if (!supabase) { res.json({ indexed: 0, lastIndexed: null }); return; }

    const { data, error } = await supabase
        .from('project_file_embeddings')
        .select('file_path, updated_at')
        .eq('project_id', projectId)
        .order('updated_at', { ascending: false });

    if (error) { res.status(500).json({ error: error.message }); return; }

    res.json({
        indexed: data?.length ?? 0,
        lastIndexed: data?.[0]?.updated_at ?? null,
        files: data?.map(r => r.file_path) ?? [],
    });
});

export default router;
