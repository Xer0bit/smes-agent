import { Router, Response } from 'express';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { recordEffect, markReverted, recoverRun, forgetRun, EFFECT_KINDS } from '../services/effectLedger.js';
import { compensateFileWrite } from '../services/projectFileWriter.js';
import { publishRunChunk, publishRunEnd, relayRunStream, runStreamExists, publishRunCancel, subscribeRunCancel } from '../services/runStreamBroker.js';
import { getLlmControlState, getUserPlanTier } from '../services/llm-control.service.js';
import { testAndAutoDisableProviders, getLastHealthResults } from '../services/llm-health.service.js';
import { createRunSink } from '../services/runSink.js';
import { isLockLive, AGENT_LOCK_STALE_MS, AGENT_LOCK_HEARTBEAT_MS } from '../services/agentLockState.js';
import { runAgentLoop, restoreSnapshot, type AgentRunParams } from '../services/agentLoopService.js';
import { openSandbox, discardSandbox, findRunRevision, fetchRevisionFiles, rollbackToRevision } from '../services/runSandbox.js';
import { persistAgentRevision } from '../services/agentRevisionPersist.service.js';
import { checkUsageQuota } from '../services/billing.service.js';
import { DEFAULT_FREE_MODEL } from '../config/models.js';
import { projectService } from '../services/project.service.js';
import { initProjectFromTemplate, ensureBaseTemplate } from '../services/baseTemplateService.js';
import { seedEcgTemplate } from '../services/ecg-template.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import multer from 'multer';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { resolveRequestTier, isCheapTier, TIER_MAX_STEPS } from '../services/intentClassifier.js';
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
    /**
     * True once the loop emitted 'done'. The answer is complete and the client
     * has already flipped to "ready", but teardown -- revision persist, lock
     * release, map removal -- is still running. Measured at ~3s in production
     * (2026-08-24: inner-return 13:20:29, lock released 13:20:32).
     *
     * A run in this state must NOT accept a new prompt as a stream subscriber:
     * the prompt is never read on that path, so the user's message vanishes.
     */
    finishing: boolean;
    /** Resolves once the run has truly ended AND released its project lock. */
    ended: Promise<void>;
    /** Called from the route's finally, after the lock is released. */
    markEnded: () => void;
    /**
     * The run's ONLY output path. Formats an SSE frame, buffers it for replay,
     * fans it out to every attached connection, and mirrors it cross-worker.
     * The run never touches a `Response`, so its progress does not depend on
     * anyone currently listening.
     */
    emit: (event: string, data: unknown) => void;
    /** Same, for a pre-formatted frame. `replayable: false` skips the buffer. */
    emitRaw: (frame: string, replayable?: boolean) => void;
    /** Coarse stage, mirrored from the run so /active-run can report it. */
    phase?: 'generating' | 'publishing' | 'persisting';
}
const activeAgentRuns = new Map<string, ActiveRun>();

/**
 * Point one HTTP connection at a run: replay what it missed, then follow live.
 *
 * Every connection uses this, the one that started the run included. Attaching
 * and detaching are the only things a connection does to a run -- it cannot
 * start, stop, or slow one.
 */
function attachSubscriber(run: ActiveRun, req: AuthenticatedRequest, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    for (const frame of run.buffer) {
        if (!res.writableEnded) res.write(frame);
    }

    const onChunk = (frame: string) => { if (!res.writableEnded) res.write(frame); };
    const onEnd = () => { if (!res.writableEnded) res.end(); };
    run.bus.on('chunk', onChunk);
    run.bus.once('end', onEnd);
    req.on('close', () => {
        run.bus.off('chunk', onChunk);
        run.bus.off('end', onEnd);
    });
}

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
// Staleness is measured against `acquired_at`, which a LIVE run refreshes every
// AGENT_LOCK_HEARTBEAT_MS (see startAgentLockHeartbeat). Before the heartbeat
// existed this had to be a generous ceiling above the longest real
// AGENT_TIMEOUT_MS -- 15 minutes -- because a still-running request had no way
// to prove it was alive. That ceiling was also the blast radius: any lock left
// behind by a SIGKILLed worker (OOM, `pm2 restart`, the 15s force-exit in
// index.ts) wedged that project for the full 15 minutes behind a false
// "a generation is already running" error, against a client retry budget of
// only ~10s. With a heartbeat, liveness is proven continuously, so the window
// drops to a few missed beats. Kept at 6x the heartbeat interval so a run
// survives several consecutive transient Supabase failures before another
// request may reclaim its lock -- and note runAgentLoop's Redlock mutex
// (agentProjectLock.ts) still serializes the actual file writes even if this
// lock is reclaimed early, so an early reclaim degrades to a rejected duplicate
// rather than interleaved writes.
/**
 * A rollback pushes the WHOLE restored project to the preview, not a changeset,
 * so it is bounded by upload size rather than by server think-time. Measured on
 * CardPro: 199 files = 38.5 MB, successful pushes 104-139s. Anything under that
 * aborts mid-body and the preview silently keeps serving the old files.
 */
const PREVIEW_RESTORE_TIMEOUT_MS = 240_000;

/**
 * Prompt the client sends to reattach to an in-flight run rather than to start
 * one. Must never reach the generation path: it is a control signal, not a task.
 */
const REJOIN_SENTINEL = '__rejoin__';

// AGENT_LOCK_STALE_MS / AGENT_LOCK_HEARTBEAT_MS now live in services/agentLockState.ts
// so the agent_runs watchdog can share the exact same staleness bound.

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
        .select('acquired_at, token')
        .eq('project_id', projectId)
        .maybeSingle();

    if (selectError) {
        // Unexpected error (network, RLS, etc.)   fail open rather than
        // blocking every generation request because locking itself broke.
        logger.warn(`[agent-lock] Unexpected error checking lock for ${projectId}, allowing request: ${selectError.message}`);
        return token;
    }

    if (!existing) {
        // The row was deleted between our failed insert and this select -- the
        // previous run finished in that window. Re-INSERT; the old code fell
        // through to the UPDATE below, which matched zero rows and still
        // reported success (updateError is null for an empty match), handing
        // back a token for a lock row that does not exist. A second worker
        // could then insert cleanly and both runs proceeded in parallel on the
        // same project, which is the one outcome this lock exists to prevent.
        const { error: reinsertError } = await supabase
            .from('agent_locks')
            .insert({ project_id: projectId, token, owner: `pid:${process.pid}` });
        return reinsertError ? null : token;
    }

    if (!isLockLive(existing.acquired_at)) {
        const age = Date.now() - new Date(existing.acquired_at).getTime();
        logger.warn(`[agent-lock] Reclaiming stale lock for ${projectId} (age ${Math.round(age / 1000)}s)`);
        const { error: updateError } = await supabase
            .from('agent_locks')
            .update({ token, owner: `pid:${process.pid}`, acquired_at: new Date().toISOString() })
            .eq('project_id', projectId);
        if (updateError) return null;

        // The lock we just took belonged to a run that died without reaching
        // its finally block. Taking the lock is only half of that cleanup: the
        // dead run may also have set secrets, pushed a preview, or deployed a
        // function, and before the effect ledger nothing anywhere reverted any
        // of it -- those effects simply stayed, unattributed, forever. Recover
        // them now, while we hold the lock and no other run can interleave.
        //
        // Deliberately awaited rather than fire-and-forget: starting a new run
        // on top of a half-recovered project is the interleaving this lock
        // exists to prevent. Deliberately non-fatal: recovery halting at a
        // barrier is an expected outcome (see recoverRun), not a reason to deny
        // the caller a lock it legitimately reclaimed.
        if (typeof existing.token === 'string' && existing.token.length > 0) {
            try {
                const outcome = await recoverRun(existing.token, AGENT_EFFECT_COMPENSATORS);
                if (outcome.reverted > 0 || outcome.haltedAtBarrier || outcome.failures.length > 0) {
                    logger.warn(
                        `[agent-lock] Recovered ${outcome.reverted} orphaned effect(s) from dead run ` +
                        `${existing.token} on ${projectId}` +
                        (outcome.haltedAtBarrier ? '; halted at an irreversible effect' : '') +
                        (outcome.failures.length ? `; ${outcome.failures.length} compensation(s) FAILED` : ''),
                    );
                }
            } catch (err) {
                logger.warn(`[agent-lock] Orphan recovery errored for ${projectId}: ${(err as Error).message}`);
            }
        }
        return token;
    }

    return null;
}

/**
 * How to take back each effect kind an agent run can leave standing.
 *
 * Only kinds listed here are recoverable; recoverRun deliberately HALTS on an
 * unregistered kind rather than stepping over it, so this map is the explicit
 * boundary of what we are willing to undo automatically. `db_migration` and
 * `publish` are absent on purpose -- they are classified as barriers in
 * effectLedger.ts and must not be guessed at against live customer data.
 */
const AGENT_EFFECT_COMPENSATORS: Parameters<typeof recoverRun>[1] = {
    /** Restore the file's prior bytes, or delete it when the run created it.
     *  The project root is carried on the effect row itself, so this works from
     *  a process that never resolved an appPath for the project. */
    file_write: async (row) => { await compensateFileWrite(row); },

    /** The dead run's own lock row. Scoped by token so we can never delete a
     *  lock that has since been legitimately reclaimed by someone else. */
    agent_lock: async (row) => {
        const { error } = await supabase
            .from('agent_locks')
            .delete()
            .eq('project_id', row.project_id)
            .eq('token', row.run_id);
        if (error) throw new Error(`could not release orphaned lock: ${error.message}`);
    },
};

/** The single staleness bound, shared by the reclaim path (tryAcquireAgentLock)
 *  and the visibility path (readLiveAgentLock). These MUST agree: if a lock
 *  could ever be "not live enough to report" yet "not stale enough to reclaim",
 *  a project falls back into the exact dead zone this whole change removes --
 *  /active-run says nothing is running while the lock check still rejects the
 *  next message. One function, one bound, both callers. */
export { isLockLive };

/** Keep this run's lock row fresh so AGENT_LOCK_STALE_MS can stay short.
 *  Scoped by token as well as project so a heartbeat can never resurrect a lock
 *  that was already reclaimed by (and now belongs to) a different run. */
function startAgentLockHeartbeat(projectId: string, token: string): () => void {
    const timer = setInterval(async () => {
        try {
            await supabase
                .from('agent_locks')
                .update({ acquired_at: new Date().toISOString() })
                .eq('project_id', projectId)
                .eq('token', token);
        } catch {
            // Transient failure: the staleness window tolerates several
            // consecutive misses before anything can reclaim this lock.
        }
    }, AGENT_LOCK_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

/** Read the project's lock row, ignoring one already past the staleness bound.
 *  This is how a worker answers "is a run live?" for a run it cannot see in its
 *  own `activeAgentRuns` map -- i.e. one owned by the other cluster worker. */
async function readLiveAgentLock(projectId: string): Promise<{ acquired_at: string; token: string } | null> {
    try {
        const { data, error } = await supabase
            .from('agent_locks')
            .select('acquired_at, token')
            .eq('project_id', projectId)
            .maybeSingle();
        if (error || !data) return null;
        return isLockLive(data.acquired_at) ? data : null;
    } catch {
        return null;
    }
}

async function releaseAgentLock(projectId: string): Promise<void> {
    // Single-shot delete used to swallow failures silently with no log line at
    // all. A transient failure here (network blip, Supabase 5xx) then leaves
    // the lock row alive for the full AGENT_LOCK_STALE_MS (15 min) since
    // nothing else ever deletes it, while the client's own retry budget on a
    // PROJECT_LOCKED response is only ~8-10s (LOCK_RETRY_ATTEMPTS *
    // LOCK_RETRY_DELAY_MS in agentStreamService.ts) -- so a single missed
    // delete surfaces as a false "another generation is running" error to the
    // user (most visible on the auto-repair follow-up, which fires ~300ms
    // after the prior run ends). Retry the delete itself a few times before
    // giving up, and log if it still fails so a real leak is diagnosable.
    const attempts = 3;
    for (let i = 1; i <= attempts; i++) {
        try {
            const { error } = await supabase.from('agent_locks').delete().eq('project_id', projectId);
            if (error) throw error;
            return;
        } catch (err) {
            if (i === attempts) {
                logger.warn(`[agent-lock] Failed to release lock for ${projectId} after ${attempts} attempts (will self-heal via staleness reclaim in ${AGENT_LOCK_STALE_MS / 60_000}min): ${(err as Error).message}`);
                return;
            }
            await new Promise((r) => setTimeout(r, 200 * i));
        }
    }
}

// Called from index.ts's gracefulShutdown on SIGTERM/SIGINT. A dying worker's
// in-flight agent runs get their sockets destroyed (see index.ts's connection
// drain) before the request handler's own finally block is guaranteed to run,
// which is exactly how a deploy leaks an agent_locks row: confirmed in
// production, 4 rows leaked in the same ~90s window as a single `vps3`
// deploy, each blocking that project's file sync/load for up to
// AGENT_LOCK_STALE_MS (15min) with a false "another generation is running"
// error. Deleting by owner is deterministic regardless of how far any
// individual request got, unlike waiting for sockets/finally blocks to run.
/**
 * Tell every run this worker owns that it is being killed, then close the loop
 * on it in the DB.
 *
 * A restart used to be silent from the client's side: the socket simply died
 * mid-stream, the `agent_runs` row kept claiming `status='running'`, and the UI
 * showed a generation that no process was working on until a sweep noticed.
 * Emitting a terminal event first means an attached client learns immediately
 * and from the run itself, rather than inferring it from a dropped connection.
 *
 * Awaited by the shutdown path: this is the last moment the run ids are known,
 * since they live only in this process's memory.
 */
export async function interruptRunsForThisProcess(): Promise<void> {
    const projectIds = [...activeAgentRuns.keys()];
    if (projectIds.length === 0) return;

    for (const [, run] of activeAgentRuns) {
        try {
            run.emit('error', {
                message: 'This generation was interrupted because the server restarted. Work already saved to a revision is kept; please re-send your request to continue.',
                interrupted: true,
            });
            run.bus.emit('end');
        } catch { /* a run whose subscribers are already gone is fine */ }
    }

    try {
        // Scoped by project rather than by run id because the id lives inside
        // the agent loop, not on the run handle -- and this worker holds each
        // of these projects' locks, so a 'running' row for one of them is this
        // run by construction.
        const { error } = await supabase
            .from('agent_runs')
            .update({
                status: 'failed',
                error_message: 'Interrupted by a server restart before the run finished.',
                completed_at: new Date().toISOString(),
            })
            .in('project_id', projectIds)
            .eq('status', 'running');
        if (error) throw error;
        logger.info(`[agent-stream] Marked runs interrupted on shutdown for ${projectIds.length} project(s)`);
    } catch (err) {
        // The watchdog's lock-liveness sweep is the backstop; this is only the
        // fast path that saves the user a wait.
        logger.warn(`[agent-stream] Could not mark interrupted runs on shutdown: ${(err as Error).message}`);
    }
}

export async function releaseAllLocksForThisProcess(): Promise<void> {
    try {
        const { error, count } = await supabase
            .from('agent_locks')
            .delete({ count: 'exact' })
            .eq('owner', `pid:${process.pid}`);
        if (error) throw error;
        if (count) logger.info(`[agent-lock] Released ${count} lock(s) owned by pid:${process.pid} on shutdown`);
    } catch (err) {
        logger.warn(`[agent-lock] Failed to release this process's locks on shutdown: ${(err as Error).message}`);
    }
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
        .select('ai_gens_limit, ai_gens_used, ai_gens_reset_at, is_internal')
        .eq('id', orgId)
        .limit(1)
        .maybeSingle();

    if (error || !data) {
        logger.warn(`[agent-stream] Failed to read eco policy inputs for org ${orgId}: ${error?.message || 'not found'}`);
        return true;
    }

    const d = data as Record<string, unknown>;
    // Internal/dogfooding orgs (migration 20260721090000) bypass the monthly eco
    // budget entirely   rebuild plan Task 4.1 point 5. The $ safety ceiling in
    // agentLoopService.ts (HARD_COST_CAP / AGENT_COST_CAP_USD_INTERNAL) still
    // applies unchanged; this only lifts the consumer-facing monthly quota.
    if (d.is_internal === true) return true;
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

async function incrementEcoUsage(orgId: string, ecoAmount: number): Promise<{ allowed: boolean; source: 'v2' | 'legacy'; error?: string }> {
    // Eco cost is computed server-side in agentLoopService.ts's computeEcoCost():
    // actual run cost ($) / $0.05, clamped to [0.5, 2.0] eco. A PURE token/cost-based
    // charge was tried before and reverted because a single "thinking" model run
    // (gemini-3.1-pro-preview) can burn 100K+ tokens and would drain an entire
    // free-tier month in one request   the clamp keeps pricing proportional to
    // usage while bounding the worst case at 2 eco/run.
    // The DB function increment_ai_gen already enforces the limit atomically with FOR UPDATE,
    // so the redundant pre-check here is omitted.
    const v2 = await supabase.rpc('increment_ai_gen', {
        p_org_id: orgId,
        p_tokens: ecoAmount,
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

// Cached provider health   read-only, never triggers a probe. Sanitized to
// booleans + timestamps (raw failure reasons can contain provider billing
// text and stay admin-only via /test-providers).
router.get('/health', (_req, res: Response) => {
    const results = getLastHealthResults();
    if (!results) {
        res.json({ success: true, checked: false, providers: [] });
        return;
    }
    const providers = Object.entries(results).map(([provider, r]) => ({
        provider,
        ok: r?.ok ?? false,
        testedAt: r?.testedAt ?? null,
    }));
    res.json({ success: true, checked: true, allOk: providers.every((p) => p.ok), providers });
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
    const { prompt, projectId, orgId, existingFiles, model, mode, chatMode, history, olderSummary, attachments, fingerprint } = req.body as {
        prompt?: string;
        projectId?: string;
        orgId?: string;
        existingFiles?: Array<{ path: string; content: string }>;
        model?: string;
        mode?: 'build' | 'plan';
        /** User-selected chat mode from the editor's mode toggle -- see AgentContext.chatMode. */
        chatMode?: 'normal' | 'admin';
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
        olderSummary?: string;
        attachments?: Array<{
            name: string;
            type: string;
            category: 'image' | 'document';
            tempPath: string;
            publicUrl?: string;
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

    // Enforce subscription usage quota (Free vs. Pro)
    if (!isGuest && req.user?.id) {
        const usageQuota = await checkUsageQuota(req.user.id);
        if (!usageQuota.allowed) {
            logger.warn(`[agent-stream] Quota limit blocked request for user ${req.user.id}: ${usageQuota.reason}`);
            res.status(403).json({
                error: usageQuota.reason || 'Free tier usage limit reached. Please upgrade to Pro.',
                code: 'USAGE_LIMIT_EXCEEDED',
            });
            return;
        }
    }

    // Concurrency guard   if a run is already active for this project, subscribe this new
    // SSE connection to it (fan-out) rather than starting a new run and charging eco again.
    // Must be checked BEFORE eco deduction so reconnects don't double-count usage.
    // Longest we will park a new prompt while a finishing run tears down.
    // Teardown measured at ~3s (persist + lock release); this is generous
    // enough to cover a slow revision upload and short enough that a run which
    // dies mid-teardown does not hang the caller.
    const TEARDOWN_WAIT_MS = 20_000;

    const existingRunEarly = activeAgentRuns.get(projectId);
    if (existingRunEarly) {
        const ageMs = Date.now() - existingRunEarly.startedAt;

        if (existingRunEarly.finishing) {
            // TEARDOWN WINDOW. The previous run already emitted 'done', so the
            // client cleared its generating state and let the user send this
            // prompt -- but that run still holds the project lock and is still
            // in activeAgentRuns. Subscribing here would attach this connection
            // to the dying run's stream and NEVER READ `prompt`: the user's
            // message disappears with no answer and no error. Starting a fresh
            // run immediately is equally wrong -- the lock is still held, so it
            // would 429 instead.
            //
            // So: wait for the run to genuinely end (its lock released), then
            // fall through and serve this prompt as a normal new run.
            logger.info(
                `[agent-stream] Prompt arrived during teardown of a finishing run (age ${ageMs}ms) ` +
                `-- waiting up to ${TEARDOWN_WAIT_MS}ms for it to release its lock, then running this prompt`,
                { projectId, promptPreview: typeof prompt === 'string' ? prompt.slice(0, 80) : '' },
            );

            let disconnected = false;
            const clientGone = new Promise<'closed'>((resolve) => {
                const onClose = () => { disconnected = true; resolve('closed'); };
                req.once('close', onClose);
                // Detach on settle so a long-lived request cannot accumulate
                // listeners across waits.
                void existingRunEarly.ended.finally(() => req.off('close', onClose));
            });
            let timer: NodeJS.Timeout | undefined;
            const timedOut = new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), TEARDOWN_WAIT_MS);
            });

            const outcome = await Promise.race([
                existingRunEarly.ended.then(() => 'ended' as const),
                timedOut,
                clientGone,
            ]);
            if (timer) clearTimeout(timer);

            if (disconnected || outcome === 'closed') {
                // Caller hung up while parked. Nothing to serve; do not start a
                // run nobody is listening to.
                logger.info('[agent-stream] Client disconnected while waiting out teardown; dropping request', { projectId });
                if (!res.writableEnded) res.end();
                return;
            }
            if (outcome === 'timeout') {
                // The run never signalled a clean end -- crashed mid-teardown,
                // or its finally never ran. Proceed anyway: the lock's own
                // staleness reclaim covers a genuinely dead owner, and hanging
                // the user is worse than racing a corpse.
                logger.warn(
                    `[agent-stream] Finishing run did not end within ${TEARDOWN_WAIT_MS}ms; proceeding with the new prompt anyway`,
                    { projectId },
                );
            }
            // Fall through: acquire the lock and run this prompt for real.
        } else {
            logger.info(`[agent-stream] Project ${projectId} has active run (age ${ageMs}ms)   subscribing new connection`, {
                projectId,
                promptPreview: typeof prompt === 'string' ? prompt.slice(0, 80) : '',
                note: 'this connection joins the running generation; the submitted prompt is NOT executed separately',
            });

            attachSubscriber(existingRunEarly, req, res);
            return;
        }
    }

    // ── Rejoin sentinel: attach only, NEVER start a run ─────────────────────
    // The client sends prompt '__rejoin__' to reattach to a run it believes is
    // still going. The server had no handling for it, so when the run had
    // already finished there was nothing to attach to and this fell through and
    // started a BRAND NEW RUN whose prompt was the literal string
    // "__rejoin__" -- billing the user and appending another copy of the same
    // answer. Observed on CardPro 2026-09-02: one user message ("what are the
    // logins?") produced three runs and three identical replies.
    //
    // Reaching here means every attach path above already declined, so there is
    // nothing live to join. Say so and stop.
    if (prompt === REJOIN_SENTINEL) {
        logger.info('[agent-stream] rejoin requested but no live run to attach to', { projectId });
        res.status(409).json({ error: 'No active run to rejoin', code: 'NO_ACTIVE_RUN' });
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
        // A run is genuinely live on the other PM2 worker. Before rejecting,
        // try to RELAY it (Phase 5, paper section 6.2 "cross-process
        // invocation"): the owning worker mirrors every chunk to a Redis
        // stream, so this worker can serve the same output even though the
        // run's event bus lives in another process's memory. The lock token is
        // the run id, which is what makes the other worker's stream findable.
        //
        // This is the difference between "a generation is already running,
        // please wait" and simply showing the user their generation.
        const liveLock = await readLiveAgentLock(projectId);
        if (liveLock?.token && await runStreamExists(projectId, liveLock.token)) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');

            const relayAbort = new AbortController();
            req.on('close', () => relayAbort.abort());

            const relayed = await relayRunStream(
                projectId,
                liveLock.token,
                {
                    onChunk: (c) => { if (!res.writableEnded) res.write(c); },
                    onEnd: () => { if (!res.writableEnded) res.end(); },
                },
                relayAbort.signal,
            );
            if (!res.writableEnded) res.end();
            if (relayed) return;
            // Relay failed mid-flight (section 6.2 warns a cross-process call
            // can). Headers are already sent, so we cannot fall back to a JSON
            // 429 here -- the stream simply ends and the client's own
            // reconnect/poll path takes over.
            return;
        }

        res.status(429).json({
            error: 'A generation is already running for this project (on another server process). Please wait for it to finish before starting another.',
            code: 'PROJECT_LOCKED',
        });
        return;
    }

    const stopAgentLockHeartbeat = startAgentLockHeartbeat(projectId, agentLockToken);

    // Enter this run's lock into the effect ledger. The lock token doubles as
    // the run id, so every later effect this run records is attributable to the
    // same component instance -- which is what lets another worker recover the
    // whole set if this process dies before its finally block runs.
    const lockEffectId = await recordEffect({
        runId: agentLockToken,
        projectId,
        kind: 'agent_lock',
        target: `agent_locks/${projectId}`,
        boundary: EFFECT_KINDS.agent_lock,
        afterState: { token: agentLockToken, owner: `pid:${process.pid}` },
    });

    const routeAbortController = new AbortController();
    const abortRun = () => {
        if (!routeAbortController.signal.aborted) {
            routeAbortController.abort();
        }
    };

    // The run's only output path. `publishRunChunk` is deliberately not awaited:
    // it is a best-effort mirror for subscribers on the OTHER PM2 worker, and an
    // agent run must never slow down or fail because a Redis write did. Local
    // subscribers are served from the sink's own buffer and bus regardless.
    const runSink = createRunSink((frame) => { void publishRunChunk(projectId, agentLockToken, frame); });
    const currentRunBus = runSink.bus;
    let markRunEnded!: () => void;
    const runEnded = new Promise<void>((resolve) => { markRunEnded = resolve; });
    const currentRun: ActiveRun = {
        abort: abortRun,
        startedAt: Date.now(),
        bus: currentRunBus,
        buffer: runSink.buffer,
        finishing: false,
        ended: runEnded,
        markEnded: markRunEnded,
        emit: runSink.emit,
        emitRaw: runSink.emitRaw,
    };
    activeAgentRuns.set(projectId, currentRun);

    // The run now writes to its own record, never to a socket, and THIS
    // connection subscribes to it exactly like a rejoining one. That is the
    // whole point: a dropped connection is no longer an event the run can
    // notice, so the old "wait 5 minutes for a reconnect, then abort" timer is
    // gone -- an abort now only ever comes from an explicit cancel. It also
    // removes a real failure mode: the run used to write straight into the
    // socket, so a client that vanished mid-write surfaced as an EPIPE inside
    // the agent loop rather than as a disconnected reader.
    attachSubscriber(currentRun, req, res);

    let agentResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
    // Per-run sandbox handle, hoisted above the try so `finally` can discard it.
    let sandbox: Awaited<ReturnType<typeof openSandbox>> | null = null;

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

        // Orchestration Phase 1 (2026-08-09): if a prior plan-mode session
        // left a draft plan for this project, a build run picks it up --
        // marks it approved (superseding any earlier approved plan, same
        // silent-supersede behavior propose_plan.ts already uses), and its
        // steps get injected into the build system prompt. Best-effort: a
        // lookup failure must never block the build run itself.
        let approvedPlanSteps: string[] | undefined;
        if (effectiveMode === 'build') {
            try {
                const { data: draftPlan } = await supabase
                    .from('agent_plans')
                    .select('id, steps')
                    .eq('project_id', projectId)
                    .eq('status', 'draft')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (draftPlan) {
                    await supabase
                        .from('agent_plans')
                        .update({ status: 'superseded' })
                        .eq('project_id', projectId)
                        .eq('status', 'approved');
                    await supabase
                        .from('agent_plans')
                        .update({ status: 'approved', approved_at: new Date().toISOString() })
                        .eq('id', (draftPlan as any).id);
                    const steps = (draftPlan as any).steps;
                    if (Array.isArray(steps) && steps.length > 0) {
                        approvedPlanSteps = steps;
                    }
                }
            } catch (planLookupErr) {
                logger.warn(`[agent-stream] approved-plan lookup failed for project=${projectId} (non-fatal)`, planLookupErr);
            }
        }

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
        // Persistent per-project dir: holds the warm node_modules the sandbox
        // symlinks to, and the template scaffold for a brand-new project. It is
        // NOT the run's write surface anymore -- the sandbox (below) is.
        let projectDir: string;
        if (projectServerPath) {
            projectDir = String(projectServerPath);
        } else if (process.env.SERVER_PROJECTS_DIR) {
            projectDir = path.join(process.env.SERVER_PROJECTS_DIR, projectId);
        } else if (IS_PRODUCTION) {
            projectDir = path.join('/var/ecomgear/projects', projectId);
        } else {
            const localBase = process.env.LOCAL_PREVIEW_DATA
                || path.join(os.homedir(), '.ecomgear', 'preview');
            projectDir = path.join(localBase, projectId);
        }

        await fs.promises.mkdir(projectDir, { recursive: true });

        // Copy pre-installed node_modules from the golden template (near-instant
        // via hard links). Race against a 10 s timeout so a slow npm install
        // (first-run template bootstrap) never blocks the agent from starting.
        // Default the scaffold's <title> to the project's real name (not "App").
        // Only look it up when we're actually about to scaffold (no index.html yet)
        // so existing-project edits pay no query. The agent refines full SEO later.
        let scaffoldTitle: string | undefined;
        try {
            if (projectId && !fs.existsSync(path.join(projectDir, 'index.html'))) {
                const { data: nameRow } = await supabase
                    .from('projects')
                    .select('name, website_name')
                    .eq('id', projectId)
                    .maybeSingle();
                scaffoldTitle = (nameRow?.website_name || nameRow?.name) as string | undefined;
            }
        } catch { /* best-effort; fall back to the generic scaffold title */ }
        try {
            await Promise.race([
                initProjectFromTemplate(projectDir, scaffoldTitle),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('template init timeout')), 10_000)
                ),
            ]);
        } catch (templateErr) {
            logger.warn(`[agent-stream] Template init skipped: ${(templateErr as Error).message}`);
        }

        // ── Per-run isolated sandbox (source of truth = HEAD revision) ───────
        // The run works in a FRESH ephemeral dir, never the persistent projectDir:
        // source is materialized from the authoritative HEAD revision, node_modules
        // is symlinked to projectDir's warm copy, and the dir is discarded at run
        // end (finally). No shared mutable disk means cross-run/cross-project
        // contamination is structurally impossible. Fail-open: if the sandbox can't
        // open, fall back to projectDir so the run still proceeds.
        try {
            sandbox = await openSandbox(projectId, projectDir);
        } catch (sbErr) {
            logger.warn(`[agent-stream] sandbox open failed, using project dir: ${(sbErr as Error).message}`);
        }
        const appPath = sandbox?.sandboxPath ?? projectDir;

        // eCG-linked projects need their dashboard overlay (seedEcgTemplate) applied
        // on top of the generic scaffold above. initProjectFromTemplate only ever
        // writes the generic base template, so any gen-server instance whose local
        // disk doesn't already have this project's files (fresh box, cache-cold,
        // disk cleared, or simply never ran the agent for this project before)
        // leaves the dev-agent looking at a bare "Welcome" stub even though the
        // live preview (synced separately by ecg-dev-agent.routes.ts's
        // syncEcgPreviewService, and by ecg-customize.routes.ts on re-bake) still
        // shows the real seeded dashboard. Detect "missing the eCG overlay" via a
        // file only seedEcgTemplate ever writes, and only pay the extra DB round
        // trip for projects that actually need it.
        try {
            const ecgMarker = path.join(appPath, 'src', 'lib', 'ecgClient.ts');
            if (!fs.existsSync(ecgMarker)) {
                const { data: ecgSecrets } = await supabase
                    .from('project_secrets')
                    .select('key_name')
                    .eq('project_id', projectId)
                    .in('key_name', ['ECG_PORTAL_TOKEN', 'ECG_MCP_API_KEY']);
                if (ecgSecrets && ecgSecrets.length > 0) {
                    const { data: ecgSettingsRow } = await supabase
                        .from('project_settings')
                        .select('setting_value')
                        .eq('project_id', projectId)
                        .eq('setting_key', 'ecg_customizer')
                        .maybeSingle();
                    const ecgRow = ecgSettingsRow?.setting_value as
                        { orgName?: string; modules?: string[]; agentIds?: string[]; config?: Record<string, unknown> } | undefined;
                    if (ecgRow) {
                        seedEcgTemplate(appPath, {
                            orgName: ecgRow.orgName ?? 'eCG Agent',
                            modules: ecgRow.modules ?? [],
                            agentIds: ecgRow.agentIds ?? [],
                            config: ecgRow.config ?? {},
                            projectId,
                            proxyUrl: process.env.ECOMGEAR_SERVER_URL || 'https://api.ecomgear.ai',
                        });
                        logger.info(`[agent-stream] Re-seeded eCG dashboard overlay locally for project=${projectId}`);
                    } else {
                        logger.warn(`[agent-stream] project=${projectId} has an eCG secret but no ecg_customizer settings row -- cannot re-seed`);
                    }
                }
            }
        } catch (ecgSeedErr) {
            logger.warn(`[agent-stream] eCG template re-seed skipped: ${(ecgSeedErr as Error).message}`);
        }

        // Source of truth is now the sandbox itself (materialized from HEAD in
        // openSandbox above) -- there is no shared persistent disk left to
        // re-sync or prune, so the old in-place re-materialize step is gone.

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

        // Asset-swap fast path: an attached image + explicit swap intent is a
        // single place_asset call, not a 25-step edit-tier task. intentClassifier's
        // MICRO_RE deliberately excludes "logo" (too ambiguous on its own   "logo
        // section", "resize the logo") so this normally falls through to EDIT_RE's
        // "replace" match and gets the full-price Claude Sonnet edit tier. Confirmed
        // live: a plain "use this logo for X" run burned 11 steps / $1.55 (only 3
        // steps did real work; the rest was think/get_build_errors overhead at the
        // edit tier's ~40k-token-per-step baseline cost). Requiring an actual image
        // attachment in the SAME request   not just the word "logo"   keeps this
        // narrower than the original exclusion worried about; a bare "change the
        // logo section" with no attachment still falls through to the normal
        // classifier untouched. projectHasFiles gate: never fires on a brand-new
        // empty project, which genuinely needs the full build tier regardless.
        const hasImageAttachment = Array.isArray(attachments) && attachments.some((a) => a.category === 'image');
        const ASSET_SWAP_RE = /\b(use|replace|swap)\b[^.!?]{0,40}\b(this|it)\b[^.!?]{0,20}\b(for|as|with)\b|\b(replace|swap|update|change)\b[^.!?]{0,40}\b(logo|image|photo|picture|icon|banner|avatar)\b/i;
        const isAssetSwap = hasImageAttachment && projectHasFiles && ASSET_SWAP_RE.test(prompt);

        // Both overrides are decided by the caller's own context, not by reading
        // the prompt, so neither is a candidate for tier resolution.
        const tierDecision = isRepairPrompt
            ? { tier: 'feature' as const, rule: 'repair-override', confidence: 'high' as const, source: 'rules' as const }
            : isAssetSwap
                ? { tier: 'micro' as const, rule: 'asset-swap-override', confidence: 'high' as const, source: 'rules' as const }
                : await resolveRequestTier(prompt, !projectHasFiles);
        const requestTier = tierDecision.tier;
        // Logged on every run so a misroute is traceable to the rule that made
        // it, and so the share of prompts the rules cannot answer is a measured
        // number rather than an impression.
        logger.info('[agent-stream] tier routed', {
            projectId,
            tier: requestTier,
            rule: tierDecision.rule,
            source: tierDecision.source,
            promptPreview: typeof prompt === 'string' ? prompt.slice(0, 80) : '',
        });

        // Tier-based model routing:
        //   micro → Gemini Flash  (visual tweaks, $0.075/MTok   40× cheaper than Sonnet)
        //   micro → free model (glm-4.7-flash by default   visual tweaks)
        //   fix   → fallback model (glm-5 by default   error diagnosis)
        //   edit/feature/build → user's selected model / admin primary
        // Guests always stay on GUEST_MODEL regardless.
        // The model the user's plan actually entitles them to   escalation target.
        // Downgrade-then-escalate cascade: a cheap model attempts first; if it
        // lands ZERO changes (stuck/failed), one automatic retry runs on this
        // model. Never escalates ABOVE the plan model, so a free-tier failure
        // can't silently burn premium spend. Rationale (measured 2026-07-21):
        // edit-tier on Claude averages $0.60-$1.66/request vs ~$0.02-$0.05 on
        // Flash-class models   a failed cheap attempt is a rounding error next
        // to a single Claude run, so cheap-first wins whenever the cheap model
        // succeeds even a modest fraction of the time.
        const entitledModel = effectiveModel;
        if (!isGuest) {
            if (isCheapTier(requestTier)) {
                const cheapModel = process.env.CHEAP_TASK_MODEL || control.models.freeModel || DEFAULT_FREE_MODEL;
                logger.info(`[agent-stream] Tier=${requestTier} → cheap model: ${cheapModel} (was ${effectiveModel})`);
                effectiveModel = cheapModel;
            } else if (requestTier === 'fix') {
                const fixModel = process.env.FIX_TIER_MODEL || control.models.fallback || DEFAULT_FREE_MODEL;
                logger.info(`[agent-stream] Tier=fix → fix model: ${fixModel} (was ${effectiveModel})`);
                effectiveModel = fixModel;
            } else if (
                requestTier === 'edit' && !isRepairPrompt &&
                process.env.EDIT_TIER_CHEAP_FIRST !== '0'
            ) {
                // Edit tier is the volume tier and was the only one still going
                // straight to the expensive model. Cheap-first, escalate on failure.
                const editFirstModel = process.env.EDIT_TIER_FIRST_MODEL || control.models.fallback || DEFAULT_FREE_MODEL;
                if (editFirstModel !== effectiveModel) {
                    logger.info(`[agent-stream] Tier=edit → cheap-first model: ${editFirstModel} (entitled: ${entitledModel})`);
                    effectiveModel = editFirstModel;
                }
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
            currentRun.emit('start', { projectId, model: 'fast-path', mode: effectiveMode });

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
                    currentRun.emit('text-delta', { text });
                } catch (fastErr) {
                    logger.warn(`[agent-stream] Fast path LLM failed, falling back to agent loop: ${(fastErr as Error).message}`);
                    fastModel = null; // fall through to the agent loop below
                }
            }

            if (fastModel) {
                currentRun.emit('done', { mode: effectiveMode, summary: '', tokensUsed: 0 });
                return;
            }
        }

        const buildAgentLoopParams = (model: string): AgentRunParams => ({
            prompt,
            projectId,
            appPath,
            model,
            mode: effectiveMode,
            chatMode: chatMode === 'admin' ? 'admin' : 'normal',
            approvedPlanSteps,
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
                emit: (event: string, data: any) => {
                    // 'done' means "the answer is complete", NOT "the run is
                    // over" -- persist and lock release still follow. Mark the
                    // teardown window so a prompt arriving now waits for the
                    // real end instead of being swallowed as a subscriber.
                    if (event === 'done') currentRun.finishing = true;
                    // Mirror the publish stage so /active-run can report it to a
                    // client that is polling rather than streaming.
                    if (event === 'status' && typeof data === 'object' && data !== null
                        && 'phase' in data && (data as { phase?: unknown }).phase === 'publishing') {
                      currentRun.phase = 'publishing';
                    }
                    return currentRun.emit(event, data);
                },
                // Not replayable: a keepalive is meaningful only to a socket
                // that is open right now, and buffering thousands of them would
                // spend the replay cap on frames a rejoining client cannot use.
                heartbeat: () => currentRun.emitRaw(': heartbeat\n\n', false),
            },
            userId,
            abortSignal: routeAbortController.signal,
            agentLockToken,
        });

        // The route-level semantic-cache interceptor was REMOVED here (2026-09-01).
        //
        // It called checkSemanticCache() with no guard of any kind -- any prompt,
        // any project, any user -- and on a >=0.94 similarity hit it wrote the
        // matched snapshot's files into this project and returned a completed
        // run without invoking the model. `match_semantic_cache` carries no
        // project_id and no user_id, so the pool it matched against is global:
        // that is precisely the cross-user codebase-replacement path from the
        // 2026-08-31 incident. agentLoopService.ts had been gated behind
        // SEMANTIC_CACHE_ENABLED=false in response to that incident, but this
        // second, independent call site was missed and stayed live.
        //
        // Deleted rather than flag-gated on purpose: a flag invites switching
        // the unscoped design back on. Re-introducing any cache read here
        // requires provenance on the cache rows first (project/user scoping),
        // not a boolean.
        agentResult = await runAgentLoop(buildAgentLoopParams(effectiveModel));

        // ── Cheap-first escalation ───────────────────────────────────────────
        // If the cheap-first attempt landed ZERO changes (stuck-aborted or
        // just produced nothing), retry once on the model the user's plan
        // actually entitles them to. A wasted cheap attempt costs ~$0.02-0.05;
        // even a 100% escalation rate here still costs far less than sending
        // every edit-tier request straight to Claude, and most requests won't
        // need to escalate at all. Never escalates above the entitled model,
        // and never escalates more than once (no cascades).
        // "Wrote nothing" is NOT the same as "failed". A run that investigated
        // with live tools and correctly concluded nothing needed changing is a
        // correct outcome, and re-running the entire loop on a stronger model
        // is pure waste -- measured at $1.42 and 110 seconds on 2026-08-22 for
        // a second attempt that also (correctly) wrote nothing. Worse, forcing
        // a second attempt leaves the model needing to explain why it produced
        // no work, and the nearest explanation on hand was a two-hour-old
        // rollback in the chat history, which it reported as current.
        //
        // So escalate only on evidence of actual failure: the stuck detector
        // fired, or the run ended with a build we know is broken. A healthy
        // build plus zero writes terminates here.
        const zeroChanges = agentResult
            && (agentResult.filesToWrite?.length ?? 0) === 0
            && (agentResult.filesToDelete?.length ?? 0) === 0
            && (agentResult.renames?.length ?? 0) === 0;
        const cheapFirstMadeNoProgress = agentResult && (
            agentResult.stuckAborted === true
            || (zeroChanges && agentResult.buildHealthy !== true)
        );
        if (
            effectiveModel !== entitledModel &&
            cheapFirstMadeNoProgress &&
            !routeAbortController.signal.aborted
        ) {
            logger.info(`[agent-stream] Cheap-first model (${effectiveModel}) made no changes   escalating to entitled model ${entitledModel}`);
            // The cheap attempt already streamed a COMPLETE answer to the
            // client, which accumulates deltas into one message. The escalated
            // run is about to stream another complete answer for the same
            // prompt, so without this the user reads the same reply twice --
            // reported 2026-08-22 as the agent "repeating itself and still
            // running after it finished". Tell the client to discard what the
            // superseded attempt said before the replacement starts.
            currentRun.emit('text-reset', { reason: 'escalating' });
            currentRun.emit('status', { phase: 'escalating', message: 'Retrying with a stronger model...' });
            effectiveModel = entitledModel;
            agentResult = await runAgentLoop(buildAgentLoopParams(entitledModel));
        }

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
                currentRun.emit('error', { message });
            }
        }
    } finally {
        // Charge eco only if the agent actually wrote or deleted files.
        // Ghost runs (text-only answers, plan proposals) are free.
        const wroteFiles = (agentResult?.filesToWrite?.length ?? 0) > 0
            || (agentResult?.filesToDelete?.length ?? 0) > 0;
        if (ecoOrgId && wroteFiles) {
            // Cost-based, clamped eco amount computed server-side   see incrementEcoUsage.
            const ecoAmount = agentResult?.ecoUsed ?? 1;
            incrementEcoUsage(ecoOrgId, ecoAmount).catch((err) =>
                logger.warn(`[agent-stream] Eco charge failed for org ${ecoOrgId}: ${(err as Error).message}`),
            );
        }

        stopAgentLockHeartbeat();
        // Release the cross-worker DB lock BEFORE dropping the in-memory entry.
        // The old order deleted the map entry first, so if all 3 delete retries
        // failed the project was left in the one inconsistent state that is
        // user-visible and self-sustaining: DB says locked, no worker can see
        // or rejoin the run, and nothing clears it until the staleness bound
        // lapses. Releasing first means the only transient inconsistency is the
        // harmless direction (lock free, map entry lingering for the few ms
        // until the next line).
        await releaseAgentLock(projectId);
        // Converge the happy path onto the same ledger state the crash path
        // produces. Without this a cleanly-released lock still reads as
        // "standing" to every other worker, which is the visibility bug again
        // in a new location.
        await markReverted(lockEffectId);
        forgetRun(agentLockToken);
        activeAgentRuns.delete(projectId);
        // Tear down the ephemeral per-run sandbox. A non-null sandbox always has
        // an ephemeral path under the runs root (never projectDir), so this only
        // ever removes throwaway state. The new revision is already persisted.
        if (sandbox) { try { discardSandbox(sandbox.sandboxPath); } catch { /* best-effort */ } }
        // Signal waiters only now: the lock is released above, so anyone who
        // parked during teardown can acquire it immediately on wake.
        currentRun.markEnded();
        // 'end' closes every attached connection through its own subscriber,
        // this request's included -- the run does not close sockets itself.
        currentRun.bus.emit('end');
        void publishRunEnd(projectId, agentLockToken);
        currentRun.bus.removeAllListeners();
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

/**
 * Abort whatever run is in flight for this project.
 *
 * Aborts locally when this worker owns the run; otherwise asks the other
 * cluster worker over Redis, since the abort handle only exists in the memory
 * of the process that started the run. Always answers 200: "there was nothing
 * to stop" is a success from the caller's point of view, and a Stop button
 * that can fail is worse than one that is idempotent.
 */
router.post('/cancel-run/:projectId', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    const local = activeAgentRuns.get(projectId);
    if (local) {
        local.abort();
        logger.info('[agent-stream] Run cancelled by request (local worker)', { projectId });
        res.json({ cancelled: true, scope: 'local' });
        return;
    }
    const relayed = await publishRunCancel(projectId);
    logger.info('[agent-stream] Run cancel relayed to peers', { projectId, relayed });
    res.json({ cancelled: relayed, scope: relayed ? 'relayed' : 'none' });
});

// Honour cancels aimed at runs THIS worker owns. Registered once at module
// load; the abort handle is per-process, so each worker listens for itself.
subscribeRunCancel((projectId) => {
    const run = activeAgentRuns.get(projectId);
    if (!run) return;
    logger.info('[agent-stream] Run cancelled by peer request', { projectId });
    run.abort();
});

// Check if a project has an active agent run (used by frontend to auto-reconnect)
router.get('/active-run/:projectId', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    const run = activeAgentRuns.get(projectId);
    if (run) {
        // Owned by THIS worker, so its event bus is in our memory and the
        // caller's SSE reconnect can actually attach to it.
        // phase distinguishes "still generating" from "generating done, now
        // publishing" -- the publish stage measured 104-139s, long enough that
        // the difference is user-visible. Without it the client polls preview
        // /status independently and "ready" can contradict the run.
        res.json({
            active: true, attachable: true, phase: run.phase ?? 'generating',
            startedAt: run.startedAt, ageMs: Date.now() - run.startedAt,
        });
        return;
    }

    // `activeAgentRuns` is per-process but `ecomgear-gen` runs 2 PM2 cluster
    // workers, so a miss here does NOT mean no run is happening -- it means no
    // run is happening *on this worker*. Answering a flat `active: false` while
    // the other worker holds the project's lock is what produced the reported
    // contradiction: the panel showed nothing running, then the user's next
    // message round-robined into the lock check and came back "A generation is
    // already running for this project". Consult the cross-worker lock so both
    // answers come from the same source of truth. `attachable: false` tells the
    // client a run is live but its stream lives in another process, so it
    // should reflect the running state and poll rather than open an SSE
    // reconnect that can only 429.
    const lock = await readLiveAgentLock(projectId);
    if (lock) {
        const startedAt = new Date(lock.acquired_at).getTime();
        // Phase 5: the run may be on the other worker but still ATTACHABLE, if
        // that worker has been mirroring it to the broker. Only report
        // attachable: false when there is genuinely no stream to relay --
        // otherwise the client needlessly falls back to polling a run it could
        // be watching.
        const attachable = Boolean(lock.token) && await runStreamExists(projectId, lock.token);
        res.json({ active: true, attachable, startedAt, ageMs: Date.now() - startedAt });
        return;
    }

    res.json({ active: false });
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
    // The run this rollback targets, used to find its revision manifest. When
    // only a snapshotId was given it is embedded in that id ({projectId}_{runId}),
    // so both callers reach the manifest path.
    let rollbackRunId: string | undefined = runId;
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

    // The chat-panel caller sends only a snapshotId, whose second half is a
    // fresh UUID rather than the run's id, so the run has to be found by the
    // snapshot it owns. Scoped to this project, which ownership was just
    // verified for. Without this, that caller could never reach the manifest
    // path below and would always restore from the shared-disk copy.
    if (!rollbackRunId && snapshotId && supabase) {
        const { data: ownerRun } = await supabase
            .from('agent_runs')
            .select('id')
            .eq('snapshot_id', snapshotId)
            .eq('project_id', projectId)
            .maybeSingle();
        if (ownerRun?.id) rollbackRunId = ownerRun.id;
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

    // ── Manifest rollback (preferred) ────────────────────────────────────────
    // A snapshot is a copy of the SHARED project dir, so it captures whatever
    // else was sitting there, and the restore below then sweeps that same dir
    // again -- which is how a rollback re-injected another project's pages after
    // the 2026-08-31 incident. A revision manifest can only contain what that
    // revision recorded, so restoring from it cannot carry anything foreign.
    // The snapshot path is kept solely for revisions with no usable manifest.
    if (rollbackRunId) {
        try {
            const targetRevisionId = await findRunRevision(projectId, rollbackRunId);
            if (targetRevisionId) {
                const files = await fetchRevisionFiles(projectId, targetRevisionId);
                if (files && files.length > 0) {
                    const rolled = await rollbackToRevision(projectId, req.user!.id, targetRevisionId);
                    if (rolled.ok) {
                        const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001';
                        const previewRes = await fetch(`${previewServiceUrl}/preview/${projectId}/update`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            // fullSync prunes anything not in the manifest, which is
                            // the point: the project ends up as exactly that revision.
                            body: JSON.stringify({ files, fullSync: true }),
                    // Restoring a whole project is a large upload: CardPro's
                    // 199-file tree is 38.5 MB once binaries are base64'd, and
                    // its successful pushes measure 104-139s. The previous 20-30s
                    // ceilings aborted mid-upload EVERY time on any real project,
                    // which nginx logged as a zero-byte 400 and nothing retried --
                    // so HEAD was restored while the live preview kept serving the
                    // old files (observed on CardPro, 2026-09-02 06:43/07:25/07:26).
                            signal: AbortSignal.timeout(PREVIEW_RESTORE_TIMEOUT_MS),
                        });
                        // A swallowed push is why a broken restore looked successful:
                        // HEAD moved, the preview did not, and nothing said so.
                        const previewRestored = previewRes?.ok === true;
                        if (!previewRestored) {
                            logger.warn('[rollback] revision restored but the PREVIEW push failed', {
                                projectId, targetRevisionId, status: previewRes?.status, files: files.length,
                            });
                        }
                        logger.info('[rollback] restored from revision manifest', {
                            projectId, targetRevisionId, newRevisionId: rolled.revisionId,
                            files: files.length, previewRestored,
                        });
                        res.json({
                            success: true, source: 'manifest', revisionId: rolled.revisionId,
                            fileCount: files.length, previewRestored,
                        });
                        return;
                    }
                    logger.warn('[rollback] manifest rollback failed, falling back to snapshot', { projectId, error: rolled.error });
                }
            }
        } catch (mErr) {
            logger.warn('[rollback] manifest path errored, falling back to snapshot', {
                projectId, error: (mErr as Error).message,
            });
        }
    }

    logger.warn('[rollback] using the snapshot path (no usable revision manifest for this version)', { projectId, snapshotId });
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
            const snapshotPreviewRes = await fetch(updateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: restoredFiles, fullSync: true }),
                // See PREVIEW_RESTORE_TIMEOUT_MS: a whole-project restore is a
                // multi-megabyte upload and 20s aborted it every time.
                signal: AbortSignal.timeout(PREVIEW_RESTORE_TIMEOUT_MS),
            });
            if (!snapshotPreviewRes.ok) {
                logger.warn('[rollback] snapshot restored but the PREVIEW push failed', {
                    projectId, status: snapshotPreviewRes.status, files: restoredFiles.length,
                });
            }
        } catch (pushErr) {
            logger.warn('[rollback] preview push threw during snapshot restore', {
                projectId, error: (pushErr as Error).message, files: restoredFiles.length,
            });
        }

        // Persist a new DB revision with the restored files so that refreshing the
        // editor loads these files instead of the previous latest revision.
        //
        // Written through persistAgentRevision, NOT a hand-rolled insert.
        //
        // The previous insert here wrote `generated_files: { files: [...] }` with
        // no `format` key and with every binary filtered out. Three consequences,
        // all silent:
        //   1. fetchHeadManifest requires format === 'manifest-v1', so after any
        //      snapshot rollback the project's HEAD became unreadable TO THE
        //      SERVER. openSandbox then took its no-HEAD branch and copied the
        //      shared project dir -- the contamination reservoir the per-run
        //      sandbox exists to eliminate -- and fetchHeadHashes returned empty,
        //      so every preview push reverted to a whole-tree fullSync (measured
        //      at 38.5 MB / 104-139s on CardPro, 2026-09-01).
        //   2. Every image, font and PDF was dropped from the recorded state.
        //   3. Content was stored inline in the row instead of in Storage.
        // persistAgentRevision handles all three and is the path every other
        // writer already uses, including the oversized-asset carry-forward.
        try {
            if (restoredFiles.length > 0) {
                const persisted = await persistAgentRevision(
                    projectId,
                    req.user!.id,
                    restoredFiles,
                    `Rolled back to snapshot ${snapshotId.slice(-8)}`,
                    `Rolled back to snapshot ${snapshotId.slice(-8)}`,
                );
                if (persisted.ok) {
                    logger.info('[rollback] Persisted rollback as manifest-v1 revision', {
                        projectId, revisionId: persisted.revisionId,
                        files: restoredFiles.length, skipped: persisted.skippedPaths,
                    });
                } else {
                    // Leave the previous good HEAD standing rather than writing an
                    // unreadable one: a stale but READABLE HEAD still gets
                    // HEAD-materialised sandboxes and changeset pushes, which is
                    // strictly better than the silent degradation above.
                    logger.warn('[rollback] Could not persist rollback revision; previous HEAD left intact', {
                        projectId, error: persisted.error,
                    });
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
