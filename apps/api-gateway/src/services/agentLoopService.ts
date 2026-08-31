
import { streamText, generateText, ToolSet, stepCountIs, jsonSchema, wrapLanguageModel } from 'ai';
import { phantomAbortThresholdFor, isStuckAndBuildKnownBroken, unfulfilledPromiseNote, DIAGNOSIS_TOOL_NAMES, extractImplicatedFiles, shouldSeedScope } from './agentGating.js';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { AgentContext } from '../agent-tools/types.js';
import { safeJoin, deriveDbMutationKey } from '../agent-tools/types.js';
import { normalizeScopePath } from '../agent-tools/declare_scope.js';
import { scanForDeadDangerousEdgeFunctions } from './edgeFunctionSecurityScan.js';
import { EDGE_FUNCTIONS_DIR } from '../agent-tools/write_edge_function.js';
import { sanitizeFileContent, sanitizeConfigFile } from '../agent-tools/sanitize.js';
import { RunTracer } from './runTrace.js';
import ts from 'typescript';
import { getAppBuilderBuildSystemPrompt, getAppBuilderSystemPrompt, MICRO_SYSTEM_PROMPT, getFixSystemPrompt, getEditSystemPrompt } from '../prompts/app-builder.prompt.js';
import { PRE_INSTALLED_PACKAGES } from './baseTemplateService.js';
import { RunStateLedger } from './runStateLedger.js';
import { canonicalizeModelId, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL } from '../config/models.js';
import { runPreviewSmokeCheck } from './previewSmokeCheck.service.js';
import { indexFile, indexFiles, retrieveRelevantFiles, extractSymbols, getProvider } from '../knowledgebase/index.js';
import { persistAgentRevision } from './agentRevisionPersist.service.js';
import { captureThumbnail } from './thumbnailService.js';
import { createStripToolsForCacheMiddleware } from './geminiToolCache.service.js';
import { beginRun as beginNarration, updateThought, endRun as endNarration, generateStatus, getNarrationCost, type LifecyclePhase } from './narration.service.js';
import { lookupFailureFix, storeFailureFix } from './failureMemory.service.js';
import { checkSemanticCache, storeSemanticCache } from './agentSemanticCache.js';
import { databaseService, buildProjectEnvSecrets } from './database.service.js';
import {
  isBillingCircuitOpen, tripBillingCircuit, extractCacheUsage,
  isRetryableError, isRateLimitError, sanitizeErrorMessage, isAuthOrBillingError,
  isNetworkError, isTransientStreamDrop, getRetryAfterMs, getDefaultAgentTimeoutMs,
  isLikelyFixRequest, buildFallbackCandidates, createProviderForModel, resolveProviderWithFallback,
} from './agentProviderResolution.js';
import { snapshotProject, restoreSnapshot, createGeminiRunCache, SNAPSHOTS_DIR, MAX_SNAPSHOTS_PER_PROJECT } from './agentSnapshot.js';
import { computeErrorFingerprint, recordThrashTrip } from './thrashDetector.js';
import {
  EXTRACTABLE_DOC_TYPES, extractDocumentText, isReferenceScreenshot, isScreenshotFilename,
  hasEmbedIntent, supportsVision, analyzeImageWithVision,
} from './agentVision.js';
import {
  MAX_PROMPT_CHARS, MAX_OLDER_SUMMARY_CHARS, MAX_FILE_TREE_CHARS, MAX_ATTACHMENT_CONTEXT_CHARS,
  clampContextSection, compactStepMessages,
} from './agentContextCompaction.js';
import { deriveRoutePath, generateAppTsxFromPages, buildMinimalSearchReplace } from './agentAppTsxGen.js';
import { buildToolSet } from './agentToolSet.js';
import { buildFileTree, getProjectFileTree, SKIP_DIRS } from './agentFileTree.js';
import { acquireProjectLock, cleanupProjectLock } from './agentProjectLock.js';
import { parseXmlOperation, parseXmlResponse, type OperationStore } from './agentXmlParser.js';
import { logger } from '../utils/logger.js';
import { writeProjectFileSync } from './projectFileWriter.js';
import { interpretPreviewPush } from './previewPushResult.js';
import { NarrationFilter } from './narrationFilter.js';
import { arbitrateFailureClaim } from './staleFailureClaim.js';
import { renderRunStateHeader } from './runStateHeader.js';
import { orphanedEffects } from './effectLedger.js';
import { stripBinariesForClient, payloadBytes } from './clientFilePayload.js';
import { isRetryableSyncStatus, readSecretsWrittenCount } from './secretsSyncOutcome.js';

// Supabase service-role client for agent_runs tracking (fire-and-forget)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const SUPPRESS_RECOVERY_UI = (process.env.AGENT_SUPPRESS_RECOVERY_UI ?? '1') !== '0';

// ── Binary-file handling, shared by every path that reads appPath off disk ──
// Hoisted to module scope (was previously two independent local copies: one
// used by the end-of-turn write-collection path, one implicitly absent from
// the pre-agent snapshot path below). The snapshot path's lack of this
// encoding, plus a directory scope that never covered public/, silently
// deleted or corrupted every uploaded image/logo the next time a revert/
// restore/salvage fullSync push went out built from that snapshot -- confirmed
// 2026-08-09 as the cause of "my logo disappears when I deploy".
const BINARY_EXTS_SET = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
const BINARY_SENTINEL = '__ECOMGEAR_BIN64__';


/** Read a file for a disk snapshot/write-collection payload, base64-encoding binaries with BINARY_SENTINEL so they survive the JSON sync payload intact (mirrors preview-service's own BINARY_EXTS handling on the receiving end). */
function readFileForSync(fullPath: string): string {
  const ext = path.extname(fullPath).toLowerCase();
  if (BINARY_EXTS_SET.has(ext)) {
    const buf = fs.readFileSync(fullPath);
    logger.debug('readFileForSync: read binary file (base64-encoded)', { fullPath, ext, bytes: buf.length });
    return `${BINARY_SENTINEL}${buf.toString('base64')}`;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  logger.debug('readFileForSync: read text file', { fullPath, ext, chars: content.length });
  return content;
}

// Self-healing backfill for projects that had edge functions written before
// the __edge_functions__/ mirror existed. Runs once at the start of every
// agent run   cheap (single query, early-exits when nothing's missing) and
// spreads the fix across every existing project the next time each one is
// actually used, instead of a one-off bulk migration touching every live
// preview at once.
async function backfillEdgeFunctionMirrors(appPath: string, projectId: string): Promise<void> {
  const startedAtMs = Date.now();
  logger.debug('backfillEdgeFunctionMirrors: invoked', { projectId, appPath, hasSupabase: Boolean(supabase) });
  if (!supabase) {
    logger.debug('backfillEdgeFunctionMirrors: no supabase client configured, skipping', { projectId });
    return;
  }
  try {
    const { data: fns } = await supabase
      .from('edge_functions')
      .select('name, code')
      .eq('project_id', projectId);
    if (!fns || fns.length === 0) {
      logger.debug('backfillEdgeFunctionMirrors: no edge_functions rows for project, nothing to backfill', { projectId });
      return;
    }
    logger.debug('backfillEdgeFunctionMirrors: found edge_functions rows', { projectId, count: fns.length });

    let mirroredCount = 0;
    let skippedExistingCount = 0;
    for (const fn of fns) {
      if (!fn.name || typeof fn.code !== 'string') continue;
      const mirrorPath = safeJoin(appPath, `${EDGE_FUNCTIONS_DIR}/${fn.name}.js`);
      if (fs.existsSync(mirrorPath)) { skippedExistingCount++; continue; }
      try {
        // Single-owner write path. No runId: this backfill reconstructs a
        // missing mirror from the DB and is not an agent-run effect, so it must
        // not enter the ledger as something a later recovery could "undo".
        writeProjectFileSync({ appPath, projectId }, `${EDGE_FUNCTIONS_DIR}/${fn.name}.js`, fn.code);
        mirroredCount++;
        logger.debug('backfillEdgeFunctionMirrors: wrote missing mirror file', { projectId, fnName: fn.name, mirrorPath });
      } catch (writeErr: any) {
        // best-effort   a write failure here shouldn't block the run
        logger.debug('backfillEdgeFunctionMirrors: mirror write failed (non-fatal)', {
          projectId, fnName: fn.name, mirrorPath, error: writeErr?.message,
        });
      }
    }
    logger.debug('backfillEdgeFunctionMirrors: done', {
      projectId, mirroredCount, skippedExistingCount, durationMs: Date.now() - startedAtMs,
    });
  } catch (err: any) {
    // best-effort   DB unavailable shouldn't block the run
    logger.debug('backfillEdgeFunctionMirrors: failed (non-fatal, DB likely unavailable)', {
      projectId, error: err?.message, durationMs: Date.now() - startedAtMs,
    });
  }
}

// ─── Per-project KB batch-index guard ────────────────────────────────────────
// Tracks which projects have had their full file tree indexed this server process.
// Prevents re-scanning on every request   individual file writes handle updates.
const kbBatchIndexedProjects = new Set<string>();

// ─── Event sink ──────────────────────────────────────────────────────────────
// The loop doesn't know or care whether it's streamed over SSE, collected in a
// test array, or piped somewhere else   it just calls sink.emit/heartbeat.

export interface AgentEventSink {
  emit(event: string, data: unknown): void;
  heartbeat(): void;
}

// Re-exported so callers (e.g. ai.routes.ts) can import rollback support
// straight from this module without knowing it now lives in agentSnapshot.ts.
export { snapshotProject, restoreSnapshot };

// ─── Eco pricing ────────────────────────────────────────────────────────────
// Eco = the AI-generation credit unit charged per run (ai_gens_used/limit on
// organizations). Derived from actual run cost instead of a flat 1/run, but
// clamped to [0.5, 2.0] — a PURE cost-based formula was tried before and
// reverted (see ai.routes.ts's incrementEcoUsage) because a single "thinking"
// model run (e.g. gemini-3.1-pro-preview) can burn 100K+ tokens and would
// otherwise drain an entire free-tier month in one request. The clamp keeps
// pricing usage-proportional while bounding the worst case.
function computeEcoCost(costUsd: number): number {
  const raw = costUsd / 0.05;
  const clamped = Math.min(2.0, Math.max(0.5, raw));
  const eco = Math.round(clamped * 10) / 10;
  logger.debug('computeEcoCost: computed', { costUsd, raw, clamped, eco });
  return eco;
}

// ─── Stuck-loop content signal ──────────────────────────────────────────────
// Cheap word-overlap similarity (Jaccard over normalized word sets, words >2
// chars only) between two `think` call thoughts — no embeddings/API call,
// same "character-distance only, no semantic matching" tradeoff sanitize.ts's
// closestLucideIcon already makes for this codebase: good enough to catch
// "restating the same conclusion" without adding cost or latency to every step.
export function thinkContentSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  const similarity = union === 0 ? 0 : intersection / union;
  logger.debug('thinkContentSimilarity: computed', {
    aPreview: a.slice(0, 100), bPreview: b.slice(0, 100), setASize: setA.size, setBSize: setB.size, similarity,
  });
  return similarity;
}

// Language that explicitly explains why a prior diagnosis was wrong, as opposed
// to silently replacing it. Used by the root-cause-lock (Phase 3 of the
// 2026-08-06 audit) to distinguish a legitimate, evidence-backed pivot from a
// silent hypothesis swap.
export const FALSIFICATION_RE =
  /\b(wasn'?t (the|actually the|really the)\s*(real\s+|actual\s+)?(cause|issue|problem|root cause)|(that|this)\s+(wasn'?t|was not|isn'?t|is not) (it|correct|right|the (cause|issue|problem))|turns out|actually,?\s+the (real\s+)?(cause|issue|problem) (is|was)|i was (wrong|mistaken)|misdiagnosed|ruled out|doesn'?t explain|does not explain|not the (real\s+)?(cause|issue|problem)|rethinking|scratch that)\b/i;

// ─── Agent params / result types ──────────────────────────────────────────────

export interface AgentRunParams {
  /** User's prompt */
  prompt: string;
  /** Project ID (used as workspace identifier) */
  projectId: string;
  /** Absolute path to the project on disk */
  appPath: string;
  /** Model name override (default: claude-3-5-haiku-20241022) */
  model?: string;
  /** Runtime mode selected by backend orchestration */
  mode?: 'build' | 'plan';
  /**
   * Chat mode the USER explicitly selected in the editor UI: 'normal'
   * (default) is regular development work; 'admin' additionally exposes
   * direct database tools (query_database, etc.) for real database/user
   * fixes -- see AgentContext.chatMode and agentToolSet.ts's ADMIN_ONLY_TOOLS.
   * Distinct from `mode` above (build/plan orchestration), hence the name.
   */
  chatMode?: 'normal' | 'admin';
  /**
   * Ordered steps from an approved agent_plans row for this project, if one
   * exists when a build run starts (see ai.routes.ts's build-mode trigger).
   * Injected as a checklist into the build system prompt -- the loop still
   * executes reactively per step, this isn't a rigid script.
   */
  approvedPlanSteps?: string[];
  /** Existing files to provide as context */
  existingFiles?: Array<{ path: string; content: string }>;
  /**
   * Recent conversation history (already-cleaned, no ecomgear tags).
   * The current user prompt is NOT included   it is always appended last.
   * Max recommended: last 6 messages (3 user+assistant pairs).
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * One-line summaries of turns older than the history window.
   * Injected into the system prompt to give context without burning tokens.
   */
  olderSummary?: string;
  /** Typed prompt intent flags computed by the backend request boundary. */
  promptIntent?: {
    isWebsiteBuild?: boolean;
    hasIntegrationRequest?: boolean;
    /** Cost-routing tier from intentClassifier   drives MAX_STEPS and model override */
    requestTier?: 'micro' | 'fix' | 'edit' | 'feature' | 'build';
  };
  /** Files attached by the user in the chat message (images, docs, etc.) */
  attachments?: Array<{
    name: string;
    type: string;
    category: 'image' | 'document';
    tempPath: string;
    /**
     * Durable Supabase Storage signed URL (5-year expiry, see
     * chatAttachmentService.ts), separate from tempPath's /tmp copy (cleaned
     * up after 1 hour). Used to re-materialize the file if tempPath has
     * already expired by the time this attachment is processed -- confirmed
     * 2026-08-09 as a real race: users see the image rendered in chat (via
     * this durable URL) long after the ephemeral /tmp copy is gone, then ask
     * the agent to place it and hit a genuine "expired" error with no
     * recovery path other than re-uploading.
     */
    publicUrl?: string;
  }>;
  /** Project knowledge from KnowledgeSettings (custom system prompt + context notes) */
  projectKnowledge?: {
    customSystemPrompt: string;
    contextNotes: string;
  };
  /** Project secrets   injected as env var hints for the agent, never echoed to user */
  projectSecrets?: Array<{ key_name: string; key_value: string }>;
  /** Event sink the run streams progress through (production: SSE over Express; tests: an in-memory collector) */
  sink: AgentEventSink;
  /** Authenticated user ID for tracking */
  userId?: string;
  /** Optional external abort signal (e.g. client disconnected) */
  abortSignal?: AbortSignal;
  /**
   * Token for the DB-backed `agent_locks` row this run holds (see
   * ai.routes.ts's tryAcquireAgentLock). Sent as `x-agent-lock-token` on every
   * preview-service push below so preview-service can tell "this push came
   * from the run that holds the lock" apart from any other actor   including
   * a direct manual push racing this same run.
   */
  agentLockToken?: string;
}

export interface AgentRunResult {
  /** All files written during this run */
  filesToWrite: Array<{ path: string; content: string }>;
  filesToDelete: string[];
  renames: Array<{ from: string; to: string }>;
  dependencies: string[];
  summary: string;
  /** Actual USD cost of this run (0 on timeout/no-charge paths) */
  costUsd: number;
  /** Eco credits charged for this run, see computeEcoCost() */
  ecoUsed: number;
  /** True when the run hit the budget cap mid-task but made real progress   safe to auto-continue */
  needsAutoContinue?: boolean;
  /** Ready-to-send prompt for the auto-continuation turn, set only when needsAutoContinue is true */
  continuationPrompt?: string;
  /** True when the stuck-analysis detector killed the run   the model spun without landing changes */
  stuckAborted?: boolean;
  /**
   * What a real get_build_errors call reported, if one ran. Exposed so callers
   * can tell "nothing needed changing" apart from "failed to change anything":
   * a healthy build plus zero writes is a correct outcome, not a failure.
   */
  buildHealthy?: boolean;
  /**
   * The mode this run actually executed under -- may differ from the
   * client-requested mode when an execute-confirmation phrase ("yes",
   * "go ahead", "do it") flips a plan-mode request into build (see
   * EXECUTE_CONFIRM_RE below). The client uses this to keep its own
   * Plan/Build toggle in sync with what actually happened, since the
   * override decision now lives here, not in the client.
   */
  runtimeMode: 'build' | 'plan';
}

export async function runAgentLoop(params: AgentRunParams): Promise<AgentRunResult> {
  const { projectId, userId, model, mode } = params;
  const startedAtMs = Date.now();
  logger.info('runAgentLoop: invoked', {
    projectId, userId, model, mode,
    promptLength: params.prompt?.length ?? 0,
    promptPreview: params.prompt?.slice(0, 300),
    historyCount: params.history?.length ?? 0,
    attachmentCount: params.attachments?.length ?? 0,
    hasApprovedPlanSteps: Boolean(params.approvedPlanSteps?.length),
  });

  // ── Per-project mutex: prevent interleaved file writes from concurrent runs ──
  const lock = acquireProjectLock(projectId);
  logger.debug('runAgentLoop: waiting on per-project lock', { projectId });
  await lock.ready;
  logger.debug('runAgentLoop: acquired per-project lock', { projectId, waitMs: Date.now() - startedAtMs });
  try {
    const result = await _runAgentLoopInner(params);
    logger.info('runAgentLoop: _runAgentLoopInner returned', {
      projectId, userId, durationMs: Date.now() - startedAtMs,
      filesWritten: result.filesToWrite.length, filesDeleted: result.filesToDelete.length,
      renames: result.renames.length, costUsd: result.costUsd, ecoUsed: result.ecoUsed,
      stuckAborted: result.stuckAborted, needsAutoContinue: result.needsAutoContinue, runtimeMode: result.runtimeMode,
    });
    // End-of-turn dead-but-dangerous scan (auth/password edge functions
    // deployed but unreferenced by the frontend). Non-fatal on its own,
    // never blocks or fails the turn -- see edgeFunctionSecurityScan.ts.
    logger.debug('runAgentLoop: running end-of-turn dead-but-dangerous edge function scan', { projectId });
    await scanForDeadDangerousEdgeFunctions(projectId, params.appPath);
    logger.info('runAgentLoop: complete', { projectId, userId, durationMs: Date.now() - startedAtMs });
    return result;
  } catch (err: any) {
    logger.error('runAgentLoop: failed', {
      projectId, userId, durationMs: Date.now() - startedAtMs,
      error: err?.message, stack: err?.stack,
    });
    throw err;
  } finally {
    lock.release();
    endNarration(projectId);
    // Clean up the lock chain entry if we're the last in queue
    cleanupProjectLock(projectId);
    logger.debug('runAgentLoop: released lock and cleaned up narration/lock-chain state', { projectId });
  }
}

async function _runAgentLoopInner(params: AgentRunParams): Promise<AgentRunResult> {
  const { prompt, projectId, appPath, model, mode, chatMode, existingFiles, history, olderSummary, promptIntent, attachments, projectKnowledge, projectSecrets, sink, userId, abortSignal, agentLockToken, approvedPlanSteps } = params;
  const _innerStartedAtMs = Date.now();
  logger.info('_runAgentLoopInner: invoked', {
    projectId, userId, appPath, model, mode, chatMode,
    promptLength: prompt?.length ?? 0,
    promptPreview: prompt?.slice(0, 300),
    existingFilesCount: existingFiles?.length ?? 0,
    historyCount: history?.length ?? 0,
    hasOlderSummary: Boolean(olderSummary),
    promptIntent,
    attachmentCount: attachments?.length ?? 0,
    hasProjectKnowledge: Boolean(projectKnowledge),
    projectSecretsCount: projectSecrets?.length ?? 0,
    hasAbortSignal: Boolean(abortSignal),
    hasAgentLockToken: Boolean(agentLockToken),
    approvedPlanStepsCount: approvedPlanSteps?.length ?? 0,
  });

  // Start a narration context for this run so the narrator can ground its
  // real-time descriptions in the agent's think() reasoning + user intent.
  beginNarration(projectId, prompt);

  // Backfill __edge_functions__/ mirrors for any function written before
  // that mirror pattern existed   see backfillEdgeFunctionMirrors above.
  await backfillEdgeFunctionMirrors(appPath, projectId);

  // Dynamic step budget: map request tier to a proportionate step ceiling.
  // Values must match TIER_MAX_STEPS in intentClassifier.ts.
  const _tier = promptIntent?.requestTier;
  const MAX_STEPS = _tier === 'micro'   ?  8
                  : _tier === 'fix'     ? 28
                  : _tier === 'edit'    ? 25
                  : _tier === 'feature' ? 35
                  : _tier === 'build'   ? 45
                  // Legacy fallback when no tier provided (e.g. old clients)
                  : ((promptIntent?.isWebsiteBuild ?? false) || prompt.length > 600) ? 45 : 25;

  // Tier-based token cap. The USD cost cap ($1.50) is the ultimate backstop.
  // These limits just prevent runaway loops   they must be high enough that
  // the final response step is never cut off (agent does work then goes silent).
  // Observed abort patterns: fix hits 124-130K, edit hits 239K → raised accordingly.
  //
  // Doubled 2026-07-15: these counts are RAW tokens (input+output+cacheRead+
  // cacheWrite)   cacheRead counts fully even though it bills at ~10% of a
  // fresh token. Once the mid-run Anthropic cache-breakpoint fix landed, a
  // real edit-tier run got killed at 536K raw tokens while only costing
  // $0.4691   31% of the $1.50 cost cap, nowhere near the "ultimate backstop"
  // this comment describes. The original values were tuned when caching was
  // effectively zero (raw tokens ≈ cost 1:1); now that caching works, they
  // fire before the cost cap ever does, on exactly the cheap/well-cached runs
  // that should be allowed to keep going. Doubling restores the original
  // intent   cost governs, this is just the runaway-loop backstop again. An
  // uncached run would still hit the $1.50 cost cap well before these new
  // ceilings, so this doesn't loosen the actual worst-case protection.
  const TIER_TOKEN_CAP = _tier === 'micro'   ?  160_000
                       : _tier === 'fix'     ?  700_000
                       : _tier === 'edit'    ?  900_000
                       : _tier === 'feature' ? 1_200_000
                       : /* build / legacy */  1_600_000;
  const RUN_TOKEN_CAP = process.env.AGENT_TOKEN_CAP
    ? Math.min(parseInt(process.env.AGENT_TOKEN_CAP, 10), TIER_TOKEN_CAP)
    : TIER_TOKEN_CAP;
  logger.debug('_runAgentLoopInner: step/token budget resolved', {
    projectId, tier: _tier ?? 'unset', MAX_STEPS, TIER_TOKEN_CAP, RUN_TOKEN_CAP,
  });

  const boundedPrompt = clampContextSection('User prompt', prompt, MAX_PROMPT_CHARS);
  const boundedOlderSummary = olderSummary
    ? clampContextSection('Earlier conversation summary', olderSummary, MAX_OLDER_SUMMARY_CHARS)
    : undefined;
  // When the client is in plan mode but the user's message reads as an
  // execution confirmation ("yes", "go ahead", "do it", "ship it"...),
  // switch to build for this turn instead of producing another plan.
  // This decision used to live client-side (AgentChatPanel.tsx's EXECUTE_RE)
  // and only updated the client's own toggle -- the server just trusted
  // whatever `mode` the client sent. Moved here so the actual mode a run
  // executes under is decided in one place, not duplicated in the browser
  // with no server-side awareness of the override. AgentRunResult.runtimeMode
  // reports back whichever mode actually ran, so the client can resync its
  // toggle after the fact instead of deciding upfront.
  const EXECUTE_CONFIRM_RE = /^(execute|apply|do\s+it|go\s+ahead|proceed|yes|confirm|run|ship\s+it|make\s+(the\s+)?changes|ok\s+do\s+it|let'?s?\s+(do\s+it|go)|build\s+it)/i;
  const runtimeMode: 'build' | 'plan' =
    mode === 'plan' && EXECUTE_CONFIRM_RE.test(prompt.trim()) ? 'build'
    : mode === 'plan' ? 'plan'
    : 'build';
  logger.debug('_runAgentLoopInner: runtime mode resolved', { projectId, requestedMode: mode, runtimeMode });

  let requestedModelId = canonicalizeModelId(model || process.env.AI_MODEL, DEFAULT_PRIMARY_MODEL);

  // Per-model kill switch   separate from AI_DISABLE_GEMINI (which disables the
  // whole provider). Needed because the client sends an explicit `model` on
  // every request, so a server-side AI_MODEL env change alone doesn't stop a
  // request for a specific quota-exhausted model id (confirmed live 2026-07-17:
  // gemini-3.1-pro-preview hit its daily RPD cap, but requests kept asking for
  // it by name and dying mid-run instead of using the swapped default).
  const disabledModelIds = new Set(
    (process.env.AI_DISABLED_MODEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  if (disabledModelIds.has(requestedModelId)) {
    const substitute = canonicalizeModelId(process.env.AI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL);
    logger.warn('[AgentLoop] Requested model is disabled, substituting fallback', {
      projectId, requestedModelId, substitute, disabledModelIds: [...disabledModelIds],
    });
    requestedModelId = substitute;
  }

  if (requestedModelId === 'deepseek-reasoner') {
    logger.error('_runAgentLoopInner: requested model does not support tool calling', { projectId, requestedModelId });
    throw new Error('DeepSeek Reasoner (R1) does not support the necessary tool-calling features. Please select deepseek-chat instead.');
  }

  logger.debug('_runAgentLoopInner: resolving provider for model', { projectId, requestedModelId });
  const resolvedModel = resolveProviderWithFallback(requestedModelId);
  const aiProvider = resolvedModel.provider;
  const providerName = resolvedModel.providerName;
  const modelId = resolvedModel.modelId;
  logger.info('_runAgentLoopInner: provider resolved', {
    projectId, requestedModelId, resolvedProviderName: providerName, resolvedModelId: modelId,
    fellBack: modelId !== requestedModelId,
  });
  // Tracks whether this run ends up on a different provider/model than requested
  // (either right away, e.g. a billing circuit already open, or mid-stream via the
  // recovery paths below). Used to give an honest reason when a run stops early
  // with few steps   a real mid-run failover vs. simply the intentionally-assigned
  // tier model (e.g. glm-4.5-flash on the micro tier) not being capable enough.
  let providerFellBackThisRun = modelId !== requestedModelId;

  // Whether this model can accept image content parts in messages
  const visionCapable = supportsVision(providerName, modelId);
  // Collected image data for (a) vision message content and (b) pre-flight analysis
  const imageVisionData: Array<{ name: string; type: string; base64: string; safeName: string }> = [];

  // ── Project's org, for cost/abort attribution (Task 3.1 lean scope) ──────
  let projectOrgId: string | null = null;
  let orgIsInternal = false;
  if (supabase) {
    logger.debug('_runAgentLoopInner: looking up project organization', { projectId });
    const { data: projectOrgRow, error: projectOrgErr } = await supabase
      .from('projects')
      .select('organization_id, organizations!inner(is_internal)')
      .eq('id', projectId)
      .maybeSingle();
    if (projectOrgErr) {
      logger.debug('_runAgentLoopInner: project org lookup errored (non-fatal)', { projectId, error: projectOrgErr.message });
    }
    projectOrgId = (projectOrgRow as any)?.organization_id ?? null;
    orgIsInternal = Boolean((projectOrgRow as any)?.organizations?.is_internal);
    logger.debug('_runAgentLoopInner: project organization resolved', { projectId, projectOrgId, orgIsInternal });
  }

  // ─── agent_runs tracking (fire-and-forget) ───────────────────────────────────
  let agentRunId: string | null = null;
  if (supabase && userId) {
    logger.debug('_runAgentLoopInner: inserting agent_runs tracking row', { projectId, userId, modelId, projectOrgId });
    const { data, error: agentRunInsertErr } = await supabase
      .from('agent_runs')
      .insert({ project_id: projectId, user_id: userId, prompt, model: modelId, organization_id: projectOrgId })
      .select('id')
      .single();
    if (agentRunInsertErr) {
      logger.warn('_runAgentLoopInner: agent_runs insert failed (non-fatal, run continues untracked)', {
        projectId, userId, error: agentRunInsertErr.message,
      });
    }
    agentRunId = data?.id ?? null;
    logger.debug('_runAgentLoopInner: agent_runs row created', { projectId, userId, agentRunId });
  }

  // Full-activity trace (system prompt, every step, service calls, outcome)
  // -- one JSONL per run under AGENT_TRACE_DIR, replayable offline. See
  // runTrace.ts. Guests/no-DB runs get a timestamp id so they trace too.
  const tracer = new RunTracer(agentRunId ?? `local-${Date.now()}`, projectId);
  tracer.event('run-config', { prompt: RunTracer.clip(prompt), model: modelId, userId: userId ?? 'guest' });
  logger.debug('_runAgentLoopInner: run tracer initialized', { projectId, agentRunId: agentRunId ?? `local-${Date.now()}` });

  let stepCount = 0;

  // ── Internal (dogfooding) account detection ──────────────────────────────
  // Two independent signals, either one marks the run internal: the org's own
  // is_internal flag (migration 20260721090000), or AGENT_INTERNAL_USER_IDS
  // (a comma-separated env list   catches internal testers outside the two
  // seeded orgs without a migration each time). Used to (a) tag run logs so
  // cost/abort analysis can filter dogfooding traffic, (b) optionally lift
  // the per-run cost cap for internal runs via AGENT_COST_CAP_USD_INTERNAL so
  // testing stops dead-ending at the $1.50 customer wall (audit 2026-07-21:
  // internal accounts were 81% of aborts).
  const isInternalRun = orgIsInternal || Boolean(
    userId && (process.env.AGENT_INTERNAL_USER_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean).includes(userId),
  );

  // ── Per-run token accounting ──────────────────────────────────────────────
  // Tracks every token category across all steps so we can log cost per step
  // and store an accurate total in agent_runs at the end.
  const runTokens = {
    inputTokens:       0,
    outputTokens:      0,
    cacheReadTokens:   0,
    cacheWriteTokens:  0,
    get total()        { return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheWriteTokens; },
    // Cap comparisons use this, not .total: cacheRead bills at ~10% of a
    // fresh token, and counting it fully killed well-cached runs at ~30% of
    // the cost cap (CardPro fix run 2026-08-16: aborted at 709K raw of which
    // ~400K was cacheRead, ~$1 actual spend against the $1.50 cap).
    get billableTotal() { return this.inputTokens + this.outputTokens + this.cacheWriteTokens + Math.round(this.cacheReadTokens * 0.1); },
  };

  // Per-model pricing per 1M tokens. Keyed on the ACTUAL serving model, not
  // the requested one   mid-run provider fallback (Anthropic circuit open →
  // zai/gemini) used to price every step at the requested model's Claude
  // rates, which is how the internal cost log drifted to 53% of the real
  // provider invoices (production audit 2026-07-21).
  function priceFor(mid: string): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    return mid.includes('claude')
      ? { input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  }  // Claude Sonnet 5
      : mid.includes('gemini-3.1-pro-preview')
      ? { input: 1.25,   output: 10.00,  cacheRead: 0.31,  cacheWrite: 0.00  }  // Gemini 3.1 Pro (thinking)
      : mid.includes('gemini-2.5-pro')
      ? { input: 1.25,   output: 10.00,  cacheRead: 0.31,  cacheWrite: 0.00  }  // Gemini 2.5 Pro
      : mid.includes('gemini')
      // "gemini-flash-latest" is a Google-managed alias   it silently moved
      // 2.5 Flash -> 3.5 Flash -> 3.6 Flash (2026-07-21) while this price
      // stayed frozen at the original 2.5 Flash rate, a ~20x undercount on
      // every narration call and 'micro'-tier run. Verified current rate.
      ? { input: 1.50,   output: 7.50,   cacheRead: 0.375,   cacheWrite: 0.00 } // Gemini Flash (latest, currently 3.6)
      : mid.includes('deepseek')
      ? { input: 0.27,   output: 1.10,   cacheRead: 0.07,  cacheWrite: 0.00  }  // DeepSeek Chat
      : mid.toLowerCase().startsWith('glm')
      ? { input: 0.60,   output: 2.20,   cacheRead: 0.11,  cacheWrite: 0.00  }  // z.ai GLM-4.5
      : { input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  };  // fallback: Claude
  }
  const PRICE = priceFor(modelId);
  function calcCost(inp: number, out: number, cacheR: number, cacheW: number): number {
    return (inp * PRICE.input + out * PRICE.output + cacheR * PRICE.cacheRead + cacheW * PRICE.cacheWrite) / 1_000_000;
  }
  // Run cost accumulated per step at the SERVING model's price   the only
  // number safe to compare against provider invoices on mixed-provider runs.
  let runCostUsd = 0;

  // ── Tool-failure circuit breaker ──────────────────────────────────────────
  // Keyed on toolName, tracks the last error message and how many times in a
  // row it repeated VERBATIM. A tool returning a NEW/different error each time
  // is normal iteration (e.g. fixing one syntax issue reveals another)   only
  // the exact same failure repeating is a sign the model is stuck retrying an
  // approach that structurally cannot work (it should stop and try something
  // fundamentally different, or tell the user it's blocked, instead of
  // silently repeating the same failing call). This is per-run state; it does
  // not persist across separate agent runs.
  const toolFailureStreak = new Map<string, { message: string; count: number }>();
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  // Same threshold as get_build_errors.ts's own in-call breaker (keep them
  // matched -- both exist to catch "same error N times in a row").
  const MUTATION_CIRCUIT_BREAKER_THRESHOLD = 3;
  let circuitBreakerNote = '';
  // Mutation tools whose per-(tool,path) failure streak is tracked in
  // ctx.mutationFailureStreak for agentToolSet.ts's dispatcher to hard-block
  // on -- see that gate's comment for the full rationale.
  const MUTATION_TOOLS = new Set([
    'write_file', 'edit_file', 'delete_file', 'rename_file',
    // write_edge_function/delete_edge_function: re-added 2026-08-13. A prior
    // attempt at this exact extension was made earlier the same night but
    // never actually landed in a commit (lost between edit and `git add`),
    // so the gap it was meant to close -- live evidence, project dfe41091,
    // write_edge_function retrying 10+ consecutive steps with no hard block
    // -- was still live in production. Keyed by `name` (see below), a plain
    // string arg same as path/from, no fingerprinting needed.
    'write_edge_function', 'delete_edge_function',
    // Checkpoint 1 (2026-08 orchestration hardening): same breaker, extended
    // to the 3 database-action tools. These have no simple string arg to key
    // on directly (unlike path/from/name) -- see deriveDbMutationKey below.
    'query_database', 'confirm_database_change', 'provision_database',
  ]);
  const DB_MUTATION_TOOLS = new Set(['query_database', 'confirm_database_change', 'provision_database']);
  const EDGE_FN_MUTATION_TOOLS = new Set(['write_edge_function', 'delete_edge_function']);

  // ── Stuck-analysis detector ─────────────────────────────────────────────
  // The identical-error circuit breaker above only fires when a TOOL returns
  // the exact same error string repeatedly. It does NOT catch a different,
  // equally real failure mode: the model re-reading/re-diagnosing the same
  // problem in DIFFERENT words each time (read_file, get_build_errors, think  
  // "let me check X... I see Y... let me try Z...") without ever committing to
  // a write_file/edit_file that actually lands. No tool is erroring, so the
  // error-based breaker never trips, but the run is just as stuck   burning a
  // full step/token budget in circles. Track steps since the last SUCCESSFUL
  // write/edit; once it crosses a threshold, force a "stop analyzing, commit
  // to an action or say you're stuck" directive, same delivery mechanism as
  // circuitBreakerNote.
  let stepsSinceLastWrite = 0;
  // Write attempts that a guard or the tool itself rejected (BLOCKED / PREFER
  // EDIT / ERROR results on state-modifying tools). Fed into the stuck-abort
  // reason so the user learns the run DID try to change files and what stopped
  // it, instead of being asked for "a more specific instruction".
  const rejectedWriteAttempts: string[] = [];
  // History: 6 -> 4 (2026-07-15) -> 3 (2026-07-20 AM), reverted 3 -> 6 (2026-07-20 PM).
  // The 3-step version was tuned against a leftover-nudge-count bug (fixed same
  // day by resetting stuckAnalysisFireCount on every successful write) and, once
  // that fix landed, started killing completely legitimate multi-file
  // investigation instead: confirmed live on a real run that spent 6 steps on
  // think/read_files/read_file/read_file/get_build_errors/read_file -- normal
  // "understand the codebase before editing" behavior on anything non-trivial,
  // not a stuck loop -- and got hard-stopped after costing only $0.19, nowhere
  // near runaway spend. The token-budget-critical fast path below (>65% of the
  // tier'''s token cap with no write) is the real safety net for genuinely
  // expensive stuck runs; this threshold only needs to catch a run that NEVER
  // converges, so it can afford real investigation room.
  const STUCK_ANALYSIS_THRESHOLD = 6;
  // Lighter, earlier nudge than the full stuck-analysis detector below: fires
  // the moment the model calls `think` twice in a row with no other tool in
  // between (re-reasoning about the same thing instead of acting), instead of
  // waiting for 6 unproductive steps to accumulate. Directly addresses "why
  // is it thinking so much"   most of that is redundant re-analysis the model
  // could skip by either acting on what it already figured out, or persisting
  // the key fact via save_memory so it doesn't re-derive it next step.
  let consecutiveThinkOnlySteps = 0;
  let thinkStreakNoteFiredAt = -1;
  // Content-based supplement to the step-count-only detector below (Phase 2
  // of the enhancement checklist's "add a content-based signal instead of
  // re-tuning the same threshold again"). Purely additive: STUCK_ANALYSIS_THRESHOLD
  // and the incident history above are untouched, so the documented "6 steps
  // of genuinely different reasoning is legitimate investigation" case is
  // unaffected. This only ever SHORTENS the path to hard-stop, and only when
  // three consecutive `think` calls restate near-identical reasoning   which
  // is never legitimate (real multi-file investigation always produces
  // different reasoning text per step, since it's looking at different code).
  let lastThinkThought: string | null = null;
  let consecutiveSimilarThinkSteps = 0;
  // Phantom-action narration: build-mode steps with ZERO tool calls whose
  // text claims completed work ("I've created the page", "changes have been
  // saved"). Confirmed live 2026-08-10 (user transcript: an entire run of
  // past-tense completion claims + apologies, no tools; CardPro step 13
  // "tools: none" same signature). One legit closing summary is fine; a
  // streak of claims with no tools is always a lying run.
  let consecutivePhantomClaimSteps = 0;
  let stuckAnalysisNoteFiredAt = -1; // step number of last firing, so it can re-fire later in a long run
  // A soft nudge alone isn't enough   a real incident (2026-07-12) showed the
  // model ignore it 3 times in a row (fired at steps 6, 12, 18) and burn the
  // entire token cap on nothing but `think` calls. After the nudge has fired
  // and been ignored twice (i.e. firing a 3rd time), stop nudging and abort
  // the run cleanly instead of letting it grind to the hard cap regardless.
  let stuckAnalysisFireCount = 0;
  // History: 3 -> 2 (2026-07-20 AM), reverted 2 -> 3 (2026-07-20 PM) alongside
  // STUCK_ANALYSIS_THRESHOLD -- see that constant's comment. One ignored nudge
  // is not enough signal to abort a run that may just be doing legitimate deep
  // investigation; require two ignored nudges before giving up on it.
  const STUCK_ANALYSIS_HARD_STOP_FIRINGS = 3;
  let stuckAnalysisAbortReason: string | null = null;
  // Live signal for "did this run actually change anything"   filesToWrite/
  // filesEdited below are only populated from XML tags in the model's FINAL
  // text, which is empty on an aborted run even if native write_file/edit_file
  // tool calls already succeeded earlier in the same run. Track that directly.
  let anySuccessfulWriteThisRun = false;

  // Set when onStepFinish aborts the run for hitting the token/cost cap   lets
  // the summary-building code downstream tell the difference between "the
  // model produced nothing" (safety block / provider failure, already has its
  // own error message) and "budget ran out mid-task" (previously silent: the
  // run just ended with an empty summary and the frontend fell through to a
  // generic "didn't respond, try rephrasing" message that has nothing to do
  // with what actually happened).
  let budgetAbortReason: string | null = null;

  // Collected operation log
  const filesToWrite: Array<{ path: string; content: string }> = [];
  const filesToDelete: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  const dependencies: string[] = [];
  const filesEdited: string[] = [];
  let summary = '';

  // Per-run change journal   created early so tools can record into it from the first step
  const runLedger = new RunStateLedger();

  // Build AgentContext
  const ctx: AgentContext = {
    appPath,
    projectId,
    userId,
    runId: agentLockToken,
    chatMode: chatMode === 'admin' ? 'admin' : 'normal',
    readFiles: new Set<string>(),
    pendingPreviewFiles: new Map<string, string>(),
    mutationFailureStreak: new Map<string, { message: string; count: number }>(),
    buildErrorCallCount: 0,
    dbQueryCallCount: 0,
    pendingDbChanges: new Map(),
    pendingEdgeFunctionDeploys: new Map(),
    anonFetchTables: new Map(),
    anonPolicyTables: new Set(),
    attachmentPublicUrls: new Map<string, string>(),
    previewServiceUrl: process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001',
    ledger: runLedger,
    ecgMcp: (() => {
      const url = projectSecrets?.find(s => s.key_name === 'ECG_MCP_URL')?.key_value;
      const token = projectSecrets?.find(s => s.key_name === 'ECG_MCP_TOKEN')?.key_value;
      return url ? { url, token } : undefined;
    })(),
    // reverseGraph is injected below after the import graph is built
    onXmlComplete: (xml: string) => {
      // Parse completed XML tags and record operations
      parseXmlOperation(xml, { filesToWrite, filesEdited, filesToDelete, renames, dependencies });
      // Stream the XML to the frontend
      sink.emit('tool-output', { xml });
    },
    getDeclaredDependencies: () => [...dependencies],
  };

  // ── Snapshot disk state BEFORE agent writes ─────────────────────────────────
  // preAgentDiskSnapshot is used for: (a) file context assembly, (b) surgical revert
  // during validation, (c) full rollback on catastrophic failure.
  //
  // Tier-gated loading: micro only snapshots the target file (zero wasted I/O);
  // all other tiers read the full project as before.
  const SNAP_SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
  const preAgentDiskSnapshot = new Map<string, string>();
  const promptLower = prompt.toLowerCase();

  // Binary assets (uploaded images/fonts/etc, see place_asset.ts) are always
  // captured in full regardless of tier, with binary-safe encoding
  // (readFileForSync). Neither tier's text-file scan below covers this on its
  // own: micro's targeted scan never leaves src/, and even the full-tier scan
  // used to read every file as utf8 with no binary handling at all. Both gaps
  // meant a revert/restore/salvage fullSync push built from this snapshot
  // silently deleted (micro: absent from the push, pruned by the receiving
  // preview-service) or corrupted (full-tier: utf8-mangled bytes) every
  // uploaded image the next time an agent turn hit that path -- confirmed
  // 2026-08-09 as the cause of "my logo disappears when I deploy".
  const collectBinaryAssets = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
      logger.debug('collectBinaryAssets: readdirSync failed (non-fatal, skipping dir)', { dir, error: dirErr?.message });
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { collectBinaryAssets(fullPath); continue; }
      if (!BINARY_EXTS_SET.has(path.extname(entry.name).toLowerCase())) continue;
      const relPath = path.relative(appPath, fullPath);
      try { preAgentDiskSnapshot.set(relPath, readFileForSync(fullPath)); } catch (readErr: any) {
        logger.debug('collectBinaryAssets: failed to read binary asset (non-fatal)', { relPath, error: readErr?.message });
      }
    }
  };
  try {
    collectBinaryAssets(appPath);
    logger.debug('_runAgentLoopInner: binary asset pre-scan complete', { projectId, binaryAssetsFound: preAgentDiskSnapshot.size });
  } catch (binScanErr: any) {
    logger.debug('_runAgentLoopInner: binary asset pre-scan failed (non-fatal)', { projectId, error: binScanErr?.message });
  }

  if (_tier === 'micro') {
    // ── MICRO FAST PATH ──────────────────────────────────────────────────────
    // A color/text/spacing change touches exactly one file. Find it with a
    // targeted scan   no full disk read, no import graph, no KB query.
    logger.debug('_runAgentLoopInner: micro-tier fast path, targeted file scan', { projectId });
    const promptWords = promptLower.split(/[\s,./'"!?()[\]{}]+/).filter(w => w.length > 2);
    const findMentioned = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
        logger.debug('findMentioned: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { findMentioned(fullPath); continue; }
        if (BINARY_EXTS_SET.has(path.extname(entry.name).toLowerCase())) continue; // already collected above
        const relPath = path.relative(appPath, fullPath);
        const fname = entry.name.toLowerCase().replace(/\.(tsx?|jsx?|css)$/, '');
        if (fname && promptWords.some(w => fname.includes(w) || w.includes(fname))) {
          try { preAgentDiskSnapshot.set(relPath, readFileForSync(fullPath)); } catch (readErr: any) {
            logger.debug('findMentioned: failed to read matched file (non-fatal)', { relPath, error: readErr?.message });
          }
        }
      }
    };
    try { findMentioned(path.join(appPath, 'src')); } catch (findErr: any) {
      logger.debug('_runAgentLoopInner: micro-tier findMentioned scan failed (non-fatal)', { projectId, error: findErr?.message });
    }
    // If nothing matched by name, grab App.tsx as fallback orientation
    if (preAgentDiskSnapshot.size === 0) {
      logger.debug('_runAgentLoopInner: micro-tier scan matched nothing, falling back to App.tsx', { projectId });
      const appTsx = path.join(appPath, 'src', 'App.tsx');
      try {
        const rel = path.relative(appPath, appTsx);
        preAgentDiskSnapshot.set(rel, readFileForSync(appTsx));
      } catch (fallbackErr: any) {
        logger.debug('_runAgentLoopInner: micro-tier App.tsx fallback read failed (non-fatal)', { projectId, error: fallbackErr?.message });
      }
    }
    logger.debug('_runAgentLoopInner: micro-tier snapshot complete', { projectId, snapshotFileCount: preAgentDiskSnapshot.size });
  } else {
    // ── FULL DISK SNAPSHOT (fix / edit / feature / build) ────────────────────
    logger.debug('_runAgentLoopInner: full-tier disk snapshot starting', { projectId, tier: _tier ?? 'unset' });
    const snapDisk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
        logger.debug('snapDisk: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SNAP_SKIP_FILES.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { snapDisk(fullPath); }
        else {
          if (BINARY_EXTS_SET.has(path.extname(entry.name).toLowerCase())) continue; // already collected above
          const relPath = path.relative(appPath, fullPath);
          try { preAgentDiskSnapshot.set(relPath, readFileForSync(fullPath)); } catch (readErr: any) {
            logger.debug('snapDisk: failed to read file into snapshot (non-fatal)', { relPath, error: readErr?.message });
          }
        }
      }
    };
    try {
      snapDisk(appPath);
      logger.debug('_runAgentLoopInner: full-tier disk snapshot complete', { projectId, snapshotFileCount: preAgentDiskSnapshot.size });
    } catch (snapErr: any) {
      logger.debug('_runAgentLoopInner: full-tier disk snapshot failed (non-fatal)', { projectId, error: snapErr?.message });
    }
  }

  // Unified file source: prefer frontend-sent existingFiles, fall back to disk snapshot.
  const fileSources: Array<{ path: string; content: string }> =
    (existingFiles && existingFiles.length > 0)
      ? existingFiles
      : Array.from(preAgentDiskSnapshot.entries()).map(([p, c]) => ({ path: p, content: c }));

  // KB batch index   runs once per project per server boot in the background.
  // Skip for micro (snapshot is partial) and fix (no benefit for error diagnosis).
  if (_tier !== 'micro' && _tier !== 'fix' && projectId && !kbBatchIndexedProjects.has(projectId) && fileSources.length > 0) {
    kbBatchIndexedProjects.add(projectId);
    logger.debug('_runAgentLoopInner: kicking off background KB batch index for project', { projectId, fileCount: fileSources.length });
    indexFiles(projectId, fileSources).catch((kbIndexErr: any) => {
      logger.debug('_runAgentLoopInner: background KB batch index failed (non-fatal)', { projectId, error: kbIndexErr?.message });
    });
  }

  // Build a lightweight import graph   skip for micro (single file, no cross-file analysis needed).
  const importGraph = new Map<string, Set<string>>();
  const reverseGraph = new Map<string, Set<string>>(); // importers of each file
  if (_tier !== 'micro') {
    for (const f of fileSources) {
      if (!/\.(tsx?|jsx?)$/.test(f.path)) continue;
      const imports = new Set<string>();
      const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
      let m: RegExpExecArray | null;
      while ((m = importRegex.exec(f.content)) !== null) {
        const raw = m[1] || m[2];
        if (!raw || raw.startsWith('react') || raw.startsWith('@radix') || raw.startsWith('class-variance') || raw.startsWith('clsx') || raw.startsWith('tailwind') || raw.startsWith('lucide')) continue;
        const resolved = raw.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(f.path), raw)).replace(/^\.\//, '')
          : raw.startsWith('@/') ? raw.replace('@/', 'src/') : null;
        if (resolved) {
          for (const candidate of fileSources) {
            const base = candidate.path.replace(/\.(tsx?|jsx?)$/, '');
            if (resolved === candidate.path || resolved === base || resolved + '/index' === base) {
              imports.add(candidate.path);
              if (!reverseGraph.has(candidate.path)) reverseGraph.set(candidate.path, new Set());
              reverseGraph.get(candidate.path)!.add(f.path);
            }
          }
        }
      }
      importGraph.set(f.path, imports);
    }
    logger.debug('_runAgentLoopInner: import graph built', { projectId, nodeCount: importGraph.size });
  }

  // Wire reverseGraph into ctx so tools can emit dependency warnings
  ctx.reverseGraph = reverseGraph;

  // Find directly mentioned files
  const directlyMentioned = new Set<string>();
  for (const f of fileSources) {
    const fname = f.path.toLowerCase().split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '') ?? '';
    if (fname && promptLower.includes(fname)) directlyMentioned.add(f.path);
  }

  // Expand to imports/importers of mentioned files (1 hop)   skip for micro
  const relatedByImport = new Set<string>();
  const importersOfMentioned = new Set<string>();
  if (_tier !== 'micro') {
    for (const mentionedPath of directlyMentioned) {
      for (const imp of importGraph.get(mentionedPath) ?? []) relatedByImport.add(imp);
      for (const importer of reverseGraph.get(mentionedPath) ?? []) relatedByImport.add(importer);
    }
    for (const mentionedPath of directlyMentioned) {
      for (const importer of reverseGraph.get(mentionedPath) ?? []) importersOfMentioned.add(importer);
    }
  }

  // Always-include critical files
  const criticalFiles = new Set(['src/App.tsx', 'src/index.css', 'src/lib/utils.ts', 'package.json']);

  // Detect if this is the first build on an empty/new project. Moved up from
  // its original spot further below so the semantic-cache lookup can be
  // kicked off here, concurrently with KB retrieval, instead of after it --
  // see the "start the promise now, await it later" note by
  // semanticCachePromise below.
  // Use fileSources (full relative paths like src/pages/Home.tsx) NOT liveFileTree
  // the tree is indent-formatted so full paths like "src/pages/Home.tsx" never appear in it.
  const hasUserFiles = fileSources.some(f =>
    /^src\/pages\//.test(f.path) ||
    (/^src\/components\//.test(f.path) && !/^src\/components\/ui\//.test(f.path)) ||
    (/^src\/views\//.test(f.path)) ||
    (/^src\/screens\//.test(f.path))
  ) || fileSources.filter(f =>
    /^src\/.*\.(tsx|jsx)$/.test(f.path) && !/^src\/components\/ui\//.test(f.path)
  ).length > 3;
  const isEmptyProject = !hasUserFiles;
  const isFirstMessage = !history || history.length === 0;

  // Semantic cache lookup (agentSemanticCache.ts) -- started here, awaited
  // much further below where its result is actually used (semanticCacheHintBlock).
  // This and KB retrieval right below are two independent network calls that
  // both sit on the critical path before the model's first visible token;
  // starting this one now instead of after KB retrieval finishes lets them
  // run concurrently -- up to ~2.5s off the worst case for a fresh-project
  // first-build prompt (previously up to 2000ms KB + 2500ms cache = 4500ms
  // serial; now max(2000, 2500) = 2500ms).
  const semanticCachePromise: Promise<{ hit: boolean; cachedSnapshot?: Record<string, string>; similarity?: number }> =
    (isEmptyProject && isFirstMessage && runtimeMode === 'build')
      ? Promise.race([
          checkSemanticCache(prompt, 'react'),
          new Promise<{ hit: false }>((resolve) => setTimeout(() => resolve({ hit: false }), 2500)),
        ])
      : Promise.resolve({ hit: false });

  // KB retrieval   rank the initial working set by relevance to the prompt.
  // Only 'micro' is excluded (8-step trivial tweaks on a partial snapshot).
  // fix/edit are INCLUDED: the production provider is BM25 (pure in-memory   no
  // embedding key is set, see detectProvider), so retrieval returns in tens of
  // ms, not the "2s latency" an earlier comment used to justify skipping fix.
  // Skipping the two most common tiers meant most runs got path-heuristic
  // ordering only; BM25 keyword matching on the prompt (component/function
  // names the user actually typed) is a real improvement there for free.
  // The timeout is provider-aware: BM25 is instant, but a future embeddings
  // switch (google/openai) does a real embed+DB round-trip that 2s would cut
  // off mid-flight, so the DB path gets a realistic budget.
  const kbScores = new Map<string, number>(); // path -> bonus points added to the heuristic sort
  if (_tier !== 'micro' && projectId) {
    const kbProvider = getProvider();
    const kbTimeoutMs = kbProvider === 'bm25' ? 1500 : 6000;
    logger.debug('_runAgentLoopInner: retrieving relevant files from KB', {
      projectId, tier: _tier, kbProvider, kbTimeoutMs, mentionedPathCount: directlyMentioned.size,
    });
    try {
      const kbResults = await Promise.race([
        retrieveRelevantFiles(projectId, prompt, fileSources, {
          maxFiles: 10,
          graphExpansion: false, // imports/dependents are already scored separately below
          mentionedPaths: [...directlyMentioned],
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('kb timeout')), kbTimeoutMs)),
      ]);
      // Multiply by 80 so a strong KB hit (score 0.8) = 64 pts   enough to beat the
      // criticalFiles baseline (60) and actually influence file selection.
      for (const r of kbResults) kbScores.set(r.path, Math.round(r.score * 80));
      logger.debug('_runAgentLoopInner: KB retrieval complete', { projectId, tier: _tier, resultCount: kbResults.length });
    } catch (kbErr: any) {
      // Non-fatal   heuristic sort still works without KB. info, not debug: a
      // retrieval that keeps timing out is a real signal worth seeing now that
      // log levels are honored (bootstrap-env fix), not something to hide.
      logger.info('_runAgentLoopInner: KB retrieval failed or timed out (non-fatal, using heuristic sort)', {
        projectId, tier: _tier, error: kbErr?.message,
      });
    }
  }

  const sortedFiles = fileSources.slice().sort((a, b) => {
    const aScore = directlyMentioned.has(a.path) ? 100
      : relatedByImport.has(a.path) ? 80
      : importersOfMentioned.has(a.path) ? 70
      : criticalFiles.has(a.path) ? 60
      : a.path.startsWith('src/pages/') ? 40
      : a.path.startsWith('src/components/') && !a.path.includes('/ui/') ? 30
      : 0;
    const bScore = directlyMentioned.has(b.path) ? 100
      : relatedByImport.has(b.path) ? 80
      : importersOfMentioned.has(b.path) ? 70
      : criticalFiles.has(b.path) ? 60
      : b.path.startsWith('src/pages/') ? 40
      : b.path.startsWith('src/components/') && !b.path.includes('/ui/') ? 30
      : 0;
    const aFinal = aScore + (kbScores.get(a.path) ?? 0);
    const bFinal = bScore + (kbScores.get(b.path) ?? 0);
    if (aFinal !== bFinal) return bFinal - aFinal;
    return a.content.length - b.content.length;
  });

  // GitHub Copilot-style context selection: small focused working set   agent uses
  // read_file/list_files tools to pull anything else it needs.
  const MAX_CONTEXT_CHARS = parseInt(process.env.AI_MAX_CONTEXT_CHARS || '8000', 10);
  const MAX_CONTEXT_FILES = parseInt(process.env.AI_MAX_CONTEXT_FILES || '4', 10);
  const MAX_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_FILE_CONTEXT_CHARS || '800', 10);
  const MAX_MENTIONED_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_MENTIONED_FILE_CONTEXT_CHARS || '3000', 10);

  const cappedFiles: Array<{
    path: string;
    content: string;
    contextContent: string;
    truncated: boolean;
  }> = [];
  let totalChars = 0;

  for (const file of sortedFiles) {
    if (cappedFiles.length >= MAX_CONTEXT_FILES) break;

    const perFileCap = directlyMentioned.has(file.path)
      ? MAX_MENTIONED_FILE_CONTEXT_CHARS
      : MAX_FILE_CONTEXT_CHARS;
    const truncated = file.content.length > perFileCap;
    const contextContent = truncated
      ? `${file.content.slice(0, perFileCap)}\n\n/* peek only   call read_file("${file.path}") before editing */`
      : file.content;
    const entryChars = contextContent.length + file.path.length + 10;

    if (totalChars + entryChars > MAX_CONTEXT_CHARS) {
      continue;
    }

    cappedFiles.push({
      path: file.path,
      content: file.content,
      contextContent,
      truncated,
    });
    totalChars += entryChars;
  }

  if (cappedFiles.length === 0 && sortedFiles.length > 0) {
    const file = sortedFiles[0];
    const perFileCap = directlyMentioned.has(file.path)
      ? MAX_MENTIONED_FILE_CONTEXT_CHARS
      : MAX_FILE_CONTEXT_CHARS;
    const truncated = file.content.length > perFileCap;
    cappedFiles.push({
      path: file.path,
      content: file.content,
      contextContent: truncated
        ? `${file.content.slice(0, perFileCap)}\n\n/* peek only   call read_file("${file.path}") before editing */`
        : file.content,
      truncated,
    });
  }

  logger.debug('_runAgentLoopInner: context file selection complete', {
    projectId, sortedFileCount: sortedFiles.length, cappedFileCount: cappedFiles.length,
    totalContextChars: totalChars, MAX_CONTEXT_CHARS, MAX_CONTEXT_FILES,
  });

  const existingFilesContext = cappedFiles
    .map((f) => `=== ${f.path} ===\n${f.contextContent}`)
    .join('\n\n');

  // Pre-mark non-truncated context files as already read   full content is in prompt.
  for (const f of cappedFiles) {
    if (!f.truncated && ctx.readFiles) ctx.readFiles.add(f.path);
  }

  // Build excluded/truncated file notes so agent knows to read_file before importing.
  const cappedPaths = new Set(cappedFiles.map(f => f.path));
  const excludedFileEntries = fileSources.filter(f => !cappedPaths.has(f.path));
  const excludedFiles = excludedFileEntries.map(f => f.path);
  const truncatedFiles = cappedFiles
    .filter(f => f.truncated)
    .map(f => f.path);

  // Signature-only preview for excluded files: symbol names + kind, no bodies.
  // Cheap (regex, already-in-memory content, no DB round-trip) and gives the
  // model enough to judge relevance without loading full text it may not need  
  // it still MUST call read_file before importing/editing, per the warning below.
  const MAX_SIGNATURE_FILES = 40;
  const signatureLines: string[] = [];
  for (const f of excludedFileEntries.slice(0, MAX_SIGNATURE_FILES)) {
    if (!/\.(tsx?|jsx?)$/.test(f.path)) { signatureLines.push(f.path); continue; }
    try {
      const symbols = extractSymbols(f.content);
      if (symbols.length === 0) { signatureLines.push(f.path); continue; }
      const sig = symbols.map(s => `${s.name}:${s.kind}`).join(', ');
      signatureLines.push(`${f.path}   ${sig}`);
    } catch (symErr: any) {
      logger.debug('_runAgentLoopInner: extractSymbols failed for excluded file (non-fatal)', { path: f.path, error: symErr?.message });
      signatureLines.push(f.path);
    }
  }
  const remainingCount = excludedFiles.length - signatureLines.length;

  const excludedFilesNote = excludedFiles.length > 0
    ? `\n\n**WARNING: ${excludedFiles.length} file(s) exist in the project but their FULL contents are NOT shown above   only symbol signatures.** ` +
      `If you need to import from or edit any of these files, call \`read_file\` FIRST to see their actual content. ` +
      `NEVER guess implementation details of a file you haven't read   the signatures below only tell you WHAT exists, not HOW it works.\n` +
      `Files not in context (path   exported symbols:kind):\n${signatureLines.join('\n')}` +
      (remainingCount > 0 ? `\n(and ${remainingCount} more file(s) not shown)` : '')
    : '';
  const truncatedFilesNote = truncatedFiles.length > 0
    ? `\n\n**NOTE: ${truncatedFiles.length} file(s) are only partially shown above to save tokens.** ` +
      `Before editing beyond the visible preview, call \`read_file\` to fetch the exact current content.\n` +
      `Truncated files: ${truncatedFiles.slice(0, 20).join(', ')}${truncatedFiles.length > 20 ? ` (and ${truncatedFiles.length - 20} more)` : ''}`
    : '';

  // Always build a live file tree from disk   cheap and always accurate.
  // This is the agent's authoritative source for "what files exist right now."
  const liveFileTree = getProjectFileTree(appPath);

  // Build attachment context for the AI prompt.
  // Files live on disk in /tmp   read directly. No HTTP round-trip needed.
  // Text-based docs are inlined so the model can read them.
  // Images stay in /tmp until the agent explicitly calls place_asset to embed them.
  // This prevents any image from silently overwriting project assets before the agent
  // understands the user's intent.
  let attachmentContext = '';
  if (attachments && attachments.length > 0) {
    logger.debug('_runAgentLoopInner: processing attachments', { projectId, attachmentCount: attachments.length, visionCapable });
    const TEXT_TYPES = new Set([
      'text/plain', 'text/csv', 'text/markdown',
      'application/json',
    ]);

    const parts: string[] = [];
    for (const att of attachments) {
      // Validate tempPath is inside the chat-upload directory specifically --
      // not merely somewhere under /tmp. The old check accepted any path with
      // an os.tmpdir() prefix, so a caller could name another project's
      // upload (or a sibling path like /tmpfoo, which also passes a bare
      // prefix test) and have its contents read into this run's prompt and,
      // for documents, copied into the generated app. /agent-stream is
      // optionalAuthMiddleware, so that reachable without an account. This
      // matches the stricter check place_asset.ts already applies to the same
      // class of path, including the trailing separator that makes the prefix
      // test a real directory-containment test.
      const uploadRoot = path.resolve(path.join(os.tmpdir(), 'ecomgear-chat-uploads')) + path.sep;
      let resolvedPath = path.resolve(att.tempPath);
      let tempPathValid = resolvedPath.startsWith(uploadRoot) && fs.existsSync(resolvedPath);

      // Self-heal from the durable Supabase Storage copy (publicUrl) if the
      // ephemeral /tmp file (cleaned up after 1 hour) is already gone. Writes
      // to a FRESH path under the same trusted UPLOAD_BASE directory, so
      // everything downstream (vision analysis, the place_asset instruction
      // text below, place_asset's own tmpPath validation) just sees a valid
      // path with zero protocol change -- the model never needs to know a
      // fallback happened.
      if (!tempPathValid && att.publicUrl) {
        try {
          const uploadBase = path.join(os.tmpdir(), 'ecomgear-chat-uploads');
          await fs.promises.mkdir(uploadBase, { recursive: true });
          const safeRefetchName = `refetched-${Date.now()}-${att.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const refetchPath = path.join(uploadBase, safeRefetchName);
          const resp = await fetch(att.publicUrl, { signal: AbortSignal.timeout(15_000) });
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            await fs.promises.writeFile(refetchPath, buf);
            resolvedPath = refetchPath;
            tempPathValid = true;
            logger.info('[AgentLoop] Re-materialized expired attachment from durable storage', {
              projectId, attachmentName: att.name, bytes: buf.length,
            });
          }
        } catch (refetchErr: any) {
          logger.warn('[AgentLoop] Failed to re-materialize expired attachment from publicUrl', {
            projectId, attachmentName: att.name, error: refetchErr?.message, stack: refetchErr?.stack,
          });
        }
      }

      if (!tempPathValid) {
        logger.debug('_runAgentLoopInner: attachment unavailable, telling model to skip it', { projectId, attachmentName: att.name });
        // The section preamble below tells the model it MUST act on attached
        // files. Pairing that hard obligation with a file it cannot open is
        // how a run ends up inventing a plausible-looking asset URL instead
        // of stopping -- so the escape hatch has to sit right next to the
        // failure, where it outranks the general instruction.
        parts.push(
          `- **${att.name}**   NOT AVAILABLE (upload expired or inaccessible). ` +
          `Do NOT invent, guess, or substitute a URL or placeholder for this file, and do not reference it in code. ` +
          `Complete the rest of the request without it and tell the user this file needs re-attaching.`
        );
        continue;
      }

      if (att.category === 'image') {
        try {
          const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');

          // Read bytes upfront   needed for both vision analysis and preview push
          let imgBytes: Buffer | null = null;
          try { imgBytes = await fs.promises.readFile(resolvedPath); } catch (imgReadErr: any) {
            logger.debug('_runAgentLoopInner: failed to read attachment image bytes (non-fatal)', {
              projectId, attachmentName: att.name, resolvedPath, error: imgReadErr?.message,
            });
          }

          // ── Vision analysis   ALWAYS run for vision-capable models ──────────────────
          // The LLM must see the image to understand what it is:
          //   • A bug/UI screenshot shared to explain a problem
          //   • A diagram or annotated explanation
          //   • A logo / asset the user wants placed in the project
          // Never skip vision for filename heuristics alone   a file named
          // "screenshot_logo.png" might actually be a brand asset.
          let inlineAnalysis: string | null = null;
          let isRefScreenshot = false;

          if (visionCapable && imgBytes) {
            // Always hit the model   let it classify the image
            logger.debug('_runAgentLoopInner: calling vision analysis for attachment', {
              projectId, attachmentName: att.name, providerName, modelId, imgBytesLength: imgBytes.length,
            });
            inlineAnalysis = await analyzeImageWithVision(
              imgBytes.toString('base64'), att.type, att.name, aiProvider, abortSignal,
              (usage) => {
                const p = priceFor(modelId);
                runTokens.inputTokens += usage.inputTokens;
                runTokens.outputTokens += usage.outputTokens;
                runCostUsd += (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
                logger.debug('_runAgentLoopInner: vision analysis token usage', {
                  projectId, attachmentName: att.name, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                  runCostUsd,
                });
              },
            );
            logger.debug('_runAgentLoopInner: vision analysis complete', {
              projectId, attachmentName: att.name, analysisPreview: inlineAnalysis?.slice(0, 200), analysisLength: inlineAnalysis?.length ?? 0,
            });
            // The user's own explicit words ("use this as my logo") win over an
            // ambiguous vision read   vision classifies what the image IS, not
            // what the user wants done with it.
            isRefScreenshot = isReferenceScreenshot(inlineAnalysis) && !hasEmbedIntent(prompt);
          } else if (!visionCapable) {
            // No vision   fall back to filename heuristic + prompt intent
            if (isScreenshotFilename(att.name) || !hasEmbedIntent(prompt)) {
              isRefScreenshot = true;
              inlineAnalysis = 'No vision model available   treated as reference context based on filename/prompt.';
            }
          }

          // Always queue image bytes for inline delivery to the model in the main loop,
          // regardless of classification. For screenshots, the model needs to SEE the
          // bug/explanation. For assets, it needs to see what it's placing.
          if (imgBytes) {
            imageVisionData.push({
              name: att.name,
              type: att.type,
              base64: imgBytes.toString('base64'),
              safeName,
              _preAnalysis: inlineAnalysis ?? undefined,
            } as any);
          }

          if (isRefScreenshot) {
            // User shared a screenshot, diagram, or wireframe as visual context   reference only.
            // Do NOT copy to public/assets/; instruct the agent to use it as context only.
            parts.push(
              `- **Visual Context**: "${att.name}"   this image has been sent to you inline so you can SEE it.\n` +
              `  Visual analysis: ${inlineAnalysis ?? 'see image inline'}\n` +
              `  **Classification: reference context only.** Use it to understand the bug, UI state, layout intention, or explanation the user is describing. If this is a diagram or wireframe, use it to understand WHAT to build   do not embed the diagram itself in the project.\n` +
              `  **Do NOT call place_asset or embed this image in any project file.**`,
            );
          } else {
            // ── Image stays in /tmp   agent uses place_asset tool to explicitly place it ──
            // This prevents any image from silently overwriting project assets (e.g. logos)
            // before the agent understands the user's intent.

            // Register this exact tempPath -> publicUrl so place_asset can self-heal if the
            // /tmp file goes missing between now (prompt built) and whenever the model
            // actually calls the tool -- see attachmentPublicUrls's doc comment in types.ts.
            if (att.publicUrl) {
              ctx.attachmentPublicUrls!.set(resolvedPath, att.publicUrl);
            }

            // Scan existing public/assets/ for image files so the agent knows what's there
            // and can delete old logos/assets before placing the new one.
            let existingAssetsList = '';
            try {
              const assetsDir2 = path.join(appPath, 'public', 'assets');
              if (fs.existsSync(assetsDir2)) {
                const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
                const existing = fs.readdirSync(assetsDir2)
                  .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
                  .map(f => `public/assets/${f}`);
                if (existing.length > 0) existingAssetsList = existing.join(', ');
              }
            } catch (assetsScanErr: any) {
              logger.debug('_runAgentLoopInner: failed to scan existing public/assets (non-fatal)', {
                projectId, error: assetsScanErr?.message,
              });
            }

            // NOTE: imageVisionData.push already done unconditionally above this if/else block

            const visualDesc = inlineAnalysis
              ? `\n  Visual analysis: ${inlineAnalysis}`
              : '';

            const oldAssetsNote = existingAssetsList
              ? `\n  Existing image assets: ${existingAssetsList}. If you are REPLACING one of these: place_asset the NEW file first, then call replace_asset_references(oldAssetPath, newAssetPath), THEN delete_file the old path -- it will now succeed cleanly since replace_asset_references already cleared the references delete_file would otherwise block on.`
              : '';

            parts.push(
              `- **Image**: "${att.name}"${visualDesc}\n` +
              `  Temporary path: \`${resolvedPath}\`\n` +
              `  The image has NOT been copied to the project yet. To use it as a project asset:\n` +
              `  1. Determine WHERE it should go based on the user's message AND the visual analysis above (logo, hero, background, icon, etc.)\n` +
              `  2. Call place_asset(tmpPath: "${resolvedPath}", destName: "${safeName}") to copy it to public/assets/${safeName}\n` +
              `  3. If REPLACING an existing asset: call replace_asset_references(oldAssetPath: "old/path/here", newAssetPath: "public/assets/${safeName}") to rewrite every reference (img src, CSS url(), favicon/manifest entries), THEN delete_file the old path.\n` +
              `  4. If this is a NEW asset (nothing to replace), just update the component(s) that should render it.\n` +
              `  Path rules after placing (MUST follow   preview runs at non-root base URL):\n` +
              `  • CORRECT: <img src={\`\${import.meta.env.BASE_URL}assets/${safeName}\`} />\n` +
              `  • WRONG:   <img src="/assets/${safeName}" />  (404 in preview)\n` +
              `  • WRONG:   any hardcoded http:// or localhost URL\n` +
              `  Always use import.meta.env.BASE_URL (no leading slash on the filename part).${oldAssetsNote}`
            );
          }
        } catch (copyErr: any) {
          logger.warn('_runAgentLoopInner: failed to process image attachment', {
            projectId, attachmentName: att.name, error: copyErr?.message, stack: copyErr?.stack,
          });
          parts.push(`- **Image**: "${att.name}"   failed to process: ${copyErr.message}`);
        }
      } else if (TEXT_TYPES.has(att.type)) {
        // Inline text content so the AI can read it
        try {
          let text = await fs.promises.readFile(resolvedPath, 'utf8');
          if (text.length > 30_000) text = text.slice(0, 30_000) + '\n\n… (truncated)';
          parts.push(
            `- **Document**: "${att.name}" (${att.type})\n\n\`\`\`\n${text}\n\`\`\``
          );
        } catch (readErr: any) {
          logger.warn('_runAgentLoopInner: failed to read text attachment', {
            projectId, attachmentName: att.name, error: readErr?.message,
          });
          parts.push(`- **Document**: "${att.name}"   failed to read: ${readErr.message}`);
        }
      } else {
        // Binary docs (PDF, DOCX, XLSX)   try to extract text for the AI, also copy into project
        try {
          const assetsDir = path.join(appPath, 'public', 'assets');
          await fs.promises.mkdir(assetsDir, { recursive: true });
          const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const destPath = path.join(assetsDir, safeName);
          await fs.promises.copyFile(resolvedPath, destPath);

          // Attempt text extraction for document types the AI can reason about
          if (EXTRACTABLE_DOC_TYPES.has(att.type)) {
            const extractedText = await extractDocumentText(resolvedPath, att.type);
            if (extractedText) {
              let text = extractedText;
              if (text.length > 30_000) text = text.slice(0, 30_000) + '\n\n… (truncated)';
              parts.push(
                `- **Document**: "${att.name}" (${att.type}) → copied to \`public/assets/${safeName}\`\n  Also available as downloadable file at \`\${import.meta.env.BASE_URL}assets/${safeName}\`. NEVER use \`/assets/${safeName}\` with a leading slash   the preview uses a non-root base URL.\n\n  **Extracted Text Content:**\n\n\`\`\`\n${text}\n\`\`\``
              );
            } else {
              parts.push(
                `- **Document**: "${att.name}" (${att.type}) → copied to \`public/assets/${safeName}\`\n  This file is available in the project but text extraction failed. The user may want it linked or downloadable. Reference as \`\${import.meta.env.BASE_URL}assets/${safeName}\`. Follow their instructions.`
              );
            }
          } else {
            parts.push(
              `- **Document**: "${att.name}" (${att.type}) → copied to \`public/assets/${safeName}\`\n  This file is available in the project. The user may want it linked, downloadable, or processed. Reference as \`\${import.meta.env.BASE_URL}assets/${safeName}\`. Follow their instructions.`
            );
          }
        } catch (copyErr: any) {
          parts.push(`- **Document**: "${att.name}"   failed to copy: ${copyErr.message}`);
        }
      }
    }
    attachmentContext = `\n\n# User-Attached Files\n\nThe user attached the following files with this message.\n\n**IMPORTANT   Images are NOT yet in the project.** Each image stays in a temporary path until you explicitly call \`place_asset\` to copy it to \`public/assets/\`. You MUST call \`place_asset\` before you can reference an image in any component.\n\n**YOUR OBLIGATION:** You MUST act on these files as the user instructs. Do not just acknowledge them   actually use them in the code.\n\nCommon scenarios   execute immediately:\n- "use as logo / header logo" → call place_asset to place the image, then update the Navbar/Header component to render an \`<img>\` using it. If this REPLACES an existing logo, call replace_asset_references(oldAssetPath, newAssetPath) before deleting the old file   see the numbered steps above.\n- "use as favicon" → call place_asset, then write to \`public/favicon.ico\` (or .png) and update \`index.html\` \`<link rel="icon">\`\n- "use as hero / banner" → call place_asset, then place in the hero section of the relevant page\n- "use as background" → call place_asset, then apply as CSS \`background-image\` on the specified element\n- "use this data / content" → parse the document content and populate the UI with it\n- General "use this" → infer the best placement from context and the image description\n\nAlways modify the actual component files to reference the image. An image that was never placed with \`place_asset\` cannot be referenced in code.\n\n${parts.join('\n\n')}`;
    attachmentContext = clampContextSection('Attachment context', attachmentContext, MAX_ATTACHMENT_CONTEXT_CHARS);
  }

  // ── Pre-flight vision analysis ────────────────────────────────────────────
  // BEFORE the agent loop starts, ask the model to describe each uploaded image.
  // This gives the agent a concrete textual understanding of the image content
  // ("company logo with a blue shield and white text 'EcomGear'") so it can
  // decide the correct action without guessing from the filename alone.
  // Only runs when the selected model supports vision (Claude, Gemini   not DeepSeek).
  if (visionCapable && imageVisionData.length > 0) {
    logger.debug('_runAgentLoopInner: pre-flight vision analysis pass starting', { projectId, imageCount: imageVisionData.length });
    const analysisParts: string[] = [];
    for (const img of imageVisionData) {
      // Skip images already described inline during attachment processing
      const preAnalysis = (img as any)._preAnalysis as string | undefined;
      if (preAnalysis) continue; // already injected into the parts[] entry above
      const analysis = await analyzeImageWithVision(
        img.base64, img.type, img.name, aiProvider, abortSignal,
        (usage) => {
          const p = priceFor(modelId);
          runTokens.inputTokens += usage.inputTokens;
          runTokens.outputTokens += usage.outputTokens;
          runCostUsd += (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
        },
      );
      analysisParts.push(`- **${img.name}**: ${analysis}`);
    }
    if (analysisParts.length > 0) {
      attachmentContext +=
        `\n\n## Visual Analysis of Attached Images\n\n` +
        `The following descriptions were obtained by visually analysing each image BEFORE you start making changes. ` +
        `Read them carefully to understand what each image actually is:\n\n` +
        analysisParts.join('\n') +
        `\n\nUse the visual analysis above to understand each image, then execute the user's request. If the user says "use this as logo" and the analysis confirms it looks like a logo, immediately call place_asset then edit the relevant component to render it.`;
    }
  }

  // isEmptyProject/isFirstMessage were computed earlier (up by the KB
  // retrieval block) so semanticCachePromise could be started concurrently
  // with it instead of after it -- see the comment there.
  const shouldConfirmFirst = isEmptyProject && isFirstMessage && runtimeMode === 'build';

  // Semantic cache result (agentSemanticCache.ts): the lookup was already
  // started above, concurrently with KB retrieval -- this just awaits
  // whatever's already in flight (already resolved by now on most runs,
  // since everything between the two await points is pure local computation).
  // A hit does NOT skip generation -- the model still writes and validates
  // its own files through the normal tool-call path, nothing about the
  // existing build-check/preview/persistence machinery is bypassed. It's
  // injected as a strong reference the model can adapt, which is where most
  // of the token/time cost of a from-scratch build actually goes.
  let semanticCacheHintBlock = '';
  try {
    const cacheResult = await semanticCachePromise;
    logger.debug('_runAgentLoopInner: semantic cache lookup resolved', {
      projectId, hit: cacheResult.hit, similarity: cacheResult.similarity,
    });
    if (cacheResult.hit && cacheResult.cachedSnapshot) {
      const files = Object.entries(cacheResult.cachedSnapshot)
        .slice(0, 20)
        .map(([p, c]) => `--- ${p} ---\n${String(c).slice(0, 1500)}`)
        .join('\n\n');
      semanticCacheHintBlock = `\n\n# Reference Implementation (similarity ${cacheResult.similarity?.toFixed(2) ?? '?'})\n\nA previous request very similar to this one produced the following working implementation. Use it as a strong starting reference -- adapt it to the specifics of THIS request rather than building from zero, but verify and adjust anything that doesn't actually match what was asked for here.\n\n${files}`;
    }
  } catch (semCacheErr: any) {
    // non-fatal -- proceed without the hint
    logger.debug('_runAgentLoopInner: semantic cache lookup failed (non-fatal)', { projectId, error: semCacheErr?.message });
  }

  const modeInstruction = runtimeMode === 'plan'
    ? `\n\n# Runtime Mode Instruction

You are operating in **PLAN MODE**. You are a strategic planning assistant   your role is to think, discuss, advise, and help the user design their project. You do NOT make any changes to files.

## Hard rules
- NEVER call write_file, edit_file, delete_file, or any file-modification tool.
- NEVER emit <ecomgear-write>, <ecomgear-edit>, or any operational tags.
- Do NOT produce code blocks that represent final implementation   only illustrative snippets to explain a concept.
- Do NOT emit any <ecomgear-*> tags.

## What you CAN do
- Discuss the project vision, goals, and target users.
- Suggest features, pages, components, and architecture.
- Break work into phases or milestones.
- Answer questions about technology choices, best practices, UX patterns.
- Help the user refine requirements and spot gaps or conflicts.
- Produce structured plans, site maps, or feature lists when helpful.
- Be concise   bullet points over paragraphs where possible.

## Saving the plan
You have exactly one tool: \`propose_plan\`. Once the discussion has enough detail that the user could
react to a concrete plan, call it ONCE with a summary and an ordered list of concrete implementation steps.
This does not touch any files   it persists the plan so that when the user says "build it" (or similar),
the build run picks up these exact steps instead of starting cold. Don't call it prematurely on a vague
one-line idea; keep discussing until there's enough to make the steps concrete and actionable. If the plan
changes significantly later in the conversation, call it again   the new plan replaces the old one automatically.

## If the user asks you to make changes or implement something
Respond briefly. Acknowledge what they want, then say:
> "I'm in **Plan mode**   I can only plan and advise here. Switch to **Build mode** to implement this."
Keep that redirect to one or two sentences. Do not lecture or repeat it.

## Tone
Conversational, sharp, helpful. Think of yourself as a senior technical co-founder reviewing the project with the user   not a code generator. Stay focused on what the user is asking.`
    : shouldConfirmFirst
    ? '\n\n# Runtime Mode Instruction\n\nMode: BUILD (confirm-first). This is a NEW empty project   the user\'s first request.\n\n' +
      'IMPORTANT EXCEPTION: If the user\'s message is a simple greeting ("hi", "hello", "hey", etc.), general chat, or does NOT describe what they want to build, respond with a friendly welcome and ask what they\'d like to build. Do NOT invent or assume a project idea. Do NOT call any tools.\n\n' +
      'MANDATORY FLOW (only when the user describes what they want to build):\n' +
      '1. Call `think` to plan the full architecture.\n' +
      '2. Present a concise spec to the user (follow the "First Build" section in Requirement Gathering).\n' +
      '3. Do NOT write any files yet. Do NOT call write_file, edit_file, or any file-modification tools.\n' +
      '4. End by asking the user to confirm or adjust the plan.\n' +
      '5. When the user confirms in the NEXT message, you will receive BUILD mode and should execute immediately.'
    : '\n\n# Runtime Mode Instruction\n\nMode is locked to BUILD by backend policy. Do not self-switch modes.\n\nHard requirements:\n- Execute now: use tools and produce real file changes immediately.\n- Do NOT ask for confirmation to start coding (unless the user\'s intent is genuinely unclear   see EXCEPTION below).\n- Do NOT end with planning-only instructions.\n- PHASED BUILD: If the conversation history contains a phase plan (look for "## Phases" and "Phase N  " lines), you are in phased build mode. Count how many "Phase N done ✓" messages already appear in the history to determine which phase is current. Build ONLY the files for that phase   do NOT build files from future phases. When all files for the current phase are written and verified, end your final message with exactly: "Phase N done ✓   ready to build Phase N+1 ([one-line description])? Reply **continue** to proceed." If this is the last phase, write instead: "All phases complete ✓   your app is ready." IMPORTANT: In phased mode the rule below about writing ALL files is scoped to the current phase only.\n- NON-PHASED BUILD: You MUST write ALL files the app needs before finishing   pages, components, utilities, AND src/App.tsx. Never stop after writing just a few files. A partial build = broken preview.\n- STRICTLY FORBIDDEN: Never say "I didn\'t make any changes", "I haven\'t changed anything", "no changes were made", or any equivalent. If you ran without writing files, you failed   do not announce it, just start writing.\n- ALSO FORBIDDEN: Never output a future-tense promise like "Let me do this", "I\'ll implement that", "I will go ahead and", "I\'m going to build" unless you IMMEDIATELY follow it with actual file writes in the same response. If you say it and then stop with no files written   that is a failure. Either write files right away or ask what the user wants.\n- EXCEPTION (greetings only): If the user\'s message is EXCLUSIVELY a greeting ("hi", "hello", "hey", "how are you") or an identity question ("who are you", "what are you") with NO build request attached   respond with a short text answer only and do NOT call tools. This exception does NOT apply to any message that contains a feature request, a page name, a description, a confirmation ("ok", "yes", "go", "proceed", "build it", "do it"), or ANY reference to the project.\n- EXCEPTION (ambiguous statement): If the user\'s message is a vague statement with NO specific build content (no feature name, page, component, or change described) AND you cannot identify a pending plan in the conversation history to execute   ask ONE short clarifying question about what they\'d like you to build or change. Do NOT invent a task. Do NOT write files for a made-up goal.\n- If the user confirmed a plan you already presented (e.g. "ok", "yes", "go ahead", "looks good", "build it")   that IS a build command. Execute immediately.\n- BRAIN MEMORY: Your older tool call history is automatically compacted to save tokens. Use `save_memory` after your initial `think` to persist key architecture decisions, file purposes, and user requirements so they survive compaction.';

  // Approved plan checklist (Phase 1 of the orchestration plan, 2026-08-09):
  // when a prior plan-mode session produced a persisted plan (agent_plans)
  // and the user just triggered build mode, ai.routes.ts looks it up, marks
  // it approved, and passes its steps here. Injected as a checklist, not a
  // rigid script -- the loop below still executes reactively per step.
  const approvedPlanInstruction = (runtimeMode === 'build' && approvedPlanSteps && approvedPlanSteps.length > 0)
    ? '\n\n# Approved Plan\nThe user approved this plan in an earlier planning discussion. Use it as your checklist, ' +
      'but still verify each step against the actual current file tree -- adapt if something has changed since ' +
      'the plan was made.\n' + approvedPlanSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '';

  // Efficiency instruction   scope it to the tier so micro/fix stay fast but edit
  // still verifies imports (skipping that check is the #1 source of build errors).
  // In plan mode, tier instructions must be suppressed   they reference file-modification
  // workflows (touch, read, write) that contradict plan-mode restrictions.
  //
  // Narration honesty applies to every tier. The user reads ALL narration
  // segments of a run stitched into one message, so mid-run apologies and
  // repeated "final" summaries read as a success-apology-success sandwich
  // (CardPro admin-user run 86ae21dc: three success claims, two apologies,
  // and a success claim about a DB change whose tool call had failed).
  const NARRATION_HONESTY =
    '\n\n**Narration rules (apply to every sentence you write):**\n' +
    '- Your reader is a business owner, not a developer. Describe changes by what they see on screen ("the login works now", "the header shows your logo"). NEVER mention file names, functions, request formats, code structure, tools, "system checks", or your own workflow. Technical detail is allowed ONLY if the user asked a technical question.\n' +
    '- Keep every message SHORT. Progress lines: a few words. Final message: 1-2 short sentences (3 for a full build). Long messages are a failure, not thoroughness.\n' +
    '- NEVER restate a diagnosis, plan, or status you already said. If a step gives you nothing NEW to tell the user, write nothing at all for that step.\n' +
    '- NEVER apologize or narrate your own mistakes ("My apologies", "I misunderstood", "incorrect first attempt"). If an earlier attempt in this run was wrong, silently continue with the correct approach   the user sees only one continuous message, and apology text reads as failure.\n' +
    '- Write ONE final summary, only after ALL work is done. Never write a wrap-up mid-run and then keep working   stacked summaries read as contradictions.\n' +
    '- The final summary describes the END state only. Never mention or re-explain earlier attempts that you replaced.\n' +
    '- NEVER claim an action succeeded if its tool call errored. If something failed, say plainly in ONE sentence what does not work yet   a false success claim is worse than a reported failure.';
  const tierInstruction = runtimeMode === 'plan' ? ''
    : _tier === 'micro'
      ? '\n\n# Efficiency Mode\nDo NOT write any text before your first tool call. Call `think` once (≤40 words), read the file, make the change, done.\n\n**Final message**   one short sentence in plain language on what the user will now see.\nExample: "I\'ve changed the nav buttons to indigo   they now match your brand colors."\nFORBIDDEN: "Done.", "OK.", empty message, file names, or any single-word reply.'
      : _tier === 'fix'
        ? '\n\n# Fix Mode\nDo NOT write any text before your first tool call. Start with tools directly. Call `think` once   identify root cause, read the broken file, fix it, verify with `get_build_errors`.\n\n**SCOPE   stay on the reported problem.** `get_build_errors` reports every error in the WHOLE project, not just ones caused by this turn. If it returns errors in files you have not touched and that are unrelated to what the user described, LEAVE THEM ALONE   do not start fixing them, they are pre-existing and out of scope for this request. Only chase errors that are (a) in a file you just edited, or (b) directly block the specific thing the user reported. If unrelated errors exist, you may mention them in one sentence at the end, but do not act on them without being asked.\n\n**Progress narration**   when you move to a genuinely new step, write a few plain words like "Found the problem   fixing it now." Nothing technical, nothing repeated.\n\n**Final message**   1-2 short sentences in plain language: what was broken (as the user experienced it) and that it now works. FORBIDDEN: single-word replies, file names, and re-explaining your diagnosis.'
        : _tier === 'edit'
          ? '\n\n# Edit Mode\nDo NOT write any text before your first tool call. Start with tool calls directly. Call `think` once   list the 1–3 files you will touch. Then call `declare_scope` with that exact file list before your first write/edit   this is REQUIRED for Edit Mode, not optional. A narrow request ("update the logo", "fix this button") stays narrow: if get_build_errors or anything else surfaces an unrelated pre-existing problem outside your declared scope, leave it alone and mention it in one sentence at the end instead of fixing it. If you discover mid-task that you genuinely need more files than declared, call declare_scope again with the wider list and say why   don\'t just write outside it silently.\n\n**Progress narration**   after each meaningful step, a few plain words about what just changed on their site: "Updated the navbar   now the hero section." No file names, nothing repeated.\n\n**HARD FILE LIMIT**   more than 5 files? STOP after the 5th, tell the user what changed and what remains.\n\n**Final message**   1-2 short sentences in plain language: what changed and what the user will see. FORBIDDEN: single-word replies and technical detail the user didn\'t ask for.'
          : '\n\nDo NOT write any text before your first tool call. Start with tool calls directly.\n\n**Progress narration**   after each part of the site you finish, a few plain words: "Navbar done   building the hero banner." / "Categories grid done   now the product cards." No file names. This shows the build progressing in real time.\n\n**Final message**   at most 3 short sentences after ALL changes: what was built and how it works from the user\'s perspective, in plain language. FORBIDDEN: single-word replies, file lists, and technical decisions the user didn\'t ask about.';
  const tierInstructionWithHonesty = tierInstruction ? tierInstruction + NARRATION_HONESTY : tierInstruction;

  const boundedFileTree = clampContextSection('Project file tree', liveFileTree, MAX_FILE_TREE_CHARS);

  const promptProfile = runtimeMode === 'plan'
    ? 'plan'
    : shouldConfirmFirst
      ? 'confirm'
      : isLikelyFixRequest(prompt)
        ? 'fix'
        : 'build';

  // Tier-based prompt selection (smallest prompt that can handle the task):
  //   micro  →  ~600 tokens   (color/text/spacing tweaks)
  //   fix    →  ~3K tokens    (error fixes   no design/new-project sections)
  //   edit   →  ~4K tokens    (changes to existing apps   strips registry/chunking/new-project)
  //   build  →  ~6-10K tokens (new projects / features   context-stripped build prompt)
  //   other  →  full prompt   (plan/confirm profiles)
  // Plan mode must never receive tier-specific build/edit/fix prompts   they contain
  // file-write instructions that directly conflict with plan-mode restrictions.
  const staticSystemPrompt = runtimeMode === 'plan'
    ? getAppBuilderSystemPrompt('plan')
    : _tier === 'micro'
      ? MICRO_SYSTEM_PROMPT
      : _tier === 'fix'
        ? getFixSystemPrompt()
        : _tier === 'edit' && !isEmptyProject
          ? getEditSystemPrompt()
          : promptProfile === 'build'
            ? getAppBuilderBuildSystemPrompt({
                includeRequirementGathering: isEmptyProject,
                includeStartingNewProject: isEmptyProject,
                // includeSeo/includeIntegration were driven by per-MESSAGE
                // classifier output (promptIntent), so "build me a store" and
                // "change the button colour" produced two different system
                // prompts inside one conversation. This block carries its own
                // cache breakpoint and is the largest single thing in the
                // request (~15-25K tokens), so every flip turned a 0.1x cache
                // READ into a 1.25x cache WRITE. Pinning them on costs a few
                // thousand always-cached tokens and buys a byte-stable prefix
                // across every message of a project phase -- overwhelmingly
                // the better trade at those multipliers. The isEmptyProject
                // flags stay conditional: they flip once, when the project
                // stops being empty, not per message.
                includeSeo: true,
                includeIntegration: true,
                includeErrorPatterns: isEmptyProject,
                includeCapabilities: isEmptyProject,
                includePreviewEnvironment: isEmptyProject,
              })
            // Lifecycle audit finding (2026-08-11/12): promptProfile==='fix'
            // (set by the isLikelyFixRequest heuristic) and _tier==='fix' (set
            // by the real classifyRequest classifier, checked above) can
            // disagree on borderline prompts -- when they do, execution used
            // to fall through here to app-builder.prompt.ts's OTHER, separately
            // maintained "fix" builder (getAppBuilderSystemPrompt('fix')),
            // which strips only 4 sections vs getFixSystemPrompt()'s 8+2,
            // producing a genuinely different (75.8K vs 69.6K char, measured)
            // prompt depending on which classifier happened to fire. Route
            // both paths through the SAME real builder so "fix" always means
            // one prompt, not two silently-different ones.
            : promptProfile === 'fix'
              ? getFixSystemPrompt()
              : getAppBuilderSystemPrompt(promptProfile);

  logger.info('[AgentLoop] Prompt profile resolved', {
    projectId, promptProfile, tier: _tier ?? 'unset', maxSteps: MAX_STEPS, staticSystemPromptChars: staticSystemPrompt.length,
    isWebsiteBuild: promptIntent?.isWebsiteBuild === true, hasIntegrationRequest: promptIntent?.hasIntegrationRequest === true,
    isEmptyProject,
  });

  // Build the project knowledge block from KnowledgeSettings (custom_system_prompt + context_notes).
  // This is injected at the top of every request so the agent always has project-specific context.
  const knowledgeBlock = (() => {
    const parts: string[] = [];
    if (projectKnowledge?.customSystemPrompt) {
      parts.push(`## Custom Instructions\n\n${projectKnowledge.customSystemPrompt}`);
    }
    if (projectKnowledge?.contextNotes) {
      parts.push(`## Project Context Notes\n\n${projectKnowledge.contextNotes}`);
    }
    return parts.length > 0
      ? `\n\n# Project Knowledge\n\nThe project owner has set the following custom instructions and context. Follow them throughout this entire session   they take precedence over default behavior.\n\n${parts.join('\n\n')}`
      : '';
  })();

  // Inject project secrets as env var context   agent may reference them in code
  // but MUST NEVER echo, print, log, or reveal their values in chat responses.
  //
  // Also injects the REAL current schema (table names/columns/row counts)
  // directly into every request when a hosted DB exists   previously the agent
  // only saw the schema if it remembered to call get_database_schema first,
  // and skipping that call was the single biggest cause of it guessing wrong
  // column names or inventing tables that don't exist. This makes schema
  // access unconditional instead of tool-call-dependent.
  const secretsBlock = await (async () => {
    if (!projectSecrets || projectSecrets.length === 0) return '';
    const lines = projectSecrets.map(s => `${s.key_name}=${s.key_value}`).join('\n');
    const hasSb  = projectSecrets.some(s => s.key_name === 'VITE_SUPABASE_URL');
    const hasDb  = projectSecrets.some(s => s.key_name === 'VITE_DB_API_URL');
    const hasEcg = projectSecrets.some(s => s.key_name === 'ECG_PORTAL_TOKEN');
    const hasEcgMcp = projectSecrets.some(s => s.key_name === 'ECG_MCP_URL');

    const sbNote = hasSb
      ? (hasDb
          ? '\n\nUse `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for AUTHENTICATION ONLY (sign up, log in, log out, session/user). This project also has its own hosted database (below)   ALL application data (tables like posts, products, orders, profiles, etc.) MUST go through `VITE_DB_API_URL`, NEVER through Supabase. Do not create or query app-data tables against Supabase when a hosted database is present. NEVER hardcode any `*.supabase.co` URL   it will cause CORS errors in the preview.'
          : '\n\nFor Supabase auth/data in generated code ALWAYS use `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_ANON_KEY`. NEVER hardcode any `*.supabase.co` URL   it will cause CORS errors in the preview.')
      : '';
    // Fetch the real current schema unconditionally   don't rely on the agent
    // remembering to call get_database_schema. Best-effort: a fetch failure
    // here just means no live schema block, never blocks the run.
    let liveSchemaBlock = '';
    if (hasDb && userId) {
      logger.debug('_runAgentLoopInner: fetching live DB schema for secrets block', { projectId, userId });
      try {
        const tables = await databaseService.listTables(userId, projectId);
        liveSchemaBlock = tables.length === 0
          ? '\n\n**Current schema: no tables yet.** Use `query_database` with CREATE TABLE to add some before writing data-dependent code.'
          // Row counts deliberately omitted: they change whenever an end user
          // touches the generated app, and this block sits inside the cached
          // dynamic-context system message -- so a visitor signing up could
          // invalidate the agent's cached prefix between two messages that are
          // otherwise identical. The agent needs table and column names to
          // write correct code; it has never needed the row count, and
          // get_database_schema can still report it on demand.
          : '\n\n**Current schema (live):**\n' + tables.map((t) => {
              const cols = t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(', ');
              return `- ${t.name}: ${cols}`;
            }).join('\n') +
            '\n\nUse these EXACT table/column names   never guess or invent one. If you need to change the schema, call `query_database`, then re-check via `get_database_schema` before writing dependent code.';

        // Functions/RPCs were previously invisible here (listTables only ever
        // covered tables) -- the agent had no way to know a callable
        // db.rpc(...) function already existed without a raw pg_proc query,
        // which repeatedly produced duplicate/near-duplicate helper functions
        // across runs. Unconditional like the table block above, for the same
        // reason: don't rely on the agent remembering to ask.
        try {
          const functions = await databaseService.listFunctions(userId, projectId);
          if (functions.length > 0) {
            liveSchemaBlock += '\n\n**Existing functions/RPCs (callable via `db.rpc(name, args)` inside an edge function):**\n' +
              functions.map((f) => `- ${f.name}(${f.argTypes}) -> ${f.returnType}`).join('\n') +
              '\n\nReuse one of these if it already does what you need instead of creating a near-duplicate.';
          }
          logger.debug('_runAgentLoopInner: live schema fetch complete', {
            projectId, tableCount: tables.length, functionCount: functions.length,
          });
        } catch (fnListErr: any) {
          // Non-fatal   agent can still call get_database_schema itself
          logger.debug('_runAgentLoopInner: listFunctions failed (non-fatal)', { projectId, error: fnListErr?.message });
        }
      } catch (tableListErr: any) {
        // Non-fatal   agent can still call get_database_schema itself
        logger.debug('_runAgentLoopInner: listTables failed (non-fatal)', { projectId, error: tableListErr?.message });
      }
    }

    const dbNote = hasDb
      ? '\n\nThis project\'s hosted database is the ONLY place for application data (any table the user asks for   posts, products, orders, custom records, etc.).' +
        '\n\n**⚠️ CRITICAL   every table is deny-all by default (RLS enabled, zero policies) the instant it\'s created.** `VITE_DB_ANON_KEY` is bundled straight into the public JS bundle (anyone can read it via devtools), but its role can read NOTHING on a new table until you explicitly run `CREATE POLICY ... TO <schema>_anon` for it. A direct fetch against a table with no such policy does not error   it silently returns an empty array, which looks like "no code changes needed" but is actually a broken feature. There is no `auth.uid()`-style per-end-user identity layer like real Supabase; a policy is table-wide (readable by any anon-key holder), not scoped per visitor.' +
        '\n\n**Database access rule: writes and anything private go through edge functions, always. Plain public reads MAY use a direct client fetch, but ONLY if you also add the matching anon-read policy in the SAME turn   the two are not optional companions.** Use `write_edge_function` for: user-specific/private data (orders, profiles, messages, anything with an owner), ALL writes (INSERT/UPDATE/DELETE from the browser bypasses any validation you meant to enforce), and anything requiring authorization logic ("only the owner can see this"). For a genuinely public read (a product catalog, public blog posts, a leaderboard) you may fetch `import.meta.env.VITE_DB_API_URL/rest/v1/<table>` directly from the frontend   but immediately after creating or first wiring that table, call `query_database` with `CREATE POLICY "public_read_<table>" ON <table> FOR SELECT TO <schema>_anon USING (true)` (or a narrower condition if only some rows are public). Skipping this step is the single most common way a "finished" feature ships broken. Inside an edge function, `VITE_DB_API_URL` is never needed   the privileged `db.*` helper is already scoped to this project\'s isolated schema.' + liveSchemaBlock +
        (hasSb ? ' This hosted database has NO auth/login server of its own   it is Postgres + PostgREST only. Never attempt to hit `VITE_DB_API_URL/auth/...`   that endpoint does not exist here; auth always goes through Supabase (above).' : '') +
        '\n\n**Login/signup/password checks are SECURITY-CRITICAL and MUST be an edge function   never a direct client-side PostgREST call.** Querying `users?email=eq.X&password=eq.Y` straight from the browser puts the password in the URL (logged everywhere) and exposes the whole table to anyone with the anon key. Write an edge function that looks up the user via `db.select` and compares a HASHED password server-side; return only a session token/user object.\n' +
        '\n\n**Edge functions**   use `write_edge_function` for server-side logic the browser should never run directly: auth/password checks (above), any user-specific or private data access, any write, code that needs a secret API key, webhook handlers, scheduled/triggered jobs, or any multi-step backend operation. Do NOT put that logic in frontend code just because it seems simpler   if it touches private/owned data, writes anything, needs a secret, touches passwords, or must run server-side, it MUST be an edge function. Inside the function, read saved secrets with the EXACT key name they were saved under, including a `VITE_` prefix if that\'s how it\'s stored   `secrets.VITE_DB_API_URL`, not `secrets.DB_API_URL`. Guessing a shortened name silently breaks every call in the function (the "secrets not configured" guard trips immediately) with no visible error until someone actually tests it. Check the actual secret list above instead of assuming a name (save new keys with `set_secret` first   never paste key values into function code or frontend files).\n' +
        '\n\n**Writing an edge function is not the task   wiring it up is.** A function that exists in the database but that no frontend code ever calls does nothing; the app keeps using whatever it was using before, and it will look to the user like "the edge function isn\'t doing anything" even though the function itself is fine. Every time you write or update an edge function for an existing feature, in the SAME turn: (1) find every place in the frontend that currently does this work directly (a raw fetch, a `getDbUrl(...)` call, inline logic) and (2) replace it with an invoke call to the function, deleting the old direct-access code path. Never leave a newly written function orphaned while the old code keeps running.\n' +
        '\n\n**Do not write a generic pass-through proxy** (e.g. one function that accepts an arbitrary `path`/`method`/`body` and forwards it straight to the database) as a way to satisfy "route through edge functions." That technically avoids a direct frontend fetch but adds zero real authorization or validation   it\'s functionally identical to direct client access, just relocated. Each edge function should implement one specific operation (or a small, named set of operations) with real server-side logic: check who\'s asking, validate the input, only allow what that specific operation actually needs.\n' +
        'Invoke a written function from the frontend with:\n```ts\nconst res = await fetch(`${import.meta.env.VITE_FUNCTIONS_API_URL}/<name>/invoke`, {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\', apikey: import.meta.env.VITE_DB_ANON_KEY },\n  body: JSON.stringify({ params: { /* ... */ } }),\n});\n```\n`VITE_FUNCTIONS_API_URL` ALREADY ends in `/functions` (a full base URL, not a bare host)   the path is FLAT: `${VITE_FUNCTIONS_API_URL}/<name>/invoke`. Do NOT prepend `/api/v1/functions` or any other prefix (that is this platform\'s OWN internal API shape, unrelated to a generated app\'s runtime calls, and will 404). No project_id is needed   the anon key itself identifies which project\'s function to run.\n' +
        'This endpoint is public and rate-limited (30 req/min)   it authenticates with the SAME `VITE_DB_ANON_KEY` used for the database, not a login session, so it works for anonymous visitors of the generated app, not just its owner.'
      : '';
    const ecgNote = hasEcg
      ? '\n\n## eCG Agents Portal Integration\n\nThis project is linked to the eCG Agents Portal. Follow these rules strictly:\n\n**Frontend (React) code**   NEVER call the portal API directly from the browser. All portal data goes through the eComGear server proxy:\n```ts\n// In src/lib/ecgClient.ts   already configured\nconst url = `${import.meta.env.VITE_ECG_PROXY_URL}/api/v1/ecg-proxy${path}?projectId=${import.meta.env.VITE_PROJECT_ID}`;\n```\nUse `ecgApi` from `src/lib/ecgClient.ts` for all data fetching. Do not use `ECG_PORTAL_TOKEN`   it is server-side only.\n\n**Edge functions**   use the pre-injected `ecg` helper (not `fetch`). ECG credentials are injected server-side:\n```js\n// Agents\nconst agents = await ecg.get(\'/agents\');\n// Approve a post\nawait ecg.patch(\'/planned-posts/\' + params.postId, { status: \'approved\' });\n// Run history\nconst runs = await ecg.get(\'/runs\');\n// LLM call (uses the configured AI model, key stays server-side)\nconst reply = await ecg.llm([\n  { role: \'user\', content: \'Summarize agent performance\' }\n], \'You are an eCG assistant.\');\n```\n`ecg` is `null` for projects without portal integration   check before using.\n\n**AI chat**   the dashboard has a built-in `src/pages/ChatPage.tsx` (the "Assistant" nav tab, mounted at `/`) that calls `chat()` from `src/lib/ecgClient.ts`, which hits `/api/v1/ecg-chat`   an agentic tool-calling endpoint (list/create/run agents, approve/reject posts, trigger schedulers, etc., defined server-side in `ecg-chat.routes.ts`). Extend `ChatPage.tsx`/`ecg-chat.routes.ts`, do not duplicate it. Do not confuse this with `/api/v1/ecg-proxy/ai-chat`   that is a separate, tool-less plain LLM passthrough that the template does not use.\n\n**Security rule**   NEVER expose `ECG_PORTAL_TOKEN`, `ECG_LLM_API_KEY`, or any `ECG_*` secret in frontend code, logs, or responses.' +
        (hasEcgMcp ? '\n\n**Knowledge base**   you have a `search_org_knowledge` tool. Use it to ground generated UI copy and content (brand voice, product descriptions, business context) in the organization\'s real knowledge instead of inventing generic placeholder text.' : '') +
        '\n\n**Customization surface**   this dashboard was seeded from the eCG template; its README.md documents the architecture. Respect these layers when customizing: `src/ecg-config.ts` holds appName/logoUrl/layout/modules; ALL colors and fonts are CSS variables in `src/index.css` (`--accent`, `--sidebar-bg`, `--body-bg`, `--card-bg`, `--text`, `--muted`, `--border`)   restyle by changing tokens, never by hardcoding colors in components. `src/components/Layout.tsx` builds nav from `ECG.modules`; new pages = route in `src/App.tsx` + `ALL_NAV` entry. Never edit `src/pages/AccessGate.tsx` or the token handling in `src/lib/ecgClient.ts`   they are the dashboard\'s authentication.' +
        '\n\n**This is a live dashboard the user is already using, not a blank scaffold   know what you\'re building before you touch it.** Before any change, check the current file tree and read the existing page(s) you\'re about to affect. Never break, remove, or silently rewrite a page/component the user didn\'t ask you to touch just to implement something unrelated. A custom feature request is additive by default: a new route + `ALL_NAV` entry that calls `ecgApi`, not a replacement of what already renders.' +
        '\n\n**Building a custom feature against the API**   README.md has a full `ecgApi` reference table (every resource/method, and which ones are MCP-supported vs. portal-only for legacy dashboards). Check it before assuming an operation needs a new backend endpoint   the API already covers agents, schedulers, posts (incl. bulk approve/regenerate), visual-post generation, connectors, knowledge bases, notifications, and the auto-approve trust dial. Only reach for a new edge function if the user\'s ask genuinely isn\'t covered by any `ecgApi` method.'
      : '';

    const noHardcodeRule = '\n\n**NEVER hardcode any secret value from this list as a string literal anywhere in generated code   not even as a fallback/default for a missing env var (e.g. `getEnvVar(\'X\', \'<real value>\')`).** Always reference `import.meta.env.VITE_XXX` / `process.env.XXX` directly. A hardcoded fallback that happens to be a real credential from THIS project can end up copied into a DIFFERENT project by mistake, silently pointing that other project at this one\'s database or auth   this has happened before. If an env var might be missing, fail loudly (throw/log an error) instead of falling back to a real value.' +
      '\n\n**The same rule applies to EcomGear platform URLs.** `api.ecomgear.dev`, `gen.ecomgear.dev`, `preview.ecomgear.app`, and `apps.ecomgear.app` are EcomGear\'s own infrastructure servers   they are NOT part of the user\'s app and must NEVER appear as string literals in generated code, not even as env-var fallbacks like `import.meta.env.X || \'https://api.ecomgear.dev\'`. The hosted database endpoint (`db.ecomgear.app` / `cloud.ecomgear.app`) is only ever reached through `import.meta.env.VITE_DB_API_URL`   never hardcode it either. Never invent placeholder values like `\'dummy\'` for keys. If an integration\'s env var is NOT in the list below, that integration is not configured for this project   do not guess a URL or key; tell the user what needs to be set up instead.';

    return `\n\n# Project Environment Variables\n\nThe following secrets are available as \`import.meta.env.VITE_XXX\` (frontend) or \`process.env.XXX\` (backend). NEVER echo, print, log, or reveal their values in chat responses   treat them as confidential.${noHardcodeRule}${sbNote}${dbNote}${ecgNote}\n\n\`\`\`\n${lines}\n\`\`\``;
  })();

  // micro: no modeInstruction (MICRO_SYSTEM_PROMPT already embeds directives)
  // edit: compact instruction   no phased build, no verbose rules (saves ~1,500 tokens)
  // plan mode always wins   tier instructions must never override plan-mode restrictions
  const EDIT_MODE_INSTRUCTION = '\n\n# Runtime Mode Instruction\nExecute immediately   start with tool calls directly. Do NOT write any text before your first tool call. No "I\'ll...", no "Let me...", no acknowledgments before tools. Do NOT ask for confirmation. Do NOT rewrite files not involved in the change. If intent is unclear, ask one short question before calling tools.\n\n**Progress narration**   after each meaningful change, a few plain words: "Updated the header   now fixing the colors." No file names, nothing repeated.\n\n**Final message**   once all changes are done, 1-2 short sentences in plain language: what changed and what the user will see differently. FORBIDDEN: single-word replies, file names, and technical detail the user didn\'t ask for.';
  const effectiveModeInstruction = runtimeMode === 'plan' ? modeInstruction
    : _tier === 'micro' ? ''
    : _tier === 'edit' ? EDIT_MODE_INSTRUCTION
    : modeInstruction;

  // micro tier: only send the directly-mentioned file, not up to 4 files.
  // A colour/text change only needs the one file that contains the element.
  const effectiveFilesContext = _tier === 'micro'
    ? (cappedFiles.find(f => directlyMentioned.has(f.path))
        ? `=== ${cappedFiles.find(f => directlyMentioned.has(f.path))!.path} ===\n${cappedFiles.find(f => directlyMentioned.has(f.path))!.contextContent}`
        : existingFilesContext.split('\n\n')[0] ?? '')  // just first file if none mentioned
    : existingFilesContext;

  const assemblePrompt = (base: string) =>
    base +
    knowledgeBlock +
    secretsBlock +
    effectiveModeInstruction +
    approvedPlanInstruction +
    tierInstructionWithHonesty +
    (boundedOlderSummary
      ? `\n\n# Earlier Conversation Summary\n\nThis is a summary of older messages in this conversation. Use it to maintain continuity:\n\n${boundedOlderSummary}`
      : '') +
    (boundedFileTree
      ? `\n\n# Project File Tree\n\nThese are ALL the files currently on disk. This is authoritative   if a file is not listed here, it does NOT exist. Use this to verify imports and plan which files to create or edit.\n\n\`\`\`\n${boundedFileTree}\n\`\`\``
      : '\n\n# Project File Tree\n\nThe project directory is empty   this is a fresh project. You must create all files from scratch.') +
    (effectiveFilesContext
      ? `\n\n# Current Project File Contents\n\nFocused previews of the most relevant project files. Use these to get oriented quickly, then call \`read_file\` for any file you need in full before editing.\n\n${effectiveFilesContext}${_tier !== 'micro' ? truncatedFilesNote + excludedFilesNote : ''}`
      : '') +
    semanticCacheHintBlock +
    attachmentContext;

  // Defense-in-depth: strip any build-mode directives that should never appear in plan mode.
  // This catches any future instruction block that forgets to check runtimeMode first.
  const enforcePlanMode = (prompt: string): string => {
    if (runtimeMode !== 'plan') return prompt;
    return prompt
      .replace(/Execute immediately[^.]*\./gi, '')
      .replace(/Mode is locked to BUILD[^\n]*/gi, '')
      .replace(/# Efficiency Mode[\s\S]*?(?=\n#|\n\n#|$)/g, '')
      .replace(/# Edit Mode[\s\S]*?(?=\n#|\n\n#|$)/g, '')
      .replace(/# Fix Mode[\s\S]*?(?=\n#|\n\n#|$)/g, '');
  };

  const systemPrompt = enforcePlanMode(assemblePrompt(staticSystemPrompt));
  const dynamicContext = enforcePlanMode(assemblePrompt(''));
  logger.debug('_runAgentLoopInner: system prompt assembled', {
    projectId, runtimeMode, systemPromptChars: systemPrompt.length, dynamicContextChars: dynamicContext.length,
  });

  // Per-run brain memory   survives context compaction across steps.
  // Hoisted above the Gemini cache block because buildToolSet needs it.
  const brainMemory: string[] = [];
  // Plan mode gets exactly one tool: propose_plan. Reuses buildToolSet's full
  // construction (its write_file/edit_file-specific guards are no-ops for a
  // tool with a different name) then narrows to just propose_plan, so plan
  // mode's output becomes a persisted artifact instead of throwaway chat text
  // -- see propose_plan.ts and agent_plans (20260809183149_agent_plans.sql).
  const toolSet = runtimeMode === 'plan'
    ? (() => {
        const full = buildToolSet(ctx, brainMemory, _tier);
        return full.propose_plan ? { propose_plan: full.propose_plan } : undefined;
      })()
    : buildToolSet(ctx, brainMemory, _tier);
  logger.debug('_runAgentLoopInner: tool set built', {
    projectId, runtimeMode, tier: _tier ?? 'unset', toolNames: toolSet ? Object.keys(toolSet) : [],
  });

  // ── Gemini run-level context cache ───────────────────────────────────────
  // Plan mode has no tools   cache just the system prompt (createGeminiRunCache).
  // Build/edit/fix/feature modes have tools   Gemini rejects generateContent
  // requests that pass tools alongside cachedContent, so those must be baked
  // into the cache itself (createGeminiToolCache). The stripToolsForCache
  // middleware then removes `tools` from the outbound wire request while
  // leaving local tool-call execution (via the `tools` object passed to
  // streamText) completely unaffected.
  let geminiRunCacheName: string | null = null;
  // DECISION 2026-07-21 (rebuild plan Task 1.2): staying disabled. The API
  // constraint below is real (commit a105eb8, Jul 3) and the fix is a
  // restructure, not a flag. Gemini 2.5+ implicit caching is already active
  // automatically (extractCacheUsage reads cachedContentTokenCount) and the
  // per-step provider= logging now measures it   revisit explicit caching
  // only if measured implicit hit-rates stay poor on Gemini-served steps.
  // DISABLED (production incident): Gemini's cachedContent API rejects ANY
  // generateContent request that also sets system_instruction, tools, OR
  // tool_config. The AI SDK's `system` param always becomes system_instruction
  // when non-empty   so there is no way to send per-request dynamic context
  // (file tree, project files) through `system` while a tool-cache is active.
  // Sending dynamicContext via `system` (as the previous fix attempted) hit
  // this exact 400 in production. Reusing a cache correctly requires routing
  // dynamic content through `messages` instead of `system`, which is a real
  // rework, not a hotfix   disabling the tool-cache path entirely until that
  // lands. Gated on `!toolSet` now, not just runtimeMode === 'plan': plan mode
  // gained one real tool (propose_plan, see toolSet above) so "plan mode never
  // sends tools" is no longer true, and sending tools alongside cachedContent
  // hits the exact same 400 this comment describes.
  const geminiToolCacheName: string | null = null;
  if (providerName === 'gemini' && runtimeMode === 'plan' && !toolSet) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      geminiRunCacheName = await createGeminiRunCache(systemPrompt, modelId, geminiKey);
    }
  }
  // Wrap the provider so the outbound request omits `tools`/`toolConfig`
  // whenever a tool cache is active   only affects the wire request, not
  // local tool-call dispatch (streamText still receives `tools: toolSet` below).
  const streamingProvider = geminiToolCacheName
    ? wrapLanguageModel({ model: aiProvider, middleware: createStripToolsForCacheMiddleware() })
    : aiProvider;

  const isAnthropicModel = providerName === 'anthropic';
  // Built as a function of the ACTUAL provider serving a given attempt, not
  // frozen once for the originally-requested provider. Bug found live
  // 2026-07-14: a Gemini→Claude fallback (happening on most runs while
  // Gemini's billing circuit trips) reused the Gemini-shaped system message
  // (no cacheControl) even though Claude was the one actually executing  
  // every fallback-to-Claude run paid full price with zero cache hits,
  // silently, for however long this had been wrong.
  // Claude runs with NATIVE adaptive thinking enabled (anthropicProviderOptions
  // below), yet the shared system prompt still instructs "call think first"
  // so it reasons twice and bills twice. Measured live 2026-07-21: 6 of 12
  // steps in one edit run were think tool calls, ~$0.80 of a $1.66 run that
  // then died on the cost cap right after finishing the actual work. This
  // static suffix (byte-stable   cache-friendly) overrides that for Anthropic.
  const ANTHROPIC_NO_THINK_TOOL_NOTE =
    '\n\n# Native reasoning (Anthropic)\n' +
    'You reason natively before every response   the `think` tool would duplicate that reasoning as a ' +
    'separate billed step producing no code. Do NOT call `think`. Plan inside your native reasoning, then go ' +
    'straight to read_file/write_file/edit_file/etc. Every step should call a real tool that reads or changes something.';

  function buildSystemMessagesFor(pName: string): Array<{ role: 'system'; content: string; providerOptions?: Record<string, any> }> {
    if (pName === 'anthropic') {
      return [
        // Static part   cached by Anthropic (identical across all requests)
        {
          role: 'system' as const,
          content: staticSystemPrompt + ANTHROPIC_NO_THINK_TOOL_NOTE,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        // Dynamic part   changes per request (file tree, project files, attachments)
        // Also cached: it's stable across all steps of this run, so subsequent steps are cache hits.
        ...(dynamicContext.trim() ? [{ role: 'system' as const, content: dynamicContext, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }] : []),
      ];
    }
    return geminiRunCacheName
      ? [] // plan mode: the FULL system prompt lives in the cache   sending it again would conflict
      : [{ role: 'system' as const, content: systemPrompt }];
  }
  const systemMessages = buildSystemMessagesFor(providerName);
  // Whole system prompt, unclipped: the single most-needed artifact when
  // replaying a run in a test environment.
  tracer.event('system-prompt', {
    provider: providerName,
    tier: _tier,
    mode: runtimeMode,
    messages: systemMessages.map((m) => m.content),
  });

  // Use a real default timeout so upstream stalls do not leave the frontend
  // waiting indefinitely. Anthropic gets a shorter cutoff because it is the
  // provider currently most prone to long rate-limit stalls.
  const parsedAgentTimeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS || '0', 10);
  const AGENT_TIMEOUT_MS = Number.isFinite(parsedAgentTimeoutMs) && parsedAgentTimeoutMs > 0
    ? parsedAgentTimeoutMs
    : getDefaultAgentTimeoutMs(providerName);
  const abortController = new AbortController();
  const externalAbortHandler = () => abortController.abort();

  if (abortSignal) {
    if (abortSignal.aborted) {
      abortController.abort();
    } else {
      abortSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  // Set to true when the timeout handler already emitted a 'done' event.
  // Prevents the route-level catch from emitting a second 'error' SSE after abort.
  let timeoutDoneSent = false;

  const agentTimeoutId = AGENT_TIMEOUT_MS > 0 ? setTimeout(async () => {
    if (abortController.signal.aborted) return;
    logger.warn('[AgentLoop] Timeout hit, salvaging files before aborting', {
      projectId, userId, AGENT_TIMEOUT_MS, stepCount,
    });

    try {
      // Prefer the known-clean pre-agent snapshot over a fresh disk scan. A
      // fresh scan can catch the project mid-repair   e.g. after a mechanical
      // brace-balancer has already run but before the repair loop finished  
      // and would ship that half-broken intermediate state as if it were a
      // safe "partial progress" checkpoint. The pre-agent snapshot is always
      // syntactically valid (it's whatever was on disk before this run
      // touched anything), so on timeout it's the safer choice whenever it's
      // a FULL snapshot. It's only partial for the micro tier (single
      // mentioned file only)   using a partial file set here would delete
      // the rest of the project on the next fullSync, so micro tier keeps
      // the original disk-scan fallback.
      const useCleanSnapshot = _tier !== 'micro' && preAgentDiskSnapshot.size > 0;

      let salvageFiles: Array<{ path: string; content: string }>;
      if (useCleanSnapshot) {
        salvageFiles = Array.from(preAgentDiskSnapshot.entries()).map(([p, c]) => ({ path: p, content: c }));
        logger.warn('[AgentLoop] Timeout salvage: using clean pre-agent snapshot instead of current (possibly mid-repair) disk state', {
          projectId, fileCount: salvageFiles.length,
        });
      } else {
        logger.warn('[AgentLoop] Timeout salvage: no clean pre-agent snapshot available, scanning current disk state', { projectId, tier: _tier ?? 'unset' });
        const SKIP_DIRS_TIMEOUT = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.tmp', 'coverage']);
        const SKIP_FILES_TIMEOUT = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
        const BINARY_EXTS_TIMEOUT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
        const BIN_SENTINEL = '__ECOMGEAR_BIN64__';

        const salvageMap = new Map<string, string>();
        const salvageCollect = (dir: string) => {
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
            logger.debug('salvageCollect: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
            return;
          }
          for (const entry of entries) {
            if (SKIP_DIRS_TIMEOUT.has(entry.name)) continue;
            if (SKIP_FILES_TIMEOUT.has(entry.name)) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { salvageCollect(fp); }
            else {
              const ext = path.extname(entry.name).toLowerCase();
              const rel = path.relative(appPath, fp);
              try {
                if (BINARY_EXTS_TIMEOUT.has(ext)) {
                  salvageMap.set(rel, `${BIN_SENTINEL}${fs.readFileSync(fp).toString('base64')}`);
                } else {
                  salvageMap.set(rel, fs.readFileSync(fp, 'utf8'));
                }
              } catch (readErr: any) {
                logger.debug('salvageCollect: failed to read file (skipped)', { rel, error: readErr?.message });
              }
            }
          }
        };
        salvageCollect(appPath);
        salvageFiles = Array.from(salvageMap.entries()).map(([p, c]) => ({ path: p, content: c }));
        logger.debug('_runAgentLoopInner: timeout salvage disk scan complete', { projectId, fileCount: salvageFiles.length });
      }

      if (salvageFiles.length > 0) {
        sink.emit('done', {
          filesToWrite: runtimeMode === 'plan' ? [] : stripBinariesForClient(salvageFiles),
          filesToDelete: [],
          renames: [],
          dependencies: [],
          mode: runtimeMode,
          summary: useCleanSnapshot
            ? 'Agent timed out mid-repair. Reverted to the last known-good state.'
            : 'Agent timed out. Partial progress was saved.',
          tokensUsed: 0,
          costUsd: 0,
          ecoUsed: 0,
          snapshotId: `${projectId}_${randomUUID().replace(/-/g, '')}`,
        });
        timeoutDoneSent = true;
        logger.warn('[AgentLoop] Timeout: salvaged files emitted as done event', {
          projectId, userId, fileCount: salvageFiles.length, usedCleanSnapshot: useCleanSnapshot,
        });
      }
    } catch (salvageErr: any) {
      logger.warn('[AgentLoop] File salvage on timeout failed', {
        projectId, userId, error: salvageErr?.message, stack: salvageErr?.stack,
      });
    }

    // Mark the abort so the catch block knows not to emit a second 'error' SSE.
    const timeoutAbortErr = Object.assign(new Error('Agent timeout'), { isAgentTimeout: true });
    abortController.abort(timeoutAbortErr);
  }, AGENT_TIMEOUT_MS) : null;

  // Heartbeat: keep SSE connection alive and let the frontend detect dead connections.
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const heartbeatId = setInterval(() => {
    sink.heartbeat();
  }, HEARTBEAT_INTERVAL_MS);

  try {
    let accumulatedText = '';
    let emittedStabilityNotice = false;

    const sanitizeUserFacingDelta = (text: string): string => {
      // Keep raw model output for parsing, but avoid surfacing raw compiler logs to end users.
      const looksLikeBuildLog = /\[plugin:vite|\bpostcss\b|\berror\s+TS\d+\b|\/(src|var)\/[^\n]+:\d+:\d+|^\s*at\s+[^\n]+\([^\n]+\)$/im.test(text);
      if (!looksLikeBuildLog) return text;
      if (SUPPRESS_RECOVERY_UI) return '';
      if (emittedStabilityNotice) return '';
      emittedStabilityNotice = true;
      return '\n> *Running automatic stability checks and fixes...*\n\n';
    };
    let streamError: any = null;

    // Only snapshot in build mode   plan mode never touches files so there's nothing to restore.
    const snapshotId = runtimeMode !== 'plan' ? `${projectId}_${randomUUID().replace(/-/g, '')}` : null;
    const snapshotDir = snapshotId ? path.join(SNAPSHOTS_DIR, snapshotId) : null;
    if (snapshotDir) {
      logger.debug('_runAgentLoopInner: kicking off pre-run project snapshot', { projectId, snapshotId, snapshotDir });
      snapshotProject(appPath, snapshotDir).catch((snapErr: any) => {
        logger.warn('_runAgentLoopInner: pre-run project snapshot failed (non-fatal)', { projectId, snapshotId, error: snapErr?.message });
      });
    }

    // ── Diagnose-before-fix (harness redesign increment 3, Gap 3, 2026-08-11) ──
    // Root-cause audit finding: fix-tier's only defense against chasing
    // unrelated pre-existing errors was a prompt line ("stay on the reported
    // problem") the model disregarded live (the "why did you remove the
    // logos" incident -- burned its whole step budget across
    // ProjectDetails.tsx/permissions/WorkflowControls, none of which the user
    // reported). This runs a small, bounded, READ-ONLY pass before the main
    // loop starts: investigate ONLY the reported issue, then seed
    // ctx.declaredScope (increment 2's gate) with the file(s) actually
    // implicated, so the main loop is scoped from its very first step instead
    // of relying on prompt text alone.
    //
    // Extended to edit tier 2026-08-13: originally fix-only, but a near-
    // identical incident recurred on an EDIT-tier request ("use the real
    // logos in the project" -- not phrased as a bug report, so it never hit
    // FIX_RE/fell through to 'edit') -- it wandered into unrelated files and
    // ended up deleting/renaming pre-existing duplicate type-definition
    // files nobody asked about. edit tier has the same "read several
    // existing files, then change some of them" shape fix tier does (25 vs
    // 28 max steps), so the same guardrail applies.
    //
    // Best-effort: any failure, timeout, empty, or unusable result falls
    // through to today's unchanged, unscoped behavior -- this must never
    // block the turn. No write/edit/delete/rename tools are in this pass's
    // toolset at all, so regardless of output quality it is structurally
    // incapable of mutating anything -- unlike the prompt-only version of
    // this discipline, a bug here can't make the diagnosis pass itself wander
    // and edit the wrong file, because it has no tool that could.
    let diagnosisContext = '';
    if ((_tier === 'fix' || _tier === 'edit') && runtimeMode === 'build') {
      try {
        // Fresh, isolated AgentContext -- NOT the real `ctx` -- so this pass's
        // read_file/get_build_errors calls don't consume the main run's own
        // budgets (get_build_errors is capped at 5 calls/run via
        // ctx.buildErrorCallCount; sharing ctx would silently eat into that).
        // Same isolation pattern the existing post-run repair pass already
        // uses (repairCtx/repairToolSet, ~3690 below), not a new one.
        const diagnosisCtx: AgentContext = {
          appPath,
          projectId,
          readFiles: new Set<string>(),
          pendingPreviewFiles: new Map<string, string>(),
          previewServiceUrl: ctx.previewServiceUrl,
          onXmlComplete: () => {}, // read-only toolset never produces file-op XML
        };
        const diagnosisToolSet = Object.fromEntries(
          Object.entries(buildToolSet(diagnosisCtx, [], 'fix')).filter(([name]) => DIAGNOSIS_TOOL_NAMES.has(name)),
        );

        logger.debug('_runAgentLoopInner: diagnose-before-fix generateText call starting', {
          projectId, tier: _tier, providerName, modelId, diagnosisToolNames: Object.keys(diagnosisToolSet),
        });
        const _diagnosisStartedAtMs = Date.now();
        const diagnosisResult = await generateText({
          model: aiProvider,
          system:
            'You are a diagnosis-only agent. You have READ-ONLY tools -- no write/edit/delete/rename capability ' +
            'exists in this pass, so do not attempt to fix or change anything. Your only job: investigate the ' +
            'SPECIFIC task or issue the user described and identify which file(s) are actually relevant to it. ' +
            'Do NOT go looking for other problems elsewhere in the codebase, even if you notice them -- report ' +
            'only what is relevant to this specific request. Call get_build_errors if it would help confirm a ' +
            'cause. End with a short final message naming the relevant file(s) and stating in one sentence what ' +
            'needs to change and why.',
          messages: [{ role: 'user', content: `Diagnose what this request actually requires touching (do not fix or change anything): "${prompt}"` }],
          tools: diagnosisToolSet,
          stopWhen: stepCountIs(8),
          abortSignal: abortController.signal,
        });
        logger.debug('_runAgentLoopInner: diagnose-before-fix generateText call complete', {
          projectId, durationMs: Date.now() - _diagnosisStartedAtMs,
          inputTokens: diagnosisResult.usage?.inputTokens, outputTokens: diagnosisResult.usage?.outputTokens,
          stepCount: diagnosisResult.steps?.length ?? 0,
        });

        if (diagnosisResult.usage) {
          runTokens.inputTokens  += diagnosisResult.usage.inputTokens ?? 0;
          runTokens.outputTokens += diagnosisResult.usage.outputTokens ?? 0;
        }

        // Extract implicated files from actual tool-call arguments, not by
        // parsing the model's prose -- more robust than trusting it followed
        // an exact output format, the same lesson tonight's other fixes
        // already learned the hard way.
        const implicatedFiles = extractImplicatedFiles(diagnosisResult.steps);

        if (shouldSeedScope(implicatedFiles, diagnosisResult.text)) {
          ctx.declaredScope = new Set([...implicatedFiles].map(normalizeScopePath));
          diagnosisContext =
            `# Diagnosis (pre-change investigation pass)\n\n${diagnosisResult.text.trim()}\n\n` +
            `Scope has been seeded with the file(s) above based on this investigation. Stay focused on this ` +
            `request in these files; if the task genuinely requires touching others, call declare_scope ` +
            `again with the wider set and say why.\n\n`;
          logger.info('[AgentLoop] Diagnose-before-fix: implicated file(s), scope seeded', {
            projectId, implicatedFileCount: implicatedFiles.size, implicatedFiles: [...implicatedFiles],
          });
        } else {
          logger.info('[AgentLoop] Diagnose-before-fix: no usable result, falling through unscoped', {
            projectId, implicatedFileCount: implicatedFiles.size, hasText: Boolean(diagnosisResult.text?.trim()),
          });
        }
      } catch (diagnosisErr: any) {
        logger.warn('[AgentLoop] Diagnose-before-fix pass failed (non-fatal, falling through to unscoped behavior)', {
          projectId, error: diagnosisErr?.message, stack: diagnosisErr?.stack,
        });
      }
    }

    let currentUserContent: any = diagnosisContext ? `${diagnosisContext}${boundedPrompt}` : boundedPrompt;
    if (visionCapable && imageVisionData.length > 0) {
      const contentParts: any[] = imageVisionData.map(img => ({
        type: 'image',
        image: img.base64,
        mimeType: img.type,
      }));
      contentParts.push({ type: 'text', text: diagnosisContext ? `${diagnosisContext}${boundedPrompt}` : boundedPrompt });
      currentUserContent = contentParts;
    }

    // ── Observed state, ahead of everything else ──────────────────────────
    // `history` is CLIENT-supplied, so the agent's own past claims -- including
    // false ones -- ride up with every request and cannot be cleaned server
    // side. Changes also reach a project from outside the chat entirely. So
    // rather than trying to correct the history, state what is measurably true
    // now and tell the model it outranks the conversation. See
    // runStateHeader.ts for the incident this comes from.
    //
    // Best-effort and non-blocking: every probe is wrapped, and an unmeasured
    // field is omitted rather than guessed. If nothing can be read the header
    // renders empty and the run proceeds exactly as before.
    let observedStateBlock = '';
    try {
      const previewBase = ctx.previewServiceUrl;
      const [health, standing] = await Promise.all([
        (async (): Promise<{ healthy: boolean | null; errors: string[] }> => {
          try {
            const r = await fetch(`${previewBase}/preview/${projectId}/status`, {
              signal: AbortSignal.timeout(4000),
            });
            if (!r.ok) return { healthy: null, errors: [] };
            const j = await r.json() as { healthy?: boolean; errors?: string[]; diagnosticKind?: string };
            // 'type' diagnostics are advisory TypeScript notes; Vite strips
            // types without checking them, so the app still builds and runs.
            // Reporting those as a broken build would make the header lie in
            // the opposite direction.
            const advisoryOnly = j.diagnosticKind === 'type';
            return {
              healthy: advisoryOnly ? true : Boolean(j.healthy),
              errors: Array.isArray(j.errors) && !advisoryOnly ? j.errors : [],
            };
          } catch { return { healthy: null, errors: [] }; }
        })(),
        (async () => {
          // Only runs that never cleaned up. A completed run's writes still
          // stand and are not 'outstanding' -- counting those grew forever.
          try { return await orphanedEffects(projectId, agentLockToken, 20); } catch { return null; }
        })(),
      ]);

      observedStateBlock = renderRunStateHeader({
        buildHealthy: health.healthy,
        buildErrors: health.errors,
        orphanedEffects: standing
          ? standing.map((e) => ({ kind: e.kind, target: e.target, boundary: e.boundary }))
          : undefined,
        observedAt: new Date(),
      });
    } catch (stateErr) {
      logger.debug('[AgentLoop] observed-state probe failed (non-fatal)', {
        projectId, error: (stateErr as Error).message,
      });
    }

    // Folded into THIS turn's content rather than appended as its own message:
    // history can end on a user turn, and a second consecutive user message is
    // rejected or silently merged depending on the provider. Prepending keeps
    // the message sequence exactly as it was.
    if (observedStateBlock) {
      if (typeof currentUserContent === 'string') {
        currentUserContent = `${observedStateBlock}\n\n${currentUserContent}`;
      } else if (Array.isArray(currentUserContent)) {
        const textIdx = currentUserContent.findIndex((part: any) => part?.type === 'text');
        if (textIdx >= 0) {
          currentUserContent[textIdx] = {
            ...currentUserContent[textIdx],
            text: `${observedStateBlock}\n\n${currentUserContent[textIdx].text ?? ''}`,
          };
        } else {
          currentUserContent.unshift({ type: 'text', text: observedStateBlock });
        }
      }
    }

    let conversationMessages: Array<{ role: 'user' | 'assistant'; content: any; providerOptions?: any }> = [
      ...(history ?? []),
      { role: 'user', content: currentUserContent },
    ];

    // For Anthropic: mark the last history message as a cache breakpoint so the entire
    // prior conversation is served from cache on each subsequent step. Cached input tokens
    // count at ~10% toward the rate limit, reducing 429s on the 30k TPM org tier.
    if (isAnthropicModel && history && history.length > 0) {
      const lastHistoryIdx = history.length - 1;
      conversationMessages = [
        ...conversationMessages.slice(0, lastHistoryIdx),
        { ...conversationMessages[lastHistoryIdx], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        ...conversationMessages.slice(history.length),
      ];
    }

    const MAX_RETRIES = 2;
    let lastStreamError: any = null;

    // Native extended thinking for Anthropic (2026-07-15): lets Claude reason
    // WITHIN the same step/response as its tool call, instead of the current
    // pattern of a full separate `think` tool-call round-trip (a full billed
    // step producing nothing but reasoning) followed by a SECOND step to act
    // on it. Confirmed live: `think` accounted for ~49% of all tool calls
    // across recent runs, some individual calls running 9x over their own
    // stated word budget. `clear_thinking_20251015` uses Anthropic's own
    // server-side context management to drop old thinking turns instead of
    // them accumulating in history forever   deliberately NOT touching the
    // existing compactStepMessages/tool-use compaction in this pass; mixing
    // native and hand-rolled compaction in the same change is a separate,
    // riskier step. The `think` TOOL stays in the toolset (used by non-
    // Anthropic providers, and as a fallback)   this is additive, not a
    // removal, so a mid-run provider fallback away from Anthropic loses
    // nothing.
    const anthropicProviderOptions = {
      thinking: { type: 'adaptive' as const },
      contextManagement: {
        edits: [
          { type: 'clear_thinking_20251015' as const, keep: { type: 'thinking_turns' as const, value: 2 } },
        ],
      },
    };

    // Gemini has no equivalent of Anthropic's adaptive/capped thinking above
    // left unset, gemini-2.5-pro picks its own dynamic budget (uncapped, has
    // hit 5000+ thought tokens on a single step in production). 2048 is a
    // real ceiling, not a guess: still enough for genuine multi-file reasoning,
    // far below the spikes actually observed.
    const GEMINI_THINKING_BUDGET = 2048;

    const attemptStream = async (provider: any, attempt: number, pName = providerName): Promise<ReturnType<typeof streamText>> => {
      // DeepSeek caps max_tokens at 8192; other providers can handle 16384+.
      // Anthropic gets extra headroom when native thinking is active   thinking
      // and the actual response (tool calls, file content) share the same
      // maxOutputTokens ceiling, and a large write_file competing with thinking
      // for the same 16384-token budget raises real truncation risk on exactly
      // the large-file writes already suspected (unconfirmed) of hitting this
      // ceiling. Extra room costs nothing unless actually used.
      const outputLimit = pName === 'deepseek' ? 8192 : pName === 'anthropic' ? 32768 : 16384;
      logger.info('[AgentLoop] attemptStream: calling streamText', {
        projectId, userId, attempt, providerName: pName, modelId, outputLimit, MAX_STEPS,
        conversationMessageCount: conversationMessages.length,
        runTokensSoFar: runTokens.total, runCostUsdSoFar: runCostUsd,
      });
      return streamText({
        model: provider,
        system: buildSystemMessagesFor(pName),
        messages: conversationMessages,
        ...(toolSet ? { tools: toolSet } : {}),
        ...(pName === 'gemini'
          ? {
              providerOptions: {
                google: {
                  ...((geminiRunCacheName || geminiToolCacheName)
                    ? { cachedContent: (geminiRunCacheName || geminiToolCacheName) as string }
                    : {}),
                  thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
                },
              },
            }
          : {}),
        ...(pName === 'anthropic'
          ? { providerOptions: { anthropic: anthropicProviderOptions } }
          : {}),
        maxOutputTokens: outputLimit,
        maxRetries: 0, // We handle retries + fallback ourselves
        // stuckAnalysisAbortReason is a closure over a `let` set inside
        // onStepFinish   checking it here (SDK's own between-steps stop hook)
        // is what actually prevents a new step from being dispatched at all.
        // abortController.abort() alone is NOT enough: it doesn't stop the SDK
        // from starting one more full (billed) step already in flight, whose
        // tool call then gets silently discarded once the abort is noticed  
        // confirmed live 2026-07-14: step 7 called write_file, cost $0.16,
        // and the run still reported "No file operations   skipping preview
        // push" because that step's execute() never actually ran.
        stopWhen: [stepCountIs(MAX_STEPS), () => stuckAnalysisAbortReason !== null],
        abortSignal: abortController.signal,
        // ─── Context window management ─────────────────────────────────
        // Before each step, compact older messages and inject the run's
        // Change Journal so the agent always knows what it has done this run,
        // even after tool-call history is compacted.
        prepareStep: async ({ stepNumber, messages }) => {
          runLedger.setStep(stepNumber);
          const compacted = compactStepMessages(messages, stepNumber, brainMemory);
          const journalBlock = runLedger.buildJournalBlock();

          // When running low on steps, inject a CRITICAL reminder to finish App.tsx and pages.
          // Fires when 5 steps remain (min 3 so it always fires even for small budgets).
          const LOW_STEPS_THRESHOLD = Math.max(3, MAX_STEPS - 5);
          const shouldWarnLowSteps = stepNumber === LOW_STEPS_THRESHOLD;
          const stepsLeft = MAX_STEPS - stepNumber;
          const lowStepsWarning = shouldWarnLowSteps
            ? `\n\n⚠️ STEP BUDGET WARNING: You have ${stepsLeft} steps remaining (used ${stepNumber}/${MAX_STEPS}).\n\nIMMEDIATE PRIORITY   check the file tree right now:\n1. If src/App.tsx is still the Welcome stub → write all missing page files THEN write src/App.tsx IMMEDIATELY. Do NOT write more utility or component files first.\n2. If pages exist but App.tsx is missing routes → fix App.tsx NOW.\n3. If App.tsx is complete → continue normal work.\n\nDo NOT let the step limit expire without writing a proper src/App.tsx. A partial build = broken preview.`
            : '';

          // Mark the second-to-last message as an Anthropic cache breakpoint on every
          // step. Without this, only the pre-run `history` ever got a cache_control
          // marker (see conversationMessages setup above)   everything this run's OWN
          // steps add (tool calls, tool results, think text) was resent uncached on
          // every subsequent step, even once compaction made it byte-stable. Confirmed
          // live 2026-07-15: Claude-fallback runs showed cacheR flat at the pre-run
          // history size across all 9 steps of a run, never growing, while `in` climbed
          // 22k→45k   the run's own history was never once served from cache. Marking
          // the second-to-last message (not the last   the last is what THIS step is
          // about to respond to, still being read fresh) lets the next step's request
          // hit cache for everything up to here, as long as compaction left it unchanged.
          const markAnthropicBreakpoint = (arr: Array<any>): Array<any> => {
            if (!isAnthropicModel || arr.length < 2) return arr;
            const idx = arr.length - 2;
            const out = arr.slice();
            out[idx] = { ...out[idx], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } };
            return out;
          };

          if (journalBlock || lowStepsWarning || circuitBreakerNote) {
            const base = compacted !== messages ? compacted : [...messages];
            // Append at the very end rather than splicing into the middle of the
            // conversation. The journal changes every step (it embeds the step
            // counter), so splicing it mid-history broke the Anthropic/Gemini
            // prompt-cache prefix on every step   the model re-paid full price
            // for the entire conversation instead of getting a cache hit on
            // everything before this step. Appending keeps that whole prefix
            // byte-identical across steps; only this trailing message is new.
            const injectedContent = [journalBlock, lowStepsWarning, circuitBreakerNote].filter(Boolean).join('\n\n');
            circuitBreakerNote = ''; // fire once per detection, not every subsequent step
            const withInjected = markAnthropicBreakpoint([
              ...base,
              { role: 'user' as const, content: injectedContent },
            ]);
            return { messages: withInjected };
          }

          if (compacted !== messages) {
            return { messages: markAnthropicBreakpoint(compacted) };
          }
          return isAnthropicModel ? { messages: markAnthropicBreakpoint(messages) } : {};
        },
        // NOTE: AI SDK v6 renamed `experimental_providerMetadata` to `providerMetadata`
        // (see ai/dist/index.d.ts's StepResult type)   reading the old name here
        // silently always returned undefined, so cache stats (cacheR/cacheW) were
        // always logged as 0 regardless of whether Anthropic actually cached anything.
        onStepFinish: async ({ text, toolCalls, toolResults, usage, providerMetadata, reasoningText }: any) => {
          stepCount++;
          runLedger.setStep(stepCount);
          const toolNames = (toolCalls ?? []).map((tc: any) => tc.toolName);
          logger.info('[AgentLoop] step boundary', {
            projectId, userId, stepCount, maxSteps: MAX_STEPS,
            elapsedRunMs: Date.now() - _innerStartedAtMs,
            toolNames, toolCallCount: toolNames.length,
            stepUsage: usage,
            cumulativeRunTokens: { ...runTokens, total: runTokens.total, billableTotal: runTokens.billableTotal },
            cumulativeRunCostUsd: runCostUsd,
            textPreview: typeof text === 'string' ? text.slice(0, 200) : undefined,
          });
          // Per-tool-call dispatch summary: one debug line per tool invoked this
          // step, pairing the call's (truncated) args with its (truncated) result
          // so a single step's tool activity is greppable without diffing two
          // separate arrays by index.
          for (let _ti = 0; _ti < (toolCalls ?? []).length; _ti++) {
            const _tc = (toolCalls ?? [])[_ti] as any;
            const _tr = (toolResults ?? [])[_ti] as any;
            const _argsStr = (() => { try { return JSON.stringify(_tc?.input ?? _tc?.args ?? {}); } catch { return String(_tc?.input); } })();
            const _outStr = typeof _tr?.output === 'string' ? _tr.output : (() => { try { return JSON.stringify(_tr?.output); } catch { return String(_tr?.output); } })();
            logger.debug('[AgentLoop] tool-call dispatched', {
              projectId, userId, stepCount, toolName: _tc?.toolName,
              argsPreview: _argsStr?.slice(0, 300), argsLength: _argsStr?.length ?? 0,
              resultPreview: _outStr?.slice(0, 300), resultLength: _outStr?.length ?? 0,
            });
          }
          tracer.event('step', {
            step: stepCount,
            text: RunTracer.clip(text ?? ''),
            reasoning: reasoningText ? RunTracer.clip(reasoningText) : undefined,
            toolCalls: (toolCalls ?? []).map((tc: any) => ({ tool: tc.toolName, args: RunTracer.clip(tc.input ?? tc.args) })),
            toolResults: (toolResults ?? []).map((tr: any) => ({ tool: tr.toolName, output: RunTracer.clip(tr.output) })),
            usage,
          });
          // NOTE: AI SDK v6 renamed the tool-result field from `result` to `output`
          // (StaticToolResult/DynamicToolResult in ai/dist/index.d.ts). Both checks
          // below read `.output`   reading `.result` here would silently always be
          // undefined and never match, which is exactly what happened before.
          //
          // ONE failure matcher for all three consumers below (failed-step log
          // marker, circuit breaker, stuck-detector success check). Before this,
          // each had its own prefix subset: the log only matched 'Error' (so
          // 'BLOCKED'/'PREFER EDIT'/'ERROR:' rejections were invisible in ops
          // logs), and the success check missed 'ERROR' (so an actual uppercase
          // write_file failure wrongly counted as progress and reset the stuck
          // counter). Confirmed live 2026-07-21: two 'PREFER EDIT' write_file
          // bounces logged as clean-looking 'tools: write_file' lines.
          // NO CHANGE (write_file's byte-identical guard) counts here even
          // though it is not an error: a write that changed nothing is not
          // progress. Without it, no-op writes reset stepsSinceLastWrite and
          // set anySuccessfulWriteThisRun, which suppresses the
          // unfulfilled-promise gate -- so a run could write the same bytes
          // repeatedly, claim success, and never be caught (CardPro,
          // 2026-08-16: 3 no-op writes, net_new_write_count=0, reported done).
          // Being in this set also lets the circuit breaker trip when the same
          // no-op repeats, which is the behaviour we want.
          const isFailureResult = (s: string) => /^(Error|ERROR|BLOCKED|PREFER EDIT|NO CHANGE)/.test(s);
          const failedEdits = (toolResults ?? [])
            .filter((tr: any) => typeof tr?.output === 'string' && isFailureResult(tr.output))
            .length;

          // ── Tool-failure circuit breaker: detect the SAME error repeating ──
          for (const tr of (toolResults ?? []) as any[]) {
            const toolName = tr?.toolName as string | undefined;
            const result = tr?.output;
            if (!toolName || typeof result !== 'string') continue;

            const isError = isFailureResult(result);
            if (!isError) {
              toolFailureStreak.delete(toolName); // any success/non-error resets the streak
              continue;
            }

            const prev = toolFailureStreak.get(toolName);
            if (prev && prev.message === result) {
              prev.count++;
            } else {
              toolFailureStreak.set(toolName, { message: result, count: 1 });
            }

            const streak = toolFailureStreak.get(toolName)!;
            if (streak.count === CIRCUIT_BREAKER_THRESHOLD) {
              logger.warn('[AgentLoop] Circuit breaker: tool failed with identical error N times in a row', {
                projectId, userId: userId ?? 'unknown', toolName, streakCount: streak.count, errorMessagePreview: streak.message.slice(0, 300),
              });
              circuitBreakerNote =
                `⚠️ REPEATED FAILURE DETECTED: "${toolName}" has now failed ${streak.count} times in a row ` +
                `with the EXACT SAME error:\n\n"${streak.message.slice(0, 300)}"\n\n` +
                `Retrying the same call again will almost certainly fail the same way   this is a structural ` +
                `problem (wrong approach, wrong tier/table, a platform limitation), not something that will ` +
                `resolve by repeating the identical action. STOP retrying this exact approach. Either: ` +
                `(a) diagnose the actual root cause and try something fundamentally different, or ` +
                `(b) tell the user plainly that this is blocked and why, instead of continuing to retry silently.`;
              // Reset so this doesn't re-fire every single step if the model
              // (correctly) keeps trying variations that still happen to fail
              // only re-trip after another full streak of identical repeats.
              toolFailureStreak.delete(toolName);
            }
          }

          // ── Mutation-tool circuit breaker (lifecycle audit fix, 2026-08-11/12) ──
          // The generic breaker above is advisory-only (a note the model can
          // ignore) and keyed by toolName alone. This is the real fix for the
          // incident that motivated it: write_file retried an IDENTICAL failing
          // write to tailwind.config.js 5x in a row (project dfe41091,
          // 2026-08-11 08:52) before the whole run hard-stopped for an unrelated
          // reason (budget-critical). Keyed by tool+PATH (not just tool) and
          // written to ctx.mutationFailureStreak (agent-tools/types.ts), which
          // agentToolSet.ts's dispatch gate reads to actually BLOCK a repeat
          // call to that exact (tool, path) pair -- not just advise against it.
          // Second tier reuses get_build_errors.ts's existing, proven, persistent
          // thrash escalation: a 2nd full trip sets ctx.thrashEscalated, which
          // every downstream consumer in this file already knows how to act on
          // (skip retry loops, override false-resolution claims) -- this is a
          // second PRODUCER for that flag, zero new consumption code.
          for (const tr of (toolResults ?? []) as any[]) {
            const toolName = tr?.toolName as string | undefined;
            const result = tr?.output;
            if (!toolName || !MUTATION_TOOLS.has(toolName) || typeof result !== 'string') continue;
            // DB-action tools (checkpoint 1) have no simple string arg to key
            // on -- resolved via deriveDbMutationKey instead of a raw field.
            // Edge-function tools key on `name` (the function name), same
            // shape as rename_file's `from`/the other file tools' `path`.
            const mutationKey = DB_MUTATION_TOOLS.has(toolName)
              ? deriveDbMutationKey(toolName, tr?.input, ctx)
              : EDGE_FN_MUTATION_TOOLS.has(toolName)
              ? tr?.input?.name
              : (toolName === 'rename_file' ? tr?.input?.from : tr?.input?.path);
            if (typeof mutationKey !== 'string') continue;
            const key = `${toolName}:${mutationKey}`;

            // confirm_database_change's SQL snapshot (see AgentContext.
            // dbMutationSqlByConfirmationId) is one-shot, same as the
            // pendingDbChanges entry it stands in for -- consume it now that
            // the streak key has been derived.
            if (toolName === 'confirm_database_change' && typeof tr?.input?.confirmationId === 'string') {
              ctx.dbMutationSqlByConfirmationId?.delete(tr.input.confirmationId);
            }

            if (!isFailureResult(result)) {
              ctx.mutationFailureStreak?.delete(key); // success clears the block
              continue;
            }

            ctx.mutationFailureStreak = ctx.mutationFailureStreak ?? new Map();
            const prevMut = ctx.mutationFailureStreak.get(key);
            if (prevMut && prevMut.message === result) {
              prevMut.count++;
            } else {
              // A DIFFERENT error for the same path is the model trying something
              // different -- exactly the escape hatch this is meant to allow.
              // Reset, don't accumulate across unrelated attempts.
              ctx.mutationFailureStreak.set(key, { message: result, count: 1 });
            }

            const mutStreak = ctx.mutationFailureStreak.get(key)!;
            if (mutStreak.count >= MUTATION_CIRCUIT_BREAKER_THRESHOLD) {
              logger.warn('[AgentLoop] Mutation circuit breaker: key failed with identical error N times in a row', {
                projectId, userId: userId ?? 'unknown', key, count: mutStreak.count, errorMessagePreview: mutStreak.message.slice(0, 300),
              });
              const fingerprint = computeErrorFingerprint([`${mutationKey}::${mutStreak.message.slice(0, 80)}`]);
              const thrash = await recordThrashTrip(projectId, fingerprint);
              if (thrash.escalate) {
                ctx.thrashEscalated = true;
                ctx.thrashFingerprint = fingerprint;
                ctx.thrashTripCount = thrash.tripCount;
                circuitBreakerNote = (circuitBreakerNote ? `${circuitBreakerNote}\n\n` : '') +
                  `THRASH DETECTED: "${mutationKey}" via ${toolName} has now tripped this circuit breaker ${thrash.tripCount} ` +
                  `times -- a previous "try something different" nudge did NOT work. STOP trying to fix this file yourself. ` +
                  `Do not attempt another rewrite, do not state a new root cause, do not claim this is resolved. End your ` +
                  `response now with an honest status: state plainly you've made ${thrash.tripCount} attempts and it's ` +
                  `still not resolved, briefly describe what you tried, and ask the user for guidance instead of continuing.`;
              }
              // Deliberately NOT deleted (unlike the generic breaker above): the
              // entry must survive so agentToolSet.ts's dispatch gate can see
              // this (tool, path) pair is currently blocked. It clears only on
              // an actual success, or resets on a genuinely different error.
            }
          }

          // ── Stuck-analysis detector: no successful write/edit for N steps ──
          // Must recognize EVERY state-modifying tool, not just write_file/edit_file  
          // a run that's productively calling write_edge_function repeatedly (e.g.
          // building 6 edge functions in a row) was being misclassified as "stuck"
          // and hard-stopped mid-way, even though each call was succeeding. Confirmed
          // live 2026-07-13: a CardPro run called write_edge_function successfully 6
          // times in a row (auth-login, auth-signup, get-cards, get-mystery-cases,
          // get-shops, process-payment) and was killed by this exact check.
          const STATE_MODIFYING_TOOLS = new Set([
            'write_file', 'edit_file', 'write_edge_function', 'confirm_edge_function_deploy',
            'confirm_database_change', 'delete_edge_function', 'delete_file', 'rename_file', 'place_asset',
          ]);
          // run_command is state-modifying ONLY for dependency installs: `npm
          // install` mutates the project, `npx tsc --noEmit` / `npm test` are
          // pure verification. Omitting it entirely meant a successful install
          // never reset stepsSinceLastWrite, so a run that correctly diagnosed
          // a missing package, installed it, then verified the fix was counted
          // as paralysis and hard-stopped -- observed 2026-08-15 as a repeating
          // "install papaparse" loop that could never close itself out (17 of
          // 148 zero-file production runs hit this abort, 8 on system-generated
          // repair prompts). Including it wholesale would be the opposite bug:
          // a run that only ever re-runs tsc would look productive forever and
          // escape the detector entirely.
          const INSTALL_RESULT_RE = /^Command succeeded \((?:npm|yarn|pnpm)\s+(?:install|i|add|uninstall|remove)\b/;
          const isStateModifying = (toolName?: string, result?: unknown): boolean => {
            if (!toolName) return false;
            if (STATE_MODIFYING_TOOLS.has(toolName)) return true;
            return toolName === 'run_command' && typeof result === 'string' && INSTALL_RESULT_RE.test(result);
          };
          // DIAGNOSTIC (2026-07-21): three consecutive Anthropic runs showed
          // write_file steps that looked successful in the log yet never reset
          // stepsSinceLastWrite   the detector then fired on productive runs.
          // Log the exact shape+prefix of every state-modifying tool result so
          // the next occurrence shows WHY it wasn't counted, instead of a 4th
          // round of hypothesis. Cheap (only fires on write-ish tools); remove
          // once the counter bug is confirmed fixed.
          for (const tr of (toolResults ?? []) as any[]) {
            const tn = tr?.toolName as string | undefined;
            if (!isStateModifying(tn, tr?.output)) continue;
            const out = tr?.output;
            logger.debug('[AgentLoop][write-audit] state-modifying tool result', {
              projectId, stepCount, toolName: tn, outputType: typeof out,
              outputPrefix: typeof out === 'string' ? out.slice(0, 80) : undefined,
              outputShape: typeof out !== 'string'
                ? (out === null ? 'null' : Array.isArray(out) ? 'array' : out && typeof out === 'object' ? `object keys=[${Object.keys(out).slice(0, 6).join(',')}]` : String(out))
                : undefined,
            });
          }
          const hadSuccessfulWriteThisStep = (toolResults ?? []).some((tr: any) => {
            const toolName = tr?.toolName as string | undefined;
            const result = tr?.output;
            if (!isStateModifying(toolName, result)) return false;
            // A structured (non-string) output is still a tool RESULT   only
            // string results carry our Error/BLOCKED prefixes, so treat any
            // non-string output from a state-modifying tool as success rather
            // than silently ignoring it (candidate cause of the reset bug).
            if (typeof result !== 'string') return true;
            return !isFailureResult(result);
          });
          // Track guard/tool rejections of WRITE attempts separately from pure
          // analysis paralysis: a run that repeatedly TRIED to write but was
          // bounced (BLOCKED / PREFER EDIT / ERROR) is a different failure than
          // one that never attempted a write   and the user-facing abort message
          // must say so instead of asking them for "a more specific instruction".
          for (const tr of (toolResults ?? []) as any[]) {
            const toolName = tr?.toolName as string | undefined;
            const result = tr?.output;
            if (toolName && STATE_MODIFYING_TOOLS.has(toolName) && typeof result === 'string' && isFailureResult(result)) {
              rejectedWriteAttempts.push(`${toolName} → ${result.slice(0, 120)}`);
            }
          }
          if (hadSuccessfulWriteThisStep) {
            stepsSinceLastWrite = 0;
            anySuccessfulWriteThisRun = true;
            // Invalidate any prior "healthy" verification: it was true of the
            // code as it stood BEFORE this write. A stale ctx.lastBuildErrorsHealthy
            // === true from an earlier get_build_errors call must not let a LATER
            // resolution claim skip verification just because the run checked out
            // healthy at some earlier point before more edits landed. This is what
            // closes the closure-claim gate below over silently-stale verification;
            // see that gate's comment for the full reasoning.
            ctx.lastBuildErrorsHealthy = undefined;
            // A successful write proves the model isn't stuck — any nudge fired
            // during an earlier, now-resolved investigation phase shouldn't count
            // against a later, unrelated one. Without this reset, a run that
            // investigates for 3 steps, writes successfully, then investigates
            // the NEXT file for 3 more steps (completely normal multi-file work)
            // hits the hard-stop on the second phase purely because it "used up"
            // its nudge budget on the first — killing productive runs, not stuck ones.
            stuckAnalysisFireCount = 0;
          } else {
            stepsSinceLastWrite++;
          }

          // ── Think-streak nudge: catch redundant re-reasoning early ─────────
          const stepToolNames = (toolCalls ?? []).map((tc: any) => tc?.toolName).filter(Boolean);
          const wasThinkOnlyStep = stepToolNames.length > 0 && stepToolNames.every((n: string) => n === 'think');
          if (wasThinkOnlyStep) {
            consecutiveThinkOnlySteps++;
            const currentThought = (toolCalls ?? []).find((tc: any) => tc?.toolName === 'think')?.input?.thought;
            if (typeof currentThought === 'string' && lastThinkThought
                && thinkContentSimilarity(currentThought, lastThinkThought) >= 0.55) {
              consecutiveSimilarThinkSteps++;
            } else {
              consecutiveSimilarThinkSteps = 0;
            }
            lastThinkThought = typeof currentThought === 'string' ? currentThought : null;
          } else {
            consecutiveThinkOnlySteps = 0;
            consecutiveSimilarThinkSteps = 0;
            lastThinkThought = null;
          }
          if (consecutiveThinkOnlySteps >= 2 && stepCount - thinkStreakNoteFiredAt >= 2) {
            thinkStreakNoteFiredAt = stepCount;
            const thinkStreakNote =
              `You've called \`think\` ${consecutiveThinkOnlySteps} times in a row with no other tool in between. ` +
              `If you already worked out what to change, stop reasoning and call write_file/edit_file/etc. now   ` +
              `don't re-derive the same conclusion again. If you genuinely need to keep exploring across several ` +
              `steps, call \`save_memory\` with the key facts now so you don't have to re-think them next step.`;
            circuitBreakerNote = circuitBreakerNote ? `${circuitBreakerNote}\n\n${thinkStreakNote}` : thinkStreakNote;
          }

          // ── Phantom-action narration breaker ─────────────────────────────────
          const PHANTOM_CLAIM_RE = /\b(I(?:'ve| have)\s+(?:now\s+)?(?:created|updated|added|removed|changed|implemented|fixed|applied|completed|secured|written|wired)|ha(?:s|ve)\s+been\s+(?:created|updated|added|removed|applied|saved|completed|secured))\b/i;
          if (runtimeMode === 'build' && stepToolNames.length === 0 && typeof text === 'string' && PHANTOM_CLAIM_RE.test(text)) {
            consecutivePhantomClaimSteps++;
            // Real-signal gating (harness redesign, increment 1): a build that
            // get_build_errors has ALREADY confirmed broken this run, combined
            // with the model narrating completed work while calling zero tools,
            // is a stronger stuck signal than either alone -- don't wait for the
            // full default streak when the code is already known not to work.
            const phantomAbortThreshold = phantomAbortThresholdFor(ctx.lastBuildErrorsHealthy);
            if (consecutivePhantomClaimSteps >= phantomAbortThreshold) {
              logger.warn('[AgentLoop] Aborting: consecutive no-tool steps claiming completed work (phantom narration)', {
                projectId, userId, stepCount, consecutivePhantomClaimSteps, phantomAbortThreshold,
                buildAlreadyConfirmedBroken: ctx.lastBuildErrorsHealthy === false,
              });
              budgetAbortReason = `phantom narration: ${phantomAbortThreshold} consecutive steps claimed completed work without calling any tools`;
              abortController.abort();
            } else {
              const phantomNote =
                `STOP: your last message claimed completed work ("I've created/updated...") but you called ZERO tools ` +
                `this step. Nothing was created, updated, or saved -- files only change through write_file/edit_file/` +
                `delete_file calls. Do not describe the work again and do not apologize. In your NEXT step, output the ` +
                `tool calls that actually perform it. Announce intent in one short line at most ("Doing: X, Y"), and ` +
                `never use past tense before the tools have run.`;
              circuitBreakerNote = circuitBreakerNote ? `${circuitBreakerNote}\n\n${phantomNote}` : phantomNote;
            }
          } else if (stepToolNames.length > 0) {
            consecutivePhantomClaimSteps = 0;
          }

          // ── Root-cause-lock (fix tier only) ──────────────────────────────────
          // Diagnosis-before-write only gates the FIRST write of a run (see
          // agentToolSet.ts): once get_build_errors has been called once, every
          // later write is unguarded, including one that acts on a THIRD or
          // SIXTH silently-substituted root cause. This closes that gap: the
          // first post-diagnosis `think` this run is locked in as the active
          // hypothesis; a later `think` that diverges from it (low similarity)
          // without either the active hypothesis's fix being verified healthy,
          // or explicit falsification language, is a silent pivot that blocks
          // the next write_file/edit_file until the model reconciles.
          if (_tier === 'fix' && (ctx.buildErrorCallCount ?? 0) > 0) {
            const thinkCallThisStep = (toolCalls ?? []).find((tc: any) => tc?.toolName === 'think');
            const thought = thinkCallThisStep?.input?.thought;
            if (typeof thought === 'string' && thought.trim().length > 0) {
              if (!ctx.activeHypothesis) {
                ctx.activeHypothesis = thought;
                ctx.rootCauseLockViolation = false;
              } else if (thinkContentSimilarity(thought, ctx.activeHypothesis) >= 0.55) {
                // Same hypothesis, still being reasoned about   fine, no action.
              } else if (ctx.lastBuildErrorsHealthy === true) {
                // Active hypothesis's fix was already verified healthy   this is
                // a new think about a NEW issue, not an abandoned diagnosis.
                ctx.activeHypothesis = thought;
                ctx.rootCauseLockViolation = false;
              } else if (FALSIFICATION_RE.test(thought)) {
                // Legitimate pivot: the model explained what evidence showed the
                // active hypothesis was wrong before moving to a new one.
                ctx.activeHypothesis = thought;
                ctx.rootCauseLockViolation = false;
              } else {
                // Silent pivot: a different, unverified hypothesis with no
                // falsification of the one it's replacing.
                ctx.rootCauseLockViolation = true;
                ctx.rootCauseLockTriggerCount = (ctx.rootCauseLockTriggerCount ?? 0) + 1;
                logger.warn('[RootCauseLock] Silent hypothesis pivot detected', {
                  projectId, userId: userId ?? 'unknown', stepCount, triggerCount: ctx.rootCauseLockTriggerCount,
                  activeHypothesisPreview: ctx.activeHypothesis?.slice(0, 200), newThoughtPreview: thought.slice(0, 200),
                });
                const rootCauseLockNote =
                  `You just stated a different explanation for this bug without confirming your previous one was fixed ` +
                  `and verified, or saying what evidence showed it was wrong. Before writing any more code: either (1) ` +
                  `state specifically what you observed that shows the earlier hypothesis was incorrect, or (2) if the ` +
                  `earlier hypothesis was actually right, go verify and finish that fix instead of pivoting away from it. ` +
                  `Don't silently abandon a diagnosis.`;
                circuitBreakerNote = circuitBreakerNote ? `${circuitBreakerNote}\n\n${rootCauseLockNote}` : rootCauseLockNote;
              }
            }
          }

          // ── Over-budget think nudge ─────────────────────────────────────────
          // think.ts's own description sets a 60/400-word budget depending on task
          // size, but that's just prompt text   nothing enforces it. Confirmed live
          // 2026-07-15: a single think call ran to 4,661 OUTPUT tokens (~3,500+
          // words), ~9x over even the 400-word ceiling, on a step that produced zero
          // code. Can't un-bill tokens already generated, but a same-run corrective
          // nudge measurably shortens the NEXT think call   cheaper than hoping the
          // static prompt line gets followed, which it evidently isn't.
          const OVERBUDGET_WORD_THRESHOLD = 600;
          for (const tc of (toolCalls ?? []) as any[]) {
            if (tc?.toolName !== 'think') continue;
            const thought = tc?.input?.thought;
            if (typeof thought !== 'string') continue;
            const wordCount = thought.trim().split(/\s+/).filter(Boolean).length;
            if (wordCount > OVERBUDGET_WORD_THRESHOLD) {
              const overBudgetNote =
                `Your last \`think\` call was ~${wordCount} words   way over the 60/400-word budget in that tool's ` +
                `own instructions. Long reasoning text doesn't improve the outcome and burns real cost. Keep future ` +
                `think calls to short bullet points, not prose paragraphs.`;
              circuitBreakerNote = circuitBreakerNote ? `${circuitBreakerNote}\n\n${overBudgetNote}` : overBudgetNote;
              break; // one nudge per step is enough even if multiple think calls happened
            }
          }
          // Budget-aware early exit: with prompt caching disabled (cacheR is
          // consistently 0   see cost audit), every step re-pays for the FULL
          // context from scratch, so cumulative usage can compound past the
          // token cap well before STUCK_ANALYSIS_HARD_STOP_FIRINGS worth of
          // steps elapses (observed 2026-07-12: cap hit at step 12, before the
          // 3rd nudge at step 18 could ever fire). If we're already stuck AND
          // already deep into the budget, don't wait for more nudges to be
          // ignored   stop now, before the run burns the rest for nothing.
          const stuckAndBudgetCritical =
            stepsSinceLastWrite >= STUCK_ANALYSIS_THRESHOLD && runTokens.billableTotal > RUN_TOKEN_CAP * 0.65;
          // Content-based fast path: three consecutive `think` calls that
          // restate near-identical reasoning (>=0.55 word-overlap) is a much
          // stronger stuck signal than step-count alone, and short-circuits
          // straight to hard-stop instead of waiting for STUCK_ANALYSIS_THRESHOLD
          // steps AND multiple ignored nudges   real multi-file investigation
          // always produces different reasoning text per step, so this can't
          // false-positive on the legitimate case the threshold history above
          // was tuned to protect.
          const stuckAndContentRepeating = consecutiveSimilarThinkSteps >= 3;
          // Real-signal gating (harness redesign, increment 1): get_build_errors
          // has ALREADY confirmed this run's build is broken -- don't wait for
          // 65% of the token budget to burn (stuckAndBudgetCritical's threshold)
          // when we already know for a fact nothing is landing and the code
          // doesn't work. This is tonight's incident shape: budget burning with
          // no successful write while the build is confirmed unhealthy.
          const stuckAndBuildKnownBroken =
            isStuckAndBuildKnownBroken(stepsSinceLastWrite, STUCK_ANALYSIS_THRESHOLD, ctx.lastBuildErrorsHealthy);
          if (
            stuckAndBudgetCritical ||
            stuckAndContentRepeating ||
            stuckAndBuildKnownBroken ||
            (
              stepsSinceLastWrite >= STUCK_ANALYSIS_THRESHOLD &&
              stepCount - stuckAnalysisNoteFiredAt >= STUCK_ANALYSIS_THRESHOLD
            )
          ) {
            stuckAnalysisFireCount++;
            stuckAnalysisNoteFiredAt = stepCount;
            if (stuckAndBudgetCritical || stuckAndContentRepeating || stuckAndBuildKnownBroken || stuckAnalysisFireCount >= STUCK_ANALYSIS_HARD_STOP_FIRINGS) {
              logger.warn('[AgentLoop] Stuck-analysis hard stop', {
                projectId, userId: userId ?? 'unknown', stepsSinceLastWrite,
                reasonKind: stuckAndBudgetCritical ? 'budget-critical' : stuckAndContentRepeating ? 'content-repeating' : stuckAndBuildKnownBroken ? 'build-known-broken' : 'ignored-nudges',
                budgetCriticalTokens: stuckAndBudgetCritical ? runTokens.total : undefined,
                runTokenCap: RUN_TOKEN_CAP,
                nearIdenticalThinkCalls: stuckAndContentRepeating ? consecutiveSimilarThinkSteps : undefined,
                ignoredNudges: !stuckAndBudgetCritical && !stuckAndContentRepeating && !stuckAndBuildKnownBroken ? stuckAnalysisFireCount - 1 : undefined,
              });
              stuckAnalysisAbortReason = stuckAndContentRepeating
                ? `stuck repeating near-identical reasoning for ${consecutiveSimilarThinkSteps} steps in a row`
                : stuckAndBuildKnownBroken
                  ? `stuck analyzing without making a change for ${stepsSinceLastWrite} steps, and the build is confirmed broken`
                  : `stuck analyzing without making a change for ${stepsSinceLastWrite} steps`;
              generateStatus(projectId, { kind: 'lifecycle', phase: 'budget-reached' }).then((s) => {
                if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
              }).catch(() => {});
              abortController.abort();
            } else {
              logger.warn('[AgentLoop] Stuck-analysis detector fired (soft nudge)', {
                projectId, userId: userId ?? 'unknown', stepsSinceLastWrite, stuckAnalysisFireCount,
              });
              const stuckNote =
                `⚠️ STUCK IN ANALYSIS: You've spent ${stepsSinceLastWrite} steps reading/checking/reasoning without ` +
                `a single write_file or edit_file actually landing. Re-reading the same file or re-stating the same ` +
                `diagnosis in different words is NOT progress. Right now, on your very next step: either call ` +
                `write_file/edit_file with your best understanding of the fix   even if you're not 100% certain   or, ` +
                `if you genuinely cannot determine the fix, STOP and tell the user plainly what's blocking you instead ` +
                `of continuing to investigate silently. This is your final warning before the run is stopped automatically.`;
              circuitBreakerNote = circuitBreakerNote ? `${circuitBreakerNote}\n\n${stuckNote}` : stuckNote;
            }
          }

          // ── Surface real agent reasoning to the UI ──────────────────────
          // The `think` tool's actual argument (the model's real reasoning) used
          // to be discarded entirely   thinkTool.execute ignores its args and just
          // returns "OK", so the user never saw real thinking, only generic canned
          // status strings. Emit it as a dedicated, live-only SSE event so the
          // frontend can show the real content transiently   never persisted to
          // the saved chat transcript.
          for (const tc of (toolCalls ?? []) as any[]) {
            if (tc?.toolName === 'think' && tc?.input?.thought) {
              sink.emit('agent-thinking', { step: stepCount, thought: String(tc.input.thought) });
            }
          }
          // Native Anthropic extended-thinking text (see anthropicProviderOptions
          // above)   same SSE event as the think tool, so the frontend needs no
          // changes to display it. Only present on steps where Claude actually
          // used native reasoning in place of (or alongside) a think tool call.
          if (typeof reasoningText === 'string' && reasoningText.trim()) {
            sink.emit('agent-thinking', { step: stepCount, thought: reasoningText.trim() });
          }

          // ── Token accounting for this step ────────────────────────────
          const stepInpRaw = (usage?.promptTokens     ?? usage?.inputTokens     ?? 0) as number;
          const stepOut    = (usage?.completionTokens ?? usage?.outputTokens    ?? 0) as number;
          const { cacheRead: stepCacheR, cacheWrite: stepCacheW } = extractCacheUsage(providerMetadata);
          // Gemini reports promptTokens as the FULL prompt (fresh + cached combined)  
          // cachedContentTokenCount is a SUBSET of it, not an additional amount. Anthropic
          // is the opposite: input_tokens is fresh-only, cache_read_input_tokens is a
          // genuinely separate additive count (confirmed against @ai-sdk/anthropic's own
          // convertAnthropicMessagesUsage   inputTokens = usage.input_tokens directly, no
          // cache folded in). Adding stepInpRaw AND stepCacheR into the running total
          // unconditionally double-counted every Gemini cache-read token   confirmed live
          // 2026-07-15: a run logged cost $1.0018, but recomputing with cache correctly
          // treated as a subset (not additive) gives $0.4826   the buggy formula was
          // inflating Gemini run cost by ~2x, silently, since Gemini caching started
          // working. This has been true since before today's token-cap change; the cap
          // increase just made the inflated total visible sooner by letting runs go longer.
          const isGeminiStep = Boolean(providerMetadata?.google);
          const stepInp = isGeminiStep ? Math.max(0, stepInpRaw - stepCacheR) : stepInpRaw;

          runTokens.inputTokens      += stepInp;
          runTokens.outputTokens     += stepOut;
          runTokens.cacheReadTokens  += stepCacheR;
          runTokens.cacheWriteTokens += stepCacheW;

          // Price at the model that actually served this step (attemptStream's
          // `provider` closure)   NOT the run's requested modelId. Fallback
          // steps used to be silently billed at Claude rates.
          const servingModelId = String((provider as any)?.modelId ?? modelId);
          const p = priceFor(servingModelId);
          const stepCost = (stepInp * p.input + stepOut * p.output + stepCacheR * p.cacheRead + stepCacheW * p.cacheWrite) / 1_000_000;
          runCostUsd += stepCost;
          const runCost = runCostUsd;

          // Status narration is now handled in real-time by the status service
          // (generateStatus) on each tool-call stream part   see the tool-call
          // handler in consumeResultStream. The step-finish event below carries
          // token accounting only; no canned status string is emitted here.

          sink.emit('step-finish', {
            step: stepCount,
            hasText: !!text,
            toolCount: toolNames.length,
            tools: toolNames,
            failedEdits,
            tokens: {
              step:  { input: stepInp, output: stepOut, cacheRead: stepCacheR, cacheWrite: stepCacheW, total: stepInp + stepOut + stepCacheR + stepCacheW },
              run:   { input: runTokens.inputTokens, output: runTokens.outputTokens, cacheRead: runTokens.cacheReadTokens, cacheWrite: runTokens.cacheWriteTokens, total: runTokens.total },
              stepCostUsd: parseFloat(stepCost.toFixed(5)),
              runCostUsd:  parseFloat(runCost.toFixed(5)),
            },
          });

          logger.info('[AgentLoop] step summary', {
            projectId, userId, stepCount, providerName: pName, servingModelId,
            tools: toolNames, failedEdits,
            tokens: { in: stepInp, out: stepOut, cacheR: stepCacheR, cacheW: stepCacheW },
            stepCostUsd: parseFloat(stepCost.toFixed(5)), runTotalCostUsd: parseFloat(runCost.toFixed(4)),
            isInternalRun,
          });

          // ── Per-run hard caps ────────────────────────────────────────────
          // Two gates: token count + dollar cost. Whichever fires first aborts the run.
          // Token cap is tier-based (RUN_TOKEN_CAP) so build gets more headroom than micro.
          // Cost cap is a hard ceiling regardless of tier.
          const HARD_COST_CAP = isInternalRun
            ? parseFloat(process.env.AGENT_COST_CAP_USD_INTERNAL || process.env.AGENT_COST_CAP_USD || '1.50')
            : parseFloat(process.env.AGENT_COST_CAP_USD || '1.50');
          if (runTokens.billableTotal > RUN_TOKEN_CAP || runCost > HARD_COST_CAP) {
            const reason = runCost > HARD_COST_CAP
              ? `cost cap $${HARD_COST_CAP} hit ($${runCost.toFixed(3)} spent)`
              : `token cap ${RUN_TOKEN_CAP} hit (${runTokens.billableTotal} billable-weighted, ${runTokens.total} raw)`;
            logger.warn('[AgentLoop] Run aborted: budget cap hit', {
              projectId, userId: userId ?? 'unknown', reason, runCostUsd: runCost, HARD_COST_CAP,
              runTokensBillable: runTokens.billableTotal, RUN_TOKEN_CAP,
            });
            budgetAbortReason = reason;
            generateStatus(projectId, { kind: 'lifecycle', phase: 'budget-reached' }).then((s) => {
              if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
            }).catch(() => {});
            abortController.abort();
          }
        },
      });
    };

    const consumeResultStream = async (stream: ReturnType<typeof streamText>): Promise<{ text: string; err: any | null }> => {
      let textBuffer = '';
      let partError: any = null;
      let lastFinishReason: string | undefined;
      // Withholds announce-then-do narration from the user-facing stream. The
      // prompt bans it in every tier and is ignored; this enforces it instead
      // of asking again. Per STEP, so a sentence never straddles a tool call.
      // textBuffer is deliberately left unfiltered -- it feeds the model's own
      // context and the completion-claim gates, which must still see exactly
      // what was generated.
      const narration = new NarrationFilter();
      try {
        for await (const part of stream.fullStream) {
          if (part.type === 'text-delta') {
            textBuffer += part.text;
            const safeText = sanitizeUserFacingDelta(part.text);
            if (safeText) {
              const visible = narration.push(safeText);
              if (visible) sink.emit('text-delta', { text: visible });
            }
          } else if (part.type === 'tool-call') {
            // ── Real-time narration microservice ──────────────────────────
            // The model just decided to call a tool   narrate it NOW, in human
            // words, before the tool runs. Captures think() reasoning so the
            // narrator is grounded in the agent's actual intent. Fire-and-forget,
            // 2.5s capped, never blocks the stream.
            const tcArgs = (part as any).args ?? {};
            const tcName = (part as any).toolName ?? '';
            if (tcName === 'think' && typeof tcArgs.thought === 'string') {
              updateThought(projectId, tcArgs.thought);
            }
            if (!abortController.signal.aborted) {
              generateStatus(projectId, { kind: 'tool', toolName: tcName, args: tcArgs }).then((status) => {
                if (status && !abortController.signal.aborted) {
                  sink.emit('agent-narration', { narration: status });
                }
              }).catch(() => { /* status service must never break the run */ });
            }
          } else if (part.type === 'finish') {
            lastFinishReason = (part as any).finishReason;
            outerFinishReason = lastFinishReason;
            // Final overall finish   log cumulative run totals (onStepFinish already
            // captured per-step detail; this is the authoritative end-of-run summary).
            const u    = (part as any).usage;
            const finishCache = extractCacheUsage((part as any).providerMetadata);
            // Prefer values accumulated in runTokens (most complete); fall back to stream finish.
            const totalIn  = runTokens.inputTokens      || (u?.promptTokens     ?? u?.inputTokens     ?? 0);
            const totalOut = runTokens.outputTokens     || (u?.completionTokens ?? u?.outputTokens    ?? 0);
            const totalCR  = runTokens.cacheReadTokens  || finishCache.cacheRead;
            const totalCW  = runTokens.cacheWriteTokens || finishCache.cacheWrite;
            // Accumulated per-step (serving-model-priced) when available;
            // calcCost only as fallback for streams onStepFinish never saw.
            const totalCost = runCostUsd > 0 ? runCostUsd : calcCost(totalIn, totalOut, totalCR, totalCW);
            logger.info('[AgentLoop] RUN COMPLETE', {
              projectId, userId, agentRunId,
              inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: totalCR, cacheWriteTokens: totalCW,
              totalTokens: totalIn + totalOut + totalCR + totalCW,
              estCostUsd: parseFloat(totalCost.toFixed(4)), finishReason: lastFinishReason ?? 'unknown',
            });
            tracer.event('run-end', {
              inputTokens: totalIn, outputTokens: totalOut, cacheRead: totalCR, cacheWrite: totalCW,
              costUsd: Number(totalCost.toFixed(4)), finishReason: lastFinishReason ?? 'unknown', steps: stepCount,
            });
            // Warn when model produces nothing   helps diagnose Gemini empty-response issues
            if (totalOut === 0) {
              logger.warn('[AgentLoop] Model produced 0 output tokens', {
                projectId, userId, finishReason: lastFinishReason ?? 'unknown', providerName, modelId,
              });
            }
          } else if (part.type === 'error') {
            partError = part.error;
          }
        }
      } catch (iterErr: any) {
        // Undici throws TypeError: terminated / ECONNRESET directly from the async iterator
        // instead of emitting a part.type === 'error'. Capture it so it goes through the
        // streamError recovery path (fallback providers) rather than the outer catch.
        partError = iterErr;
      }
      // Release any trailing sentence that never got a terminator -- a final
      // answer must not be swallowed just because it lacked a full stop. Also
      // logs what was withheld, so this filter's effect is observable rather
      // than a silent edit of the agent's voice.
      const tail = narration.flush();
      if (tail) sink.emit('text-delta', { text: tail });
      if (narration.suppressed > 0) {
        logger.debug('[AgentLoop] suppressed process narration', {
          projectId, sentences: narration.suppressed,
        });
      }
      return { text: textBuffer, err: partError };
    };

    let result: ReturnType<typeof streamText> | null = null;
    let outerFinishReason: string | undefined;

    // Primary model: retry with exponential backoff (skip retries for network errors)
    logger.debug('[AgentLoop] primary-provider retry loop starting', { projectId, userId, providerName, modelId, MAX_RETRIES });
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await attemptStream(streamingProvider, attempt);
        // Test the stream by consuming the first chunk   if it throws, we catch it here
        lastStreamError = null;
        break;
      } catch (err: any) {
        lastStreamError = err;
        if (abortController.signal.aborted) throw err; // Don't retry on abort
        if (providerName === 'anthropic' && isRateLimitError(err)) {
          logger.warn('[AgentLoop] Anthropic rate-limited, skipping same-provider retries and switching to fallback', {
            projectId, userId, attempt, errorMessage: err?.message,
          });
          generateStatus(projectId, { kind: 'lifecycle', phase: 'provider-fallback' }).then((s) => {
            if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
          }).catch(() => {});
          break;
        }
        // Network errors (DNS, connection refused) won't resolve with retries   go straight to fallback.
        if (isNetworkError(err)) {
          logger.warn('[AgentLoop] Network error on provider, skipping retries, going to fallback', {
            projectId, userId, providerName, attempt, errorMessage: err?.message,
          });
          break;
        }
        // Auth/billing errors (org disabled, 401, 403) won't resolve with retries   go straight to fallback.
        if (isAuthOrBillingError(err)) {
          tripBillingCircuit(providerName);
          logger.warn('[AgentLoop] Auth/billing error on provider, circuit-breaking provider for this session', {
            projectId, userId, providerName, attempt, errorMessage: err?.message,
          });
          break;
        }
        if (!isRetryableError(err) || attempt === MAX_RETRIES) break;
        // Rate limits (429) need longer backoff. Honor the retry-after header from Anthropic.
        // If retry-after is meaningfully long it's better to fall back than hold the UI open.
        const retryAfterMs = isRateLimitError(err) ? getRetryAfterMs(err) : null;
        if (retryAfterMs !== null && retryAfterMs > 10_000) {
          logger.warn('[AgentLoop] Rate limit with long retry-after, skipping retries, trying fallback providers', {
            projectId, userId, providerName, attempt, retryAfterSec: Math.ceil(retryAfterMs / 1000),
          });
          break;
        }
        // Other retryable errors (500/529/overloaded) use shorter backoff (2s/4s/8s).
        const delay = isRateLimitError(err)
          ? (retryAfterMs ?? Math.min(3000 * Math.pow(2, attempt), 10_000)) // honor header, else 3s/6s/10s
          : Math.min(1000 * Math.pow(2, attempt), 8000);  // 1s, 2s, 4s, max 8s
        logger.warn('[AgentLoop] Retryable error, retrying', {
          projectId, userId, providerName, attempt: attempt + 1, maxRetries: MAX_RETRIES + 1,
          errorMessage: err?.message ?? String(err), delayMs: delay,
        });
        // Show retry status in activity log, NOT in the chat text
        generateStatus(projectId, { kind: 'lifecycle', phase: 'rate-limit-retry', detail: `${Math.round(delay / 1000)}s` }).then((s) => {
          if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
        }).catch(() => {});
        await new Promise<void>(r => setTimeout(r, delay));
      }
    }

    // If primary failed (retryable, network, auth/billing, or model-not-found), try fallback providers
    const isModelNotFound = (() => {
      const status = lastStreamError?.status ?? lastStreamError?.statusCode;
      const msg = [lastStreamError?.message, lastStreamError?.responseBody].filter(Boolean).join(' ').toLowerCase();
      return status === 404 || msg.includes('not found') || msg.includes('does not exist') || msg.includes('model_not_found') || msg.includes('invalid model');
    })();
    // Never fail over when WE aborted the run (stuck-analysis stop, token/
    // cost cap): the abort surfaces as a retryable-looking stream error, and
    // failing over restarts the whole loop from step 1 on the next provider
    // with zero context reuse. Confirmed live 2026-08-16 (CardPro fix run):
    // stuck-stop at 556K tokens on gemini -> full restart on anthropic ->
    // $1.44 of pure re-reading -> token cap abort. A governor stop is final.
    const governorAborted = stuckAnalysisAbortReason !== null || budgetAbortReason !== null;
    if (!governorAborted && lastStreamError && (isRetryableError(lastStreamError) || isNetworkError(lastStreamError) || isAuthOrBillingError(lastStreamError) || isModelNotFound)) {
      // Build a prioritised list of fallback candidates. Gemini-to-Gemini fallback is
      // now allowed (different model) so a bad gemini-2.5-pro can fall to gemini-flash-latest.
      const fallbackCandidates = buildFallbackCandidates(providerName, modelId);
      logger.info('[AgentLoop] primary provider failed, trying fallback candidates', {
        projectId, userId, primaryProviderName: providerName, primaryModelId: modelId,
        fallbackCandidateCount: fallbackCandidates.length, fallbackCandidates,
        lastStreamErrorMessage: lastStreamError?.message,
      });
      for (const fallbackModelId of fallbackCandidates) {
        const fallbackInfo = createProviderForModel(fallbackModelId);
        if (!fallbackInfo) continue;
        logger.warn('[AgentLoop] Primary provider failed, falling back', {
          projectId, userId, primaryProviderName: providerName, fallbackProviderName: fallbackInfo.providerName, fallbackModelId,
        });
        // Keep fallback behavior, but optionally suppress recovery UI noise.
        if (!SUPPRESS_RECOVERY_UI) {
          generateStatus(projectId, { kind: 'lifecycle', phase: 'provider-fallback', detail: fallbackInfo.providerName }).then((s) => {
            if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
          }).catch(() => {});
        }
        try {
          result = await attemptStream(fallbackInfo.provider, 0, fallbackInfo.providerName);
          lastStreamError = null;
          providerFellBackThisRun = true;
          logger.info('[AgentLoop] fallback provider succeeded', { projectId, userId, fallbackProviderName: fallbackInfo.providerName, fallbackModelId });
          break; // fallback succeeded
        } catch (fallbackErr: any) {
          logger.warn('[AgentLoop] Fallback provider also failed', {
            projectId, userId, fallbackProviderName: fallbackInfo.providerName, fallbackModelId, errorMessage: fallbackErr?.message,
          });
          lastStreamError = fallbackErr;
        }
      }
    }

    if (lastStreamError || !result) {
      const isRateLimit = isRateLimitError(lastStreamError);
      const retryAfterMs = isRateLimit ? getRetryAfterMs(lastStreamError) : null;
      let errMsg = 'Model orchestration exhausted all available providers. Please try again.';
      if (isRateLimit && retryAfterMs && retryAfterMs > 30_000) {
        const waitSec = Math.ceil(retryAfterMs / 1000);
        errMsg = `AI rate limit exceeded   too many tokens this minute. Please wait ~${waitSec} seconds and try again.`;
      } else if (lastStreamError) {
        const detail = sanitizeErrorMessage(lastStreamError);
        errMsg = `${errMsg} Last provider error: ${detail}`;
      }
      logger.error('[AgentLoop] Model orchestration exhausted all providers', {
        projectId, userId, isRateLimit, retryAfterMs, lastStreamErrorMessage: lastStreamError?.message,
      });
      const err = new Error(errMsg);
      (err as any).sseErrorEmitted = false;
      throw err;
    }

    // Consume streaming output directly for better parity with the local agent handler.
    // This avoids relying on result.text, which can throw AI_NoOutputGeneratedError.
    const firstConsume = await consumeResultStream(result);
    accumulatedText += firstConsume.text;
    streamError = firstConsume.err;

    // Recovery path: transient transport drops can emit undici "terminated" / ECONNRESET
    // after stream start. Retry once via fallback providers before failing the run.
    if (streamError && !abortController.signal.aborted && (isNetworkError(streamError) || isAuthOrBillingError(streamError))) {
      const isBillingErr = isAuthOrBillingError(streamError);
      if (isBillingErr) tripBillingCircuit(providerName);
      const recoveryReason = isBillingErr ? 'Billing/auth error mid-stream' : 'Stream interrupted';
      logger.warn('[AgentLoop] mid-stream error, trying fallback recovery once', {
        projectId, userId, recoveryReason, errorMessage: streamError?.message ?? String(streamError),
      });
      if (!SUPPRESS_RECOVERY_UI) {
        const statusMsg = isAuthOrBillingError(streamError)
          ? 'Provider billing issue. Switching to backup model...'
          : 'Connection interrupted. Recovering with backup model...';
        sink.emit('step-finish', { step: 0, toolCount: 0, status: statusMsg });
      }

      const recoveryCandidates = buildFallbackCandidates(providerName, modelId);

      for (const fallbackModelId of recoveryCandidates) {
        const fallbackInfo = createProviderForModel(fallbackModelId);
        if (!fallbackInfo) continue;
        try {
          const recoveredStream = await attemptStream(fallbackInfo.provider, 0, fallbackInfo.providerName);
          const recoveredConsume = await consumeResultStream(recoveredStream);
          if (!recoveredConsume.err) {
            accumulatedText += recoveredConsume.text;
            streamError = null;
            providerFellBackThisRun = true;
            logger.info('[AgentLoop] Stream recovery succeeded via fallback provider', {
              projectId, userId, fallbackProviderName: fallbackInfo.providerName, fallbackModelId,
            });
            break;
          }
          streamError = recoveredConsume.err;
        } catch (recoveryErr: any) {
          streamError = recoveryErr;
          logger.warn('[AgentLoop] Recovery fallback failed', {
            projectId, userId, fallbackProviderName: fallbackInfo.providerName, fallbackModelId,
            errorMessage: recoveryErr?.message ?? String(recoveryErr),
          });
        }
      }
    }

    if (streamError) {
      // If the timeout handler already sent a 'done' event, suppress re-throwing so the
      // route-level catch doesn't emit a second 'error' SSE that overwrites the done result.
      if (timeoutDoneSent || (streamError as any)?.isAgentTimeout) {
        logger.info('[AgentLoop] Timeout abort: swallowing streamError, done already sent', { projectId, userId });
        return { filesToWrite: [], filesToDelete: [], renames: [], dependencies: [], summary: '', costUsd: 0, ecoUsed: 0, runtimeMode };
      }
      logger.error('[AgentLoop] streamError not recovered, rethrowing', {
        projectId, userId, errorMessage: streamError?.message, stack: streamError?.stack,
      });
      throw streamError;
    }

    // ─── Hallucinated-completion guard ──────────────────────────────────────
    // Some runs end with the model narrating a file change in prose ("I've
    // updated X to do Y") without ever calling write_file/edit_file, and
    // without the legacy <ecomgear-write> tag protocol either   i.e. nothing
    // was actually saved, but the text reads exactly like a real completion.
    // Detect that specific pattern and force one corrective continuation
    // (spending steps we already have budget for) instead of silently
    // finalizing on a claim that isn't backed by any tool call.
    const wroteAnythingSoFar = filesToWrite.length > 0 || filesEdited.length > 0 || filesToDelete.length > 0 || renames.length > 0;
    const hasLegacyWriteTags = /<ecomgear-(write|edit|delete|rename)\b/i.test(accumulatedText);
    const claimsCompletedEdit = /\b(i'?ve|i have)\s+(updated|changed|fixed|edited|modified|created|added|rewritten|refactored|implemented)\b/i.test(accumulatedText)
      || /\b(updated|changed|fixed|edited|modified)\s+(the\s+)?`?[\w./-]+\.(tsx?|jsx?|css|html|json)`?/i.test(accumulatedText);
    const stepsRemaining = MAX_STEPS - stepCount;

    if (runtimeMode !== 'plan' && !wroteAnythingSoFar && !hasLegacyWriteTags && claimsCompletedEdit
        && stepsRemaining >= 3 && !abortController.signal.aborted) {
      logger.warn('[AgentLoop] Hallucinated completion claim detected (zero writes, text claims a change), forcing corrective continuation', {
        projectId, userId: userId ?? 'unknown', stepCount, stepsRemaining, accumulatedTextPreview: accumulatedText.slice(0, 300),
      });
      generateStatus(projectId, { kind: 'lifecycle', phase: 'post-gen-verify' }).then((s) => {
        if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
      }).catch(() => {});

      conversationMessages = [
        ...conversationMessages,
        { role: 'assistant' as const, content: accumulatedText },
        {
          role: 'user' as const,
          content: 'You just described a code change but never called write_file or edit_file   nothing was actually saved. ' +
            'If you intended to make that change, call the appropriate tool now to actually apply it. ' +
            'If you cannot or should not make the change, say so plainly instead of describing it as already done.',
        },
      ];

      try {
        const correctiveStream = await attemptStream(streamingProvider, 0, providerName);
        const correctiveConsume = await consumeResultStream(correctiveStream);
        if (!correctiveConsume.err && correctiveConsume.text) {
          accumulatedText = correctiveConsume.text;
        } else if (correctiveConsume.err) {
          logger.warn('[AgentLoop] Corrective continuation stream errored (non-fatal)', {
            projectId, userId, errorMessage: correctiveConsume.err?.message ?? String(correctiveConsume.err),
          });
        }
      } catch (correctiveErr: any) {
        logger.warn('[AgentLoop] Corrective continuation failed (non-fatal)', {
          projectId, userId, errorMessage: correctiveErr?.message ?? String(correctiveErr),
        });
      }
    }

    // ─── Verified-fix-before-closure-claim filter (fix tier only) ─────────────
    // Root-cause audit finding: a fix run could end with "this should resolve
    // it" / "this will permanently fix it" language with no passing verification
    // behind it   the same claim repeating run after run while the underlying
    // bug never actually closes. Force one corrective continuation instead of
    // letting an unverified resolution claim reach the user. Scoped to
    // tier === 'fix': other tiers don't carry this specific "I diagnosed and
    // fixed a bug" framing, so the check would false-positive on normal build
    // narration ("I've added the cart drawer").
    //
    // Also requires anySuccessfulWriteThisRun: a fix-tier turn that never wrote
    // any file (pure diagnosis-and-explain, or a conversational answer with no
    // code change) has nothing for get_build_errors to verify   forcing a build
    // check on a turn that touched no code would just make the model call the
    // tool for no reason. ctx.lastBuildErrorsHealthy is also invalidated back to
    // undefined on every successful write (see hadSuccessfulWriteThisStep above)
    // so a get_build_errors call from BEFORE a later edit can no longer satisfy
    // this gate   the verification has to be fresh, i.e. actually happen after
    // the write it's supposed to be confirming, not just at some earlier point
    // in the same run.
    //
    // Stress-tested 2026-08-06 against paraphrases a model under repair
    // pressure actually uses instead of repeating the same flagged string
    // ("all set now", "that takes care of it", "good to go", "no more
    // errors", etc.)   the original narrow pattern list only caught 4/12 of
    // those. This broadened version catches 17/18 in the same test set,
    // while still not firing on the prompt's own required progress-narration
    // format ("Fixed the import error in Navbar.tsx   now checking the
    // build.")   the negative lookahead after "fixed/resolved the X" excludes
    // that "in <file>" shape specifically. Regex/keyword matching has a hard
    // ceiling on paraphrase coverage no matter how it's tuned; see the
    // Phase 1 report for what a semantic (LLM-graded) classifier would add.
    const RESOLUTION_CLAIM_RE =
      /\b(this (should|will|'?ll)\s+(now\s+)?(resolve|fix|solve)|should now be (fixed|resolved|working)|(will|should)\s+permanently\s+(resolve|fix)|the (issue|error|bug|problem)\s+(is|has been|should be)\s+(now\s+)?(fixed|resolved|solved)|all (set|good|fixed)\b|(that|this)\s+(should\s+)?(takes?|takes?\s+care\s+of|does\s+it|do\s+it|sorts?\s+(it|that)\s+out)|fixed\s+the\s+(problem|issue|bug|error)\b(?!\s+in\s)|working\s+(as\s+expected|correctly|properly|fine|now)\b|(should\s+be|is|looks)\s+good\s+(to\s+go|now)?\b|good\s+to\s+go\b|resolved\s+(the\s+)?(problem|issue|bug|error)\b(?!\s+in\s)|no\s+more\s+errors?\b|(everything|it)\s+(is\s+|now\s+)?work(s|ing)\s+(now|correctly|properly|fine)?)\b/i;
    // Bounded RE-CHECK loop, not a single one-shot correction: the original
    // shipped version corrected once and then accepted whatever came back
    // unconditionally   a model that just rephrases the same unverified claim
    // on the retry (the exact "six phrasings of the same unverified claim"
    // pattern from the original transcript) sailed straight through. Confirmed
    // by reading the code, not assumed: nothing re-ran RESOLUTION_CLAIM_RE
    // against verifyConsume.text. Capped at 2 attempts so this can't itself
    // become an unbounded loop; if still unverified after the cap, the claim
    // is stripped and replaced with an honest "couldn't confirm" message
    // instead of either the unverified claim OR silent infinite retry.
    // thrashEscalated (Phase 2) takes priority over this loop and skips it
    // entirely: the escalation message explicitly told the model to STOP
    // calling get_build_errors, so re-entering this loop would push it to
    // call get_build_errors AGAIN   directly contradicting that instruction
    // and extending the exact thrash pattern this is meant to end. See the
    // dedicated override block right after this loop.
    const MAX_CLOSURE_VERIFY_ATTEMPTS = 2;
    let closureVerifyAttempts = 0;
    while (
      !ctx.thrashEscalated &&
      _tier === 'fix' &&
      anySuccessfulWriteThisRun &&
      RESOLUTION_CLAIM_RE.test(accumulatedText) &&
      ctx.lastBuildErrorsHealthy !== true &&
      (MAX_STEPS - stepCount) >= 2 &&
      !abortController.signal.aborted &&
      closureVerifyAttempts < MAX_CLOSURE_VERIFY_ATTEMPTS
    ) {
      closureVerifyAttempts++;
      logger.warn('[AgentLoop] Unverified resolution claim detected, forcing corrective continuation', {
        projectId, userId: userId ?? 'unknown', closureVerifyAttempts, MAX_CLOSURE_VERIFY_ATTEMPTS,
      });
      generateStatus(projectId, { kind: 'lifecycle', phase: 'post-gen-verify' }).then((s) => {
        if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
      }).catch(() => {});

      conversationMessages = [
        ...conversationMessages,
        { role: 'assistant' as const, content: accumulatedText },
        {
          role: 'user' as const,
          content: closureVerifyAttempts === 1
            ? 'You just claimed this fix resolves the issue, but get_build_errors has not confirmed a healthy ' +
              'build/preview this run. Call get_build_errors now to verify. If it comes back healthy, restate your ' +
              'closing message. If it still shows errors, keep fixing   do not repeat the resolution claim until it ' +
              'actually passes.'
            : 'You STILL asserted the fix is resolved without get_build_errors confirming a healthy build/preview   ' +
              'rephrasing the same claim does not count as verification. Call get_build_errors now. If it is not ' +
              'healthy, say plainly that you have not been able to confirm the fix yet and describe what remains ' +
              'broken; do NOT restate the resolution claim again unless get_build_errors actually returns healthy.',
        },
      ];

      try {
        const verifyStream = await attemptStream(streamingProvider, 0, providerName);
        const verifyConsume = await consumeResultStream(verifyStream);
        if (!verifyConsume.err && verifyConsume.text) {
          accumulatedText = verifyConsume.text;
        } else if (verifyConsume.err) {
          logger.warn('[AgentLoop] Verified-fix corrective continuation errored (non-fatal)', {
            projectId, userId, errorMessage: verifyConsume.err?.message ?? String(verifyConsume.err),
          });
          break;
        }
      } catch (verifyErr: any) {
        logger.warn('[AgentLoop] Verified-fix corrective continuation failed (non-fatal)', {
          projectId, userId, errorMessage: verifyErr?.message ?? String(verifyErr),
        });
        break;
      }
    }
    // Cap exhausted and STILL an unverified claim: don't let it reach the user
    // as-is. Override with an honest, explicit "couldn't confirm" statement.
    if (
      !ctx.thrashEscalated &&
      _tier === 'fix' &&
      anySuccessfulWriteThisRun &&
      RESOLUTION_CLAIM_RE.test(accumulatedText) &&
      ctx.lastBuildErrorsHealthy !== true &&
      closureVerifyAttempts >= MAX_CLOSURE_VERIFY_ATTEMPTS
    ) {
      logger.warn('[AgentLoop] Resolution claim still unverified after corrective attempts, overriding with honest-fail message', {
        projectId, userId: userId ?? 'unknown', closureVerifyAttempts,
      });
      accumulatedText =
        `I made changes aimed at this issue, but I was not able to confirm with get_build_errors that the build/preview ` +
        `is actually healthy after ${closureVerifyAttempts} verification attempts. I don't want to tell you it's fixed ` +
        `without that confirmation. Please check the preview yourself, or ask me to try again and I'll re-diagnose from ` +
        `the current state rather than repeating the same claim.`;
    }

    // ─── Unfulfilled-promise closure gate (orchestration audit, 2026-08-09) ──
    // Live repro that caught this: user asked an opinion-soliciting question
    // ("don't you think the admin panel should be separate?"). The model
    // agreed and said "I will separate the admin section from the main
    // user-facing site" -- then the run ended. Zero tool calls, zero files
    // written, status='completed', no error. This happened on BOTH the
    // cheap-first model AND the escalated full model for the same prompt,
    // back to back. The system prompt already forbids this exact pattern
    // ("STRICTLY FORBIDDEN... future-tense promise... unless you IMMEDIATELY
    // follow it with actual file writes") but that's prompt text the model
    // can (and did) ignore -- nothing mechanical caught it.
    //
    // Fires when a build/edit/feature/fix run is about to conclude having
    // made NO file changes at all while its own closing text promises one.
    // The corrective turn gives the model exactly two honest outs: act now,
    // or -- since Phase 1 (2026-08-09) gave plan mode's propose_plan tool to
    // this run's toolset too (see buildToolSet) -- stage a real plan and
    // explicitly ask the user to confirm, instead of a bare unactioned promise.
    //
    // 'fix' was originally left out of this list; live repro (2026-08-11,
    // a "why did you remove the logos, fix them now" thread) showed that was
    // backwards -- fix tier is where this exact pattern is MOST likely
    // (long diagnostic detour, budget runs out, the model's last line is "I
    // will restore them immediately" with zero tool calls that turn), and it
    // was the one tier this gate didn't cover.
    // Closed verb list -> open pattern (2026-08-16). The original 17 verbs
    // matched almost none of the promises production actually produces: "I
    // will take the concrete actions", "I will resolve this immediately", "I
    // will execute the full correction", "I'll install it now", "I'll replace
    // the logo", "I will begin", "I'll correct". Any fixed list is a losing
    // game -- the model paraphrases freely -- so match any first-person
    // future-tense commitment and instead exclude the continuations that hand
    // control BACK to the user ("let me know if...", "I'll need...", "I won't
    // ...", "I'll be happy to..."), which are legitimate ways for a run to
    // end without writing. Precision still comes mainly from the loop guard
    // below: this only fires when the run wrote nothing at all.
    // Continuations that do NOT promise a file change: either handing control
    // back to the user, or read-only inspection the model satisfies by looking
    // rather than writing (a "summarise this file" request legitimately ends
    // with no writes, and forcing a corrective turn there is just waste).
    const NON_ACTION_CONTINUATIONS = [
      'know', 'need', 'be', 'not', 'never', 'require', 'wait', 'leave', 'avoid', 'stop', 'assume', 'clarify', 'explain',
      'check', 'read', 'review', 'look', 'examine', 'inspect', 'see', 'find', 'search',
      'verify', 'confirm', 'list', 'show', 'walk', 'describe',
      String.raw`analyz\w*`, String.raw`analys\w*`, String.raw`summariz\w*`, String.raw`summaris\w*`,
    ].join('|');
    // Validated against 197 real zero-file production run summaries
    // (2026-08-16): this matches 61 of them where the old verb list matched 13,
    // while correctly ignoring "I will check", "Let me read", "let me verify".
    const UNFULFILLED_PROMISE_RE = new RegExp(
      String.raw`\b(?:I(?:'|’)ll|I will|I(?:'|’)m going to|I am going to|let me|going to (?:go ahead and|now))\s+(?!(?:${NON_ACTION_CONTINUATIONS})\b)\w+`,
      'i',
    );
    const MAX_PROMISE_VERIFY_ATTEMPTS = 1;
    let promiseVerifyAttempts = 0;
    while (
      !ctx.thrashEscalated &&
      !anySuccessfulWriteThisRun &&
      (_tier === 'build' || _tier === 'edit' || _tier === 'feature' || _tier === 'fix') &&
      UNFULFILLED_PROMISE_RE.test(accumulatedText) &&
      (MAX_STEPS - stepCount) >= 2 &&
      !abortController.signal.aborted &&
      promiseVerifyAttempts < MAX_PROMISE_VERIFY_ATTEMPTS
    ) {
      promiseVerifyAttempts++;
      logger.warn('[AgentLoop] Unfulfilled-promise detected, forcing corrective continuation', {
        projectId, userId: userId ?? 'unknown', promiseVerifyAttempts, MAX_PROMISE_VERIFY_ATTEMPTS,
      });
      generateStatus(projectId, { kind: 'lifecycle', phase: 'post-gen-verify' }).then((s) => {
        if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
      }).catch(() => {});

      conversationMessages = [
        ...conversationMessages,
        { role: 'assistant' as const, content: accumulatedText },
        {
          role: 'user' as const,
          content:
            `You just said you would take an action, but you made zero tool calls and wrote zero files -- nothing was ` +
            `actually done. Pick exactly ONE of these now, don't just restate the same promise:\n` +
            `  1. If you're confident this is what the user wants, do it now: call your tools and make the actual ` +
            `changes in this same turn.\n` +
            `  2. If it's a bigger or ambiguous change worth confirming first, call propose_plan with a concrete, ` +
            `ordered list of steps, then tell the user their plan is ready and ask them to confirm before you build it.\n` +
            `Do not end this turn with only a description of what you would do.`,
        },
      ];

      try {
        const promiseVerifyStream = await attemptStream(streamingProvider, 0, providerName);
        const promiseVerifyConsume = await consumeResultStream(promiseVerifyStream);
        if (!promiseVerifyConsume.err && promiseVerifyConsume.text) {
          accumulatedText = promiseVerifyConsume.text;
        } else if (promiseVerifyConsume.err) {
          logger.warn('[AgentLoop] Unfulfilled-promise corrective continuation errored (non-fatal)', {
            projectId, userId, errorMessage: promiseVerifyConsume.err?.message ?? String(promiseVerifyConsume.err),
          });
          break;
        }
      } catch (promiseVerifyErr: any) {
        logger.warn('[AgentLoop] Unfulfilled-promise corrective continuation failed (non-fatal)', {
          projectId, userId, errorMessage: promiseVerifyErr?.message ?? String(promiseVerifyErr),
        });
        break;
      }
    }

    // ── Orphaned-asset gate ─────────────────────────────────────────────────
    // place_asset succeeded but NOTHING in the project references the placed
    // filename -> the user's image renders nowhere, yet the run reports
    // success. Confirmed live 2026-08-17 ("change the logo": logo.png placed,
    // the only edit changed a text string, run ended, logo never appeared).
    // Same one-shot corrective-continuation shape as the promise gate above.
    // Reference check is against DISK (src/ + index.html), so replacing an
    // already-referenced filename (logo.png over logo.png) passes untouched.
    const placedAssetNames = (ctx.placedAssetPaths ?? [])
      .map((p) => p.split('/').pop() ?? '')
      .filter(Boolean);
    if (placedAssetNames.length > 0 && !abortController.signal.aborted && (MAX_STEPS - stepCount) >= 2) {
      const diskReferences = (name: string): boolean => {
        const scan = (dir: string): boolean => {
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
            logger.debug('diskReferences scan: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
            return false;
          }
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!['node_modules', '.git', 'dist'].includes(entry.name) && scan(full)) return true;
            } else if (/\.(tsx?|jsx?|html|css)$/.test(entry.name)) {
              try { if (fs.readFileSync(full, 'utf8').includes(name)) return true; } catch (readErr: any) {
                logger.debug('diskReferences scan: failed to read file (skipped)', { full, error: readErr?.message });
              }
            }
          }
          return false;
        };
        try { if (fs.readFileSync(path.join(appPath, 'index.html'), 'utf8').includes(name)) return true; } catch (idxErr: any) {
          logger.debug('diskReferences: failed to read index.html (non-fatal)', { projectId, error: idxErr?.message });
        }
        return scan(path.join(appPath, 'src'));
      };
      const orphanedAssets = placedAssetNames.filter((n) => !diskReferences(n));
      if (orphanedAssets.length > 0) {
        logger.warn('[AgentLoop] Orphaned-asset gate: placed but unreferenced, forcing corrective continuation', {
          projectId, userId: userId ?? 'unknown', orphanedAssets,
        });
        conversationMessages = [
          ...conversationMessages,
          { role: 'assistant' as const, content: accumulatedText },
          {
            role: 'user' as const,
            content:
              `You placed ${orphanedAssets.map((n) => `"${n}"`).join(', ')} with place_asset, but NO file in the ` +
              `project references ${orphanedAssets.length === 1 ? 'it' : 'them'} -- the image will never appear ` +
              `anywhere on the site. Use edit_file NOW to reference ${orphanedAssets.length === 1 ? 'it' : 'them'} ` +
              `where the user asked (src={\`\${import.meta.env.BASE_URL}assets/<name>\`}), replacing the old ` +
              `logo/image markup if one exists. Do not end the turn until the reference is in place.`,
          },
        ];
        try {
          const assetFixStream = await attemptStream(streamingProvider, 0, providerName);
          const assetFixConsume = await consumeResultStream(assetFixStream);
          if (!assetFixConsume.err && assetFixConsume.text) {
            accumulatedText = assetFixConsume.text;
          }
        } catch (assetFixErr: any) {
          logger.warn('[AgentLoop] Orphaned-asset corrective continuation failed (non-fatal)', {
            projectId, userId, errorMessage: assetFixErr?.message ?? String(assetFixErr),
          });
        }
      }
    }
    // Cap exhausted (or a plan was staged, which is a legitimate outcome --
    // propose_plan doesn't set anySuccessfulWriteThisRun since it writes to
    // agent_plans, not project files) and still no action taken: be honest
    // about it instead of letting an unfulfilled promise stand as the final word.
    if (
      !ctx.thrashEscalated &&
      !anySuccessfulWriteThisRun &&
      promiseVerifyAttempts > 0 &&
      UNFULFILLED_PROMISE_RE.test(accumulatedText)
    ) {
      logger.warn('[AgentLoop] Unfulfilled-promise still unresolved after corrective attempts, appending honest note', {
        projectId, userId: userId ?? 'unknown', promiseVerifyAttempts,
      });
      // Real-signal gating (harness redesign, increment 1): if get_build_errors
      // already confirmed this run's build is broken, say so plainly instead of
      // the generic note -- "let me know if you'd like me to go ahead" invites
      // confirmation as if things are otherwise fine, when they're confirmed not to be.
      accumulatedText += unfulfilledPromiseNote(ctx.lastBuildErrorsHealthy);
    }

    // ─── Anon-fetch-without-policy closure gate (2026-08 audit follow-up) ─────
    // Live repro that caught this: an agent building a public product catalog
    // correctly created the table (RLS auto-enabled, zero policies   exactly
    // as designed) and correctly wrote a direct `fetch()` to it via the anon
    // key, but never issued a CREATE POLICY. Its closing summary said "Created
    // products table and Shop page with direct DB fetch" with zero caveat.
    // Verified directly against Postgres: the anon role got 0 rows. The build
    // compiles fine (get_build_errors would pass clean)   this is a runtime/
    // data-completeness gap the RESOLUTION_CLAIM_RE gate above structurally
    // cannot see, since nothing is syntactically or type-wrong, AND that gate
    // is scoped to tier==='fix' + "I fixed a bug" phrasing, neither of which
    // this scenario carries (it's a tier==='build' run with plain "Created X"
    // narration, not a resolution claim). So this check is deliberately NOT
    // gated on RESOLUTION_CLAIM_RE matching   it fires whenever a run that
    // wrote files is about to conclude while still carrying an unresolved
    // anon-fetch/no-policy gap, regardless of exact closing phrasing.
    //
    // Gap = tables write_file/edit_file detected being fetched directly via
    // the anon key this run (ctx.anonFetchTables), minus tables that got an
    // actually-EXECUTED CREATE POLICY targeting an anon/public role this run
    // (ctx.anonPolicyTables). Most tables should have NO anon policy (private
    // user data)   correctly leaving them policy-less is the secure default,
    // which is exactly why this only fires on tables the run's OWN generated
    // frontend code proves it's trying to read directly and unauthenticated,
    // never on "any table missing a policy."
    //
    // KNOWN LIMITATION (accepted, not attempted): a pre-existing table from a
    // prior run/session that already has an anon policy from that earlier
    // run, newly wired to a direct fetch in THIS run, will false-positive
    // here   ctx.anonPolicyTables only tracks policies executed in the
    // CURRENT run, not a live `pg_policies` check. Closing that gap needs a
    // live DB lookup at closure time, a heavier lift than this-run tracking;
    // flagged rather than silently expanded into scope.
    const anonFetchGapTables = (): string[] => {
      if (!ctx.anonFetchTables || ctx.anonFetchTables.size === 0) return [];
      return [...ctx.anonFetchTables.keys()].filter((t) => !ctx.anonPolicyTables?.has(t));
    };
    const MAX_ANON_POLICY_VERIFY_ATTEMPTS = 2;
    let anonPolicyVerifyAttempts = 0;
    while (
      !ctx.thrashEscalated &&
      anySuccessfulWriteThisRun &&
      anonFetchGapTables().length > 0 &&
      (MAX_STEPS - stepCount) >= 2 &&
      !abortController.signal.aborted &&
      anonPolicyVerifyAttempts < MAX_ANON_POLICY_VERIFY_ATTEMPTS
    ) {
      anonPolicyVerifyAttempts++;
      const gapTables = anonFetchGapTables();
      const gapDetail = gapTables
        .map((t) => `  • "${t}" (fetched directly in ${ctx.anonFetchTables!.get(t)})`)
        .join('\n');
      logger.warn('[AgentLoop] Anon-fetch-without-policy gap detected, forcing corrective continuation', {
        projectId, userId: userId ?? 'unknown', anonPolicyVerifyAttempts, MAX_ANON_POLICY_VERIFY_ATTEMPTS, gapTables,
      });
      generateStatus(projectId, { kind: 'lifecycle', phase: 'post-gen-verify' }).then((s) => {
        if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
      }).catch(() => {});

      conversationMessages = [
        ...conversationMessages,
        { role: 'assistant' as const, content: accumulatedText },
        {
          role: 'user' as const,
          content:
            `Your frontend code fetches the following table(s) directly with the anon key, but no read policy ` +
            `for the anon role was created for them this run:\n${gapDetail}\n\n` +
            `As written, those fetches will silently return an empty array/no rows to every visitor   the anon ` +
            `role has no SELECT grant on a table with RLS enabled and zero policies. You must do ONE of these ` +
            `before finishing:\n` +
            `  1. If \`query_database\` is in your current tools (Admin mode) AND the data is genuinely meant to be ` +
            `public, call it with \`CREATE POLICY <name> ON <schema>.<table> FOR SELECT TO <schema>_anon USING ` +
            `(<condition, e.g. true>);\` -- this stages the change and Admin mode auto-runs it once you finish; you ` +
            `cannot confirm it yourself, but you also don't need to ask the user to click anything.\n` +
            `  2. Otherwise (Normal mode, or the data should NOT be public), remove the direct fetch and move it ` +
            `into an edge function via write_edge_function instead.\n` +
            `Do not restate your closing summary until you've done one of these for every table listed above.`,
        },
      ];

      try {
        const anonVerifyStream = await attemptStream(streamingProvider, 0, providerName);
        const anonVerifyConsume = await consumeResultStream(anonVerifyStream);
        if (!anonVerifyConsume.err && anonVerifyConsume.text) {
          accumulatedText = anonVerifyConsume.text;
        } else if (anonVerifyConsume.err) {
          logger.warn('[AgentLoop] Anon-fetch-policy corrective continuation errored (non-fatal)', {
            projectId, userId, errorMessage: anonVerifyConsume.err?.message ?? String(anonVerifyConsume.err),
          });
          break;
        }
      } catch (anonVerifyErr: any) {
        logger.warn('[AgentLoop] Anon-fetch-policy corrective continuation failed (non-fatal)', {
          projectId, userId, errorMessage: anonVerifyErr?.message ?? String(anonVerifyErr),
        });
        break;
      }
    }
    // Cap exhausted and the gap is still open: don't let the closing message
    // stand uncaveated   append an explicit, honest note instead of silently
    // shipping a summary that implies the feature works end-to-end.
    {
      const remainingGapTables = anonFetchGapTables();
      if (!ctx.thrashEscalated && anySuccessfulWriteThisRun && remainingGapTables.length > 0) {
        logger.warn('[AgentLoop] Anon-fetch-without-policy gap still open after corrective attempts, appending caveat', {
          projectId, userId: userId ?? 'unknown', anonPolicyVerifyAttempts, remainingGapTables,
        });
        accumulatedText +=
          `\n\n(Note: the frontend fetches ${remainingGapTables.map((t) => `"${t}"`).join(', ')} directly with the anon key, ` +
          `but no read policy exists for the anon role yet, so those fetches will currently return no rows. Add a ` +
          `\`CREATE POLICY ... FOR SELECT TO <schema>_anon\` for genuinely public data, or move the fetch into an edge ` +
          `function if it shouldn't be public.)`;
      }
    }

    // ─── Asset-replacement completeness claim check (root cause #2 of the ────
    // 2026-08-06 asset-replacement audit) ───────────────────────────────────
    // Deliberately NOT the same mechanism as RESOLUTION_CLAIM_RE above: that
    // gate is hard-scoped to tier 'fix' + build-error health, a different task
    // class (asset-replacement runs are 'edit'/'micro', never 'fix', and have
    // nothing to do with get_build_errors). Keeping this independent avoids
    // coupling two unrelated fingerprint shapes into one flag. Also
    // deliberately simpler than that gate's corrective re-streaming loop: this
    // appends an honest caveat deterministically (no extra LLM call) rather
    // than forcing a re-verification turn   proportionate to a lower-stakes
    // claim than "the build is fixed", and keeps this addition low-risk.
    const ASSET_REPLACEMENT_CLAIM_RE =
      /\b((replaced|updated|swapped|changed)\s+(it\s+|the\s+)?(logo|image|asset|icon|favicon)s?\s+(everywhere|across|throughout|site-?wide)|every\s+reference\s+(is|has been|was)\s+updated|all\s+references?\s+(are|is|were|have\s+been)\s+updated|(logo|image|asset)\s+(is\s+)?(now\s+)?updated\s+everywhere)\b/i;
    if (
      ctx.placeAssetCallCount &&
      ctx.placeAssetCallCount > 0 &&
      ASSET_REPLACEMENT_CLAIM_RE.test(accumulatedText) &&
      (!ctx.assetReferencesChecked ||
        ctx.assetReferencesChecked.size === 0 ||
        [...ctx.assetReferencesChecked.values()].some((v) => !v.fullyResolved))
    ) {
      logger.warn('[AgentLoop] Asset-replacement completeness claim without a verified replace_asset_references pass, appending caveat', {
        projectId, userId: userId ?? 'unknown',
      });
      accumulatedText +=
        `\n\n(Note: I placed a new asset this run but haven't run a verified replace_asset_references pass confirming ` +
        `every reference to the old one was found and updated, so I can't confirm "everywhere" is actually complete. ` +
        `If you spot the old image anywhere, tell me where and I'll check that specific file.)`;
    }

    // ─── Thrash-escalation override (Phase 2) ──────────────────────────────────
    // Deterministic, no further LLM call: the whole point of escalation is to
    // STOP spending steps/tokens on this fingerprint. If the model already
    // wrote an honest status (no resolution-claim language), leave it as-is
    // only override when it ignored the tool's instruction and either claimed
    // success anyway or produced nothing usable.
    if (ctx.thrashEscalated && (RESOLUTION_CLAIM_RE.test(accumulatedText) || !accumulatedText.trim())) {
      const fileHint = (ctx.thrashFingerprint ?? '').split('::')[0];
      logger.warn('[AgentLoop] Thrash-escalated run still produced a resolution claim (or nothing), overriding with honest-fail message', {
        projectId, userId: userId ?? 'unknown', thrashTripCount: ctx.thrashTripCount, fileHint,
      });
      accumulatedText =
        `I've now attempted to fix this ${ctx.thrashTripCount ?? 2} times${fileHint && fileHint !== 'unknown-file' ? ` (repeatedly in ${fileHint})` : ''} ` +
        `and the same error keeps coming back. I don't want to keep trying the same kind of fix without new information, ` +
        `since it hasn't worked so far. Could you share more context about what's expected here, point me at something ` +
        `I might be missing, or let me know if you'd like me to try a fundamentally different approach?`;
    }

    // ─── Empty-response guard ────────────────────────────────────────────────
    // Some provider failures (Gemini safety block, malformed function-call
    // response, etc.) end the stream with a `finish` part carrying finishReason
    // 'error'/'content-filter'/'other' WITHOUT throwing   the run "succeeds"
    // with zero visible text, zero tool calls, and nothing written. Usage
    // tokens (and cost) are still burned, and the user got nothing but the
    // generic "didn't respond" fallback with no explanation and no retry.
    // Detect that exact empty-run signature and retry once via a fallback
    // provider before giving up for real.
    {
      const suspiciousFinish = outerFinishReason === 'error' || outerFinishReason === 'other' || outerFinishReason === 'content-filter';
      const producedNothing = !accumulatedText.trim() && !wroteAnythingSoFar && !hasLegacyWriteTags;
      if (producedNothing && suspiciousFinish && !abortController.signal.aborted) {
        logger.warn('[AgentLoop] Empty run detected (zero text/tools/writes), retrying once via fallback provider', {
          projectId, userId: userId ?? 'unknown', finishReason: outerFinishReason,
        });
        let recovered = false;
        for (const fallbackModelId of buildFallbackCandidates(providerName, modelId)) {
          const fallbackInfo = createProviderForModel(fallbackModelId);
          if (!fallbackInfo) continue;
          try {
            const retryStream = await attemptStream(fallbackInfo.provider, 0, fallbackInfo.providerName);
            const retryConsume = await consumeResultStream(retryStream);
            if (!retryConsume.err && retryConsume.text.trim()) {
              accumulatedText = retryConsume.text;
              logger.info('[AgentLoop] Empty-run retry succeeded via fallback provider', {
                projectId, userId, fallbackProviderName: fallbackInfo.providerName, fallbackModelId,
              });
              recovered = true;
              break;
            }
          } catch (retryErr: any) {
            logger.warn('[AgentLoop] Empty-run retry failed', {
              projectId, userId, fallbackProviderName: fallbackInfo.providerName, fallbackModelId,
              errorMessage: retryErr?.message ?? String(retryErr),
            });
          }
        }
        if (!recovered && !accumulatedText.trim()) {
          throw new Error(
            `The AI model produced no output (finishReason=${outerFinishReason}). This usually means a content-safety ` +
            `filter blocked the response, or the provider had a transient failure. Please rephrase your request or try again.`
          );
        }
      }
    }

    // Arbitrate a claimed FAILURE against what this run actually observed.
    // Mirror of the resolution-claim gate above: that one catches success
    // asserted over a broken build, this catches failure asserted over a
    // healthy one. Fires only when the harness positively knows better -- the
    // run changed nothing AND a real get_build_errors call reported healthy --
    // because silencing a TRUE failure report would be far worse than leaving
    // a false one. See staleFailureClaim.ts for the incident this comes from.
    const failureArbitration = arbitrateFailureClaim(accumulatedText, {
      wroteNothing: !anySuccessfulWriteThisRun,
      buildHealthy: ctx.lastBuildErrorsHealthy === true,
    });
    if (failureArbitration.stripped > 0) {
      logger.warn('[AgentLoop] Suppressed a failure claim contradicted by observation', {
        projectId, userId: userId ?? 'unknown',
        sentences: failureArbitration.stripped,
        wroteNothing: !anySuccessfulWriteThisRun,
        buildHealthy: ctx.lastBuildErrorsHealthy === true,
      });
    }
    const finalText = failureArbitration.text;

    // Extract summary from <ecomgear-chat-summary> if present
    const summaryMatch = /<ecomgear-chat-summary>([\s\S]*?)<\/ecomgear-chat-summary>/.exec(finalText);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      summary = finalText.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim().split('\n')[0] ?? '';
    }
    // Backstop: model sometimes ignores the "short summary" prompt instruction,
    // so clamp the user-facing text regardless of which branch produced it.
    if (summary.length > 200) {
      summary = summary.slice(0, 200).trim() + '…';
    }

    // Budget-abort with nothing to show: the model was still mid-tool-calls
    // (reading files, editing) when the token/cost cap hit, so it never got to
    // produce a final text response   summary is empty here. Without this, the
    // frontend falls through every fallback to a generic "didn't respond, try
    // rephrasing" message that has nothing to do with what actually happened
    // and gives the user no way to know a retry with the same prompt will
    // likely hit the exact same wall. Plain, non-technical wording only   the
    // user doesn't need to see raw numbers like "token cap 450000 hit
    // (472100 used)"; they need to know whether anything changed and what to
    // do next.
    const madeNoChanges = !anySuccessfulWriteThisRun && filesToWrite.length === 0 && filesEdited.length === 0;
    if (stuckAnalysisAbortReason && !summary.trim()) {
      // Two distinct failures share this abort path and MUST read differently:
      // (a) pure analysis paralysis   never attempted a write; (b) the run DID
      // attempt writes but every attempt was rejected by a guard or the tool
      // (confirmed live 2026-07-21: two complete write_file rewrites bounced by
      // the prefer-edit guard, then the user was told to "give a more specific
      // instruction"   blaming their prompt for the system's own rejections).
      const examined = Array.from(ctx.readFiles ?? []).slice(0, 10);
      const examinedNote = examined.length > 0
        ? `\n\nFiles I looked at before getting stuck:\n${examined.map((f) => `   • ${f}`).join('\n')}` +
          `\nIf the bug isn't in one of these, that's exactly why I couldn't pin it down   tell me which file it's actually in.`
        : '';
      if (rejectedWriteAttempts.length > 0) {
        const attemptsNote = rejectedWriteAttempts.slice(0, 3).map((a) => `   • ${a}`).join('\n');
        summary = `I DID try to make the change   ${rejectedWriteAttempts.length} write attempt(s) were rejected by ` +
          `the platform's safety checks before they could be saved, and I failed to work around them, so I stopped ` +
          `instead of burning more of your budget. ${madeNoChanges ? 'Nothing was changed.' : 'What I did change so far is saved.'} ` +
          `This is a platform-side issue, not a problem with your instruction   retrying the same request may work, ` +
          `and this has been logged for the team.\n\nRejected attempts:\n${attemptsNote}`;
        logger.warn('[AgentLoop] Stuck-abort WITH rejected write attempts (guard-caused, not analysis paralysis)', {
          projectId, userId: userId ?? 'unknown', rejectedWriteAttemptCount: rejectedWriteAttempts.length,
        });
      } else {
        summary = `I got stuck re-analyzing this without actually making a change, so I stopped instead of ` +
          `continuing to spin. ${madeNoChanges ? 'Nothing was changed.' : 'What I did change so far is saved.'} ` +
          `Could you give me a more specific instruction, or point me at the exact file/behavior to change?${examinedNote}`;
      }
    } else if (budgetAbortReason && !summary.trim()) {
      // Don't claim the task was "bigger than I could finish" when changes DID
      // land   the cap can fire right at the end of a fully completed change
      // (observed 2026-07-21: fullscreen-game edit finished, build check clean,
      // cap tripped on the final step, user told the work was unfinished).
      // We can't know completeness for sure, so state facts, not conclusions.
      summary = madeNoChanges
        ? `This request turned out to be bigger than I could finish in one go, and nothing was changed yet. ` +
          `Try breaking it into smaller, more specific steps.`
        : `I hit this run's cost limit. The changes I made are saved and live in the preview   check it, ` +
          `and if anything is still missing, send a follow-up and I'll continue from there.`;
    }

    // Parse ecomgear tags from the full final text as well (XML parser is more reliable)
    parseXmlResponse(finalText, { filesToWrite, filesEdited, filesToDelete, renames, dependencies });

    // ─── Post-generation App.tsx validation ────────────────────────────────────
    // Detects when the agent wrote page files but forgot to update App.tsx.
    // System-prompt instructions alone are unreliable under step-limit pressure
    // or context-compaction drift   this enforces it programmatically.
    if (runtimeMode === 'build' && !abortController.signal.aborted) {
      const normPath = (p: string) => p.replace(/\\/g, '/');

      const appTsxWasUpdated =
        filesToWrite.some(f => normPath(f.path) === 'src/App.tsx') ||
        filesEdited.some(p => normPath(p) === 'src/App.tsx');

      const newPageFiles = filesToWrite
        .map(f => normPath(f.path))
        .filter(p =>
          /^src\/pages\//i.test(p) ||
          /^src\/[A-Z][^/]*Page\.(tsx|jsx)$/i.test(p)
        );

      if (newPageFiles.length > 0 && !appTsxWasUpdated) {
        logger.info('[AgentLoop] Post-gen validation: page(s) written but App.tsx not updated, codegenerating App.tsx', {
          projectId, pageCount: newPageFiles.length, newPageFiles,
        });
        generateStatus(projectId, { kind: 'lifecycle', phase: 'router-wiring', detail: `${newPageFiles.length} ${newPageFiles.length === 1 ? 'page' : 'pages'}` }).then((s) => {
          if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
        }).catch(() => {});

        let allPagesOnDisk: string[] = [];
        try {
          const pagesDir = safeJoin(appPath, 'src/pages');
          if (fs.existsSync(pagesDir)) {
            allPagesOnDisk = fs.readdirSync(pagesDir)
              .filter(f => /\.(tsx|jsx)$/.test(f))
              .map(f => `src/pages/${f}`);
          }
        } catch (pagesDirErr: any) {
          logger.debug('_runAgentLoopInner: failed to list src/pages for App.tsx codegen (non-fatal)', { projectId, error: pagesDirErr?.message });
        }

        const pagesForRouter = allPagesOnDisk.length > 0 ? allPagesOnDisk : newPageFiles;

        // Deterministic codegen   zero LLM calls, zero wiring failures. Replaces
        // the old generateText-based "App.tsx fix pass", which could hallucinate
        // routes, forget imports, or truncate mid-file like any other LLM write.
        try {
          const generatedAppTsx = generateAppTsxFromPages(pagesForRouter);
          const fullPath = safeJoin(appPath, 'src/App.tsx');
          writeProjectFileSync({ appPath, projectId, runId: agentLockToken }, 'src/App.tsx', generatedAppTsx);
          const existing = filesToWrite.findIndex(f => f.path === 'src/App.tsx');
          if (existing >= 0) filesToWrite[existing].content = generatedAppTsx;
          else filesToWrite.push({ path: 'src/App.tsx', content: generatedAppTsx });
          if (ctx.pendingPreviewFiles) ctx.pendingPreviewFiles.set('src/App.tsx', generatedAppTsx);
          logger.info('[AgentLoop] App.tsx codegen completed', { projectId, routesWired: pagesForRouter.length });
        } catch (appFixErr: any) {
          logger.warn('[AgentLoop] App.tsx codegen failed (non-fatal)', { projectId, error: appFixErr?.message, stack: appFixErr?.stack });
        }
      }
    }
    // ─── End App.tsx validation ─────────────────────────────────────────────────

    // BINARY_EXTS_SET / BINARY_SENTINEL are module-level now, shared with the
    // pre-agent snapshot path above   see readFileForSync.
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.tmp', 'coverage']);
    const SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);

    // Keep only files explicitly written by tool calls and refresh their content from disk.
    const latestWriteByPath = new Map<string, string>();
    for (const file of filesToWrite) {
      latestWriteByPath.set(file.path, file.content);
    }

    // Agent-written files: read fresh from disk (most authoritative).
    // Skip binary files   they are handled by collectDiskFiles as base64.
    const agentWrittenFiles = Array.from(latestWriteByPath.entries())
      .filter(([relativePath]) => {
        const ext = path.extname(relativePath).toLowerCase();
        return !BINARY_EXTS_SET.has(ext);
      })
      .map(([relativePath, fallbackContent]) => {
      try {
        const fullPath = safeJoin(appPath, relativePath);
        if (fs.existsSync(fullPath)) {
          return { path: relativePath, content: fs.readFileSync(fullPath, 'utf8') };
        }
      } catch (rereadErr: any) {
        // Fall back to tracked content if path validation/read fails.
        logger.debug('_runAgentLoopInner: failed to re-read agent-written file from disk, using tracked content', {
          projectId, relativePath, error: rereadErr?.message,
        });
      }
      return { path: relativePath, content: fallbackContent };
    });

    const diskFilesMap = new Map<string, string>();
    const MAX_DISK_FILES = 5000;
    const MAX_TEXT_FILE_SIZE = 512 * 1024; // 512KB per text file
    const collectDiskFiles = (dir: string) => {
      if (diskFilesMap.size >= MAX_DISK_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
        logger.debug('collectDiskFiles: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
        return;
      }
      for (const entry of entries) {
        if (diskFilesMap.size >= MAX_DISK_FILES) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SKIP_FILES.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectDiskFiles(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const relPath = path.relative(appPath, fullPath);
          if (!diskFilesMap.has(relPath)) {
            try {
              const stat = fs.statSync(fullPath);
              if (!BINARY_EXTS_SET.has(ext) && stat.size > MAX_TEXT_FILE_SIZE) continue;
              if (BINARY_EXTS_SET.has(ext)) {
                // Encode binary files (images, fonts, etc.) as base64 so they
                // can travel through the JSON sync payload to the preview service.
                const base64 = fs.readFileSync(fullPath).toString('base64');
                diskFilesMap.set(relPath, `${BINARY_SENTINEL}${base64}`);
              } else {
                diskFilesMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
              }
            } catch (readErr: any) {
              logger.debug('collectDiskFiles: failed to read/stat file (skipped)', { relPath, error: readErr?.message });
            }
          }
        }
      }
    };
    try {
      collectDiskFiles(appPath);
      logger.debug('_runAgentLoopInner: post-run disk file collection complete', { projectId, diskFileCount: diskFilesMap.size });
    } catch (collectErr: any) {
      logger.debug('_runAgentLoopInner: post-run disk file collection failed (non-fatal, project dir may be missing)', { projectId, error: collectErr?.message });
    }

    for (const { path: p, content: c } of agentWrittenFiles) {
      diskFilesMap.set(p, c);
    }
    const mergedWrites = Array.from(diskFilesMap.entries()).map(([p, c]) => ({ path: p, content: c }));

    // Background KB indexing   fire-and-forget, never blocks the agent response
    if (projectId && mergedWrites.length > 0) {
      Promise.allSettled(
        mergedWrites.map(f => indexFile(projectId, f.path, f.content))
      ).catch(() => {});
    }

    // Scope the sanitize pass to files THIS run actually touched. `mergedWrites`
    // is the whole project (collectDiskFiles scans everything on disk) merged
    // with this run's writes   sanitizing every file in that set, including
    // ones this run never looked at, meant a persistently-broken file from a
    // PAST run could get re-discovered, "fixed" by a naive bracket-counting
    // heuristic that doesn't repair real structural errors, and written back
    // to disk STILL broken   every single run, forever, on files nobody asked
    // to change. Worse: the push/repair/rollback safety net below is gated on
    // agentWroteFiles (this run's own tracked writes), so a sanitize-caused
    // bad write to an untouched file got zero safety net   the run would just
    // skip the preview push entirely ("No file operations") and leave the
    // broken write sitting on disk.
    // Count real TS syntax errors   used to make sure the mechanical sanitize
    // pass below never makes a file WORSE. sanitizeFileContent's bracket-depth
    // heuristic (sanitize.ts, "orphan closer" detection) tracks braces and
    // parens with a single shared counter and has no special handling for
    // `${...}` template-literal interpolations containing their own braces  
    // it can misfire on a file that was already perfectly valid, "fixing" a
    // false positive by appending or stripping closers, which actively
    // CORRUPTS the file. Previously that corrupted result was written to disk
    // unconditionally; the TS check right after only warned, never blocked.
    const countSyntaxErrors = (path: string, content: string): number => {
      try {
        const result = ts.transpileModule(content, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
          },
          reportDiagnostics: true,
          fileName: path,
        });
        return (result.diagnostics ?? []).length;
      } catch (transpileErr: any) {
        // transpileModule exceptions are rare   don't treat as an error signal
        logger.debug('countSyntaxErrors: transpileModule threw (treated as 0 errors)', { path, error: transpileErr?.message });
        return 0;
      }
    };

    const touchedThisRun = new Set<string>([...filesToWrite.map(f => f.path), ...filesEdited]);
    for (const f of mergedWrites) {
      if (!touchedThisRun.has(f.path)) continue;
      if (/\.(tsx?|jsx?)$/.test(f.path) && !f.path.startsWith('node_modules')) {
        const { content: sanitized, fixes } = sanitizeFileContent(f.path, f.content);
        if (fixes.length > 0) {
          const errorsBefore = countSyntaxErrors(f.path, f.content);
          const errorsAfter = countSyntaxErrors(f.path, sanitized);
          if (errorsAfter > errorsBefore) {
            // The "fix" made things worse (or broke a previously-valid file)
            // reject it and keep the original content untouched.
            logger.warn('[AgentLoop] Final sanitize REJECTED: would have made syntax errors worse, keeping original content', {
              projectId, path: f.path, errorsBefore, errorsAfter, attemptedFixes: fixes,
            });
          } else {
            f.content = sanitized;
            try {
              const fullPath = safeJoin(appPath, f.path);
              writeProjectFileSync({ appPath, projectId, runId: agentLockToken }, f.path, sanitized);
            } catch (writeErr: any) {
              logger.debug('_runAgentLoopInner: failed to write sanitized file to disk (non-fatal)', { projectId, path: f.path, error: writeErr?.message });
            }
            logger.info('[AgentLoop] Final sanitize applied', { projectId, path: f.path, fixes });
          }
        }

        // TS syntax check   only run on React source files under src/ to avoid
        // noisy config/tooling diagnostics from vite/tailwind/postcss config files.
        const normalizedPath = f.path.replace(/\\/g, '/');
        const isReactSource = /(^|\/)src\/.*\.(tsx|jsx)$/i.test(normalizedPath);
        if (isReactSource) {
          try {
            const tsResult = ts.transpileModule(f.content, {
              compilerOptions: {
                jsx: ts.JsxEmit.ReactJSX,
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2020,
              },
              reportDiagnostics: true,
              fileName: f.path,
            });
            if (tsResult.diagnostics && tsResult.diagnostics.length > 0) {
              const errors = tsResult.diagnostics
                .slice(0, 2)
                .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
                .join('; ');
              logger.warn('[AgentLoop] Final syntax check failed, repair loop will fix', { projectId, path: f.path, errors });
            }
          } catch (transpileErr: any) {
            // don't block push on transpileModule exceptions
            logger.debug('_runAgentLoopInner: final syntax check transpile threw (non-fatal)', { projectId, path: f.path, error: transpileErr?.message });
          }
        }
      }
      if (/\.json$/i.test(f.path) && !f.path.startsWith('node_modules')) {
        const { content: repaired, fixes } = sanitizeConfigFile(f.path, f.content);
        if (fixes.length > 0) {
          f.content = repaired;
          try {
            const fullPath = safeJoin(appPath, f.path);
            writeProjectFileSync({ appPath, projectId, runId: agentLockToken }, f.path, repaired);
          } catch (writeErr: any) {
            logger.debug('_runAgentLoopInner: failed to write config-repaired file to disk (non-fatal)', { projectId, path: f.path, error: writeErr?.message });
          }
          logger.info('[AgentLoop] Config repair applied', { projectId, path: f.path, fixes });
        }
      }
    }

    // ctx.nonFileMutation: a real, consequential change with no corresponding
    // project file (e.g. provision_database.ts) -- see its doc comment in
    // agent-tools/types.ts for why this can't be a synthetic filesToWrite entry.
    const agentWroteFiles = filesToWrite.length > 0 || filesEdited.length > 0 || filesToDelete.length > 0 || renames.length > 0 || ctx.nonFileMutation === true;

    // Paths whose content this run actually wrote/edited but that never made
    // it into the live preview -- surgical-revert-removed new files, or
    // everything undone by the pre-agent-restore fallback below. Previously
    // both paths were logged as "(silent)" and the run still reported plain
    // success, so a request like "add X" could appear to add X and then
    // silently drop it with no visible explanation. Surfaced as a caveat
    // after the push section resolves (see the text-delta emit below).
    const droppedFiles: string[] = [];

    let previewPushOk = false;
    // Result of the pre-response smoke gate (gap G2), read again by the
    // post-response observability write so one run never launches Chromium
    // twice to answer the same question. Declared at this scope because both
    // sites need it. Null means the gate never ran.
    let smokeGateResult: { ok: boolean; errors: string[]; skipped: boolean } | null = null;
    // True once the revert guard below fires: smoke check failed AND repair
    // could not bring it back healthy, so the run's files were kept
    // unverified. Declared at this scope (not inside the block below) because
    // the 'done' emit further down, outside that block, needs to read it.
    let smokeFailureSurvivedRepair = false;
    if (runtimeMode === 'build' && agentWroteFiles) {
      generateStatus(projectId, { kind: 'lifecycle', phase: 'preview-sync' }).then((s) => {
        if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
      }).catch(() => {});
      try {
      const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001';
      const updateUrl = `${previewServiceUrl}/preview/${projectId}/update`;
      const previewUpdateSecret = process.env.PREVIEW_UPDATE_SECRET || '';
      const { default: http } = await import('node:http');
      const { default: https } = await import('node:https');

      // Default 15s suits small calls (secrets sync, partial pushes). FULL-SYNC
      // pushes pass 120s explicitly: /update materializes the whole project,
      // warms the Vite instance (up to 30s) and runs a build check BEFORE
      // responding (~90s worst case on a 188-file project). The 15s default
      // aborted those mid-work as "transport failure (status 0)", then each
      // retry re-materialized the project (2026-08-17 07:23 incident). The
      // web client learned this same lesson at previewHealthService.ts:251.
      const httpPost = (url: string, body: string, timeoutMs = 15_000): Promise<{ status: number; body: string }> =>
        new Promise((resolve) => {
          const mod = url.startsWith('https') ? https : http;
          const urlObj = new URL(url);
          let responseBody = '';
          const extraHeaders: Record<string, string> = {
            ...(previewUpdateSecret ? { 'x-update-secret': previewUpdateSecret } : {}),
            ...(agentLockToken ? { 'x-agent-lock-token': agentLockToken } : {}),
          };
          const req = mod.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
            timeout: timeoutMs,
          }, (r) => {
            r.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
            r.on('end', () => {
              logger.debug('_runAgentLoopInner: httpPost response', {
                projectId, url, status: r.statusCode ?? 0, bodyLength: responseBody.length,
              });
              resolve({ status: r.statusCode ?? 0, body: responseBody });
            });
          });
          req.on('error', (e: Error) => {
            logger.warn('_runAgentLoopInner: httpPost request errored', { projectId, url, error: e.message });
            resolve({ status: 0, body: e.message });
          });
          req.on('timeout', () => {
            logger.warn('_runAgentLoopInner: httpPost request timed out', { projectId, url, timeoutMs });
            req.destroy();
            resolve({ status: 0, body: 'timeout' });
          });
          logger.debug('_runAgentLoopInner: httpPost request starting', { projectId, url, bodyLength: body.length, timeoutMs });
          req.write(body);
          req.end();
        });

      const httpGet = (url: string, timeoutMs = 10_000): Promise<{ status: number; body: string }> =>
        new Promise((resolve) => {
          const mod = url.startsWith('https') ? https : http;
          const urlObj = new URL(url);
          let responseBody = '';
          const req = mod.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            timeout: timeoutMs,
          }, (r) => {
            r.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body: responseBody }));
          });
          req.on('error', (e: Error) => {
            logger.debug('_runAgentLoopInner: httpGet request errored', { projectId, url, error: e.message });
            resolve({ status: 0, body: e.message });
          });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
          req.end();
        });

      // Gap G2 (2026-08-12): browser smoke-check failures are injected here as a
      // ONE-SHOT so the existing, proven repair loop consumes them through its
      // normal error source instead of needing a second parallel repair path.
      // Cleared the moment the loop reads them (see the clear inside the repair
      // loop) -- they must never be sticky, or a check that keeps failing would
      // hold the loop open for all 3 attempts on a signal that is far newer and
      // less proven than build errors.
      let pendingSmokeErrors: string[] = [];
      // True only when the browser smoke check (not a build/type/runtime error)
      // is what marked this run unhealthy. Used to keep an unproven signal away
      // from the most destructive path in this file -- see the revert guard.
      let smokeTriggeredFailure = false;
      const getPreviewStatus = async (): Promise<{ healthy: boolean; errors: string[]; diagnosticKind?: string }> => {
        const statusRes = await httpGet(`${previewServiceUrl}/preview/${projectId}/status`);
        if (statusRes.status !== 200) {
          return { healthy: false, errors: [`status_unreachable_${statusRes.status || 0}`], diagnosticKind: 'service' };
        }
        try {
          const parsed = JSON.parse(statusRes.body) as { healthy?: boolean; errors?: string[]; diagnosticKind?: string };
          const baseErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
          if (pendingSmokeErrors.length > 0) {
            return {
              healthy: false,
              errors: [...baseErrors, ...pendingSmokeErrors],
              // 'runtime' selects the runtime-error repair prompt, which is the
              // correct one: a smoke failure is by definition a crash that only
              // appears once the page actually renders.
              diagnosticKind: 'runtime',
            };
          }
          return {
            healthy: Boolean(parsed.healthy),
            errors: baseErrors,
            diagnosticKind: typeof parsed.diagnosticKind === 'string' ? parsed.diagnosticKind : undefined,
          };
        } catch (parseErr: any) {
          logger.warn('_runAgentLoopInner: preview status response JSON parse failed', { projectId, error: parseErr?.message });
          return { healthy: false, errors: ['status_parse_failed'], diagnosticKind: 'service' };
        }
      };
      // Use the pre-agent disk snapshot for surgical revert.
      // The snapshot was captured at the top of runAgentLoop, before any agent writes.
      // Also capture current disk state before repair loop starts
      const diskBeforeRepair = new Map<string, string>();
      for (const f of mergedWrites) {
        diskBeforeRepair.set(f.path, f.content);
      }

      // Self-heal preview env before pushing files. Secrets previously reached
      // the preview's .env.local only on database provisioning, the manual
      // Sync button, or the ecg-dev-agent flow -- a project that added auth
      // without ever provisioning a hosted DB ran with VITE_SUPABASE_URL
      // undefined, so createClient() threw at boot (blank page + every login
      // "failure" the clients keep reporting). Best-effort: a failed sync
      // never blocks the file push.
      // Retried, unlike before: this push carries the credentials the app needs
      // to BOOT, and it sat one line above a file push that already retries
      // three times. A single transient blip left the preview with no
      // VITE_DB_API_URL while the run reported success.
      //
      // Retries are scoped to failures a retry can actually fix -- transport
      // errors (status 0) and 5xx. A 4xx is a definitive answer: the request
      // is wrong or unauthorised, and sending it again cannot change that.
      // 2026-08-24 showed why that distinction matters: a PREVIEW_UPDATE_SECRET
      // mismatch 401'd the FILE push, which retries on any non-200/422, so it
      // burned three 120s attempts (13:20 -> 20:41 window, 15 failures across 5
      // projects) and pushed the run into AGENT_TIMEOUT_MS, whose salvage then
      // discarded the whole run's work. Retrying an auth error converted a
      // config fault into lost work. NOTE: the file push below still has that
      // blind-retry behaviour -- deliberately not touched here, flagged only.
      if (userId) {
        try {
          const envSecrets = await buildProjectEnvSecrets(userId, projectId);
          if (envSecrets.length > 0) {
            const secretsUrl = `${previewServiceUrl}/preview/${projectId}/secrets`;
            const body = JSON.stringify({ secrets: envSecrets });
            const MAX_SECRET_RETRIES = 3;
            let envRes = await httpPost(secretsUrl, body);
            for (
              let attempt = 1;
              attempt <= MAX_SECRET_RETRIES && envRes.status !== 200 && isRetryableSyncStatus(envRes.status);
              attempt++
            ) {
              logger.warn('[AgentLoop] preview env-secrets sync transport failure, retrying', {
                projectId, status: envRes.status, attempt, maxAttempts: MAX_SECRET_RETRIES,
              });
              await new Promise<void>((r) => setTimeout(r, attempt * 1000));
              envRes = await httpPost(secretsUrl, body);
            }
            if (envRes.status !== 200) {
              // The app will boot without its database credentials. Error, not
              // warn: the run is about to report success while the preview it
              // just pushed to cannot reach ECG CLOUD DB.
              logger.error('[AgentLoop] preview env-secrets sync FAILED — app will boot without DB credentials', {
                projectId,
                status: envRes.status,
                retryable: isRetryableSyncStatus(envRes.status),
                secretCount: envSecrets.length,
                secretKeys: envSecrets.map((s) => s.key_name),
                bodyPreview: envRes.body.slice(0, 200),
              });
            } else {
              // preview-service reports how many keys it actually wrote, and
              // nothing has ever read it. A short count means a successful HTTP
              // call still left the app short of credentials -- the .env.local
              // write is a full replace, not a merge.
              const written = readSecretsWrittenCount(envRes.body);
              if (written != null && written !== envSecrets.length) {
                logger.error('[AgentLoop] preview env-secrets sync wrote fewer keys than sent', {
                  projectId, sent: envSecrets.length, written,
                  secretKeys: envSecrets.map((s) => s.key_name),
                });
              }
            }
          }
        } catch (envErr: any) {
          logger.error('[AgentLoop] preview env-secrets sync threw — app may boot without DB credentials', { projectId, error: envErr?.message, stack: envErr?.stack });
        }
      }

      // First attempt: normal push. Retry transport-level failures (network
      // error/timeout/5xx -- status 0 or anything that isn't a real 200/422
      // validation response) a few times with backoff before giving up --
      // previously a single transient blip here (VPS2 mid-restart, a dropped
      // connection) skipped BOTH the repair loop AND the pre-agent-restore
      // fallback below (both gated on !pushWasTransportFailure), so the run
      // reported success to the user while the live preview never actually
      // received this run's work. The written content was never determined
      // to be broken, so retry the same push rather than reverting anything.
      logger.info('[AgentLoop] preview push starting', { projectId, updateUrl, fileCount: mergedWrites.length });
      let firstAttempt = await httpPost(updateUrl, JSON.stringify({ files: mergedWrites, fullSync: true, baseSeq: new Date().toISOString() }), 120_000);
      for (let pushRetry = 1; pushRetry <= 3 && firstAttempt.status !== 200 && firstAttempt.status !== 422; pushRetry++) {
        logger.warn('[AgentLoop] Preview push transport failure, retrying', {
          projectId, status: firstAttempt.status, pushRetry, maxPushRetries: 3,
        });
        await new Promise<void>((r) => setTimeout(r, pushRetry * 1000));
        firstAttempt = await httpPost(updateUrl, JSON.stringify({ files: mergedWrites, fullSync: true, baseSeq: new Date().toISOString() }), 120_000);
      }
      if (firstAttempt.status === 200) {
        // A 200 does NOT mean the files went live. preview-service answers 200
        // even when it detected build errors and ROLLED THE PUSH BACK to the
        // last stable version, reporting that as { promoted: false,
        // rolledBack: true } (see its /update handler and pushOutcome.js).
        // Those fields were never read here, so a rolled-back push set
        // previewPushOk = true: the run skipped the repair loop entirely and
        // told the user its work was done while the preview had discarded it.
        // That is exactly the "it says it fixed it but nothing changed"
        // report -- the user saw the rollback warning and a success message in
        // the same reply.
        const pushResult = interpretPreviewPush(firstAttempt.status, firstAttempt.body);
        const rolledBack = pushResult.rolledBack;

        if (!pushResult.landed) {
          logger.warn('[AgentLoop] Preview push was ROLLED BACK by preview-service -- routing to repair loop', {
            projectId, fileCount: mergedWrites.length, rolledBack,
          });
          tracer.event('preview-push-rolled-back', { files: mergedWrites.length });
          // Same handling as a 422: the work did not land, so fall into the
          // repair loop rather than reporting success.
          previewPushOk = false;
          ctx.previewRolledBack = true;
        } else {
          logger.info('[AgentLoop] Preview push OK', { projectId, fileCount: mergedWrites.length });
          tracer.event('preview-push', { files: mergedWrites.length, paths: mergedWrites.slice(0, 50).map((f) => f.path) });
          previewPushOk = true;
        }
      } else if (firstAttempt.status === 422) {
        // Previously this branch immediately reverted whichever files the
        // preview service's validationErrors named as broken -- BEFORE ever
        // giving the LLM repair loop below a chance to actually fix them and
        // deliver what the user asked for. That meant any validation hiccup
        // on a file the user explicitly asked to change (a logo, a component)
        // silently discarded the request instead of attempting a fix: fast,
        // but it threw away real user-requested work on the first sign of
        // trouble. previewPushOk stays false here on purpose so this falls
        // straight into the real repair loop (up to 3 LLM-driven attempts,
        // with actual build-error context) -- reverting to pre-agent state is
        // now only the last resort after repair is exhausted, not the first
        // response to a validation error.
        logger.warn('[AgentLoop] Preview validation failed (422), routing to repair loop before considering any revert', { projectId });
      } else {
        logger.warn('[AgentLoop] Preview push returned unexpected status', { projectId, status: firstAttempt.status });
      }

      const pushWasTransportFailure = firstAttempt.status !== 200 && firstAttempt.status !== 422 && !previewPushOk;

      let repairDiagnosticKind: string = 'build';
      // Captures last known errors from repair loop   used by salvage block (outer scope)
      let lastRepairErrors: string[] = [];

      if (previewPushOk) {
        generateStatus(projectId, { kind: 'lifecycle', phase: 'build-check' }).then((s) => {
          if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
        }).catch(() => {});
        await new Promise<void>(r => setTimeout(r, 600));
        let status = await getPreviewStatus();
        if (!status.healthy) {
          previewPushOk = false;
          repairDiagnosticKind = status.diagnosticKind ?? 'build';
          const hint = status.errors.slice(0, 1).join('\n') || 'unknown preview error';
          logger.warn('[AgentLoop] Preview reported unhealthy after successful push', { projectId, repairDiagnosticKind, hint });
        } else {
          // Second check at 1.2s total   catches slower Vite transforms on production
          await new Promise<void>(r => setTimeout(r, 600));
          status = await getPreviewStatus();
          if (!status.healthy) {
            previewPushOk = false;
            repairDiagnosticKind = status.diagnosticKind ?? 'build';
            const hint = status.errors.slice(0, 1).join('\n') || 'unknown preview error';
            logger.warn('[AgentLoop] Preview reported unhealthy on second check', { projectId, repairDiagnosticKind, hint });
          }
        }

        // ── Gap G2: browser smoke check as a REPAIR TRIGGER ──────────────────
        // Runs only when every cheap signal already says healthy -- i.e. exactly
        // when we are about to tell the user it worked. That placement is the
        // point: the cost is paid only on runs that would otherwise be declared
        // successful, and "compiles clean, renders a blank page" is precisely
        // the failure this catches. When the build is already known broken the
        // repair loop below is engaged anyway and this would add nothing.
        //
        // The original Phase 2b pass (2026-08-09) left this observability-only
        // "until real false-positive rates are known". Those rates could not be
        // read when this was written, so the design is defensive rather than
        // tuned: a confirm pass kills the dominant false-positive source (a cold
        // Vite still optimizing deps), the injection is one-shot so it can never
        // hold the repair loop open, and AGENT_SMOKE_REPAIR=off disables it
        // without a redeploy.
        if (
          previewPushOk &&
          process.env.AGENT_SMOKE_REPAIR !== 'off' &&
          // "The agent actually changed something" -- the same condition the
          // post-response observability pass expresses via doneFilesToWrite,
          // which is declared later. Its other half (a plan-mode guard) is
          // omitted because this branch is already unreachable in plan mode.
          agentWroteFiles &&
          // Tier coverage (gap G3, folded in here because G2 is inert without
          // it). Measured on 82 real runs 2026-08-09..08-12: edit 56, fix 13,
          // feature 9, build 0. The original feature/build-only gate therefore
          // admitted at most 11% of traffic and NEVER ran on the edit/fix runs
          // where "you said you fixed it but the page is white" actually
          // originates -- which is why preview_errors is null on all 82 rows.
          // micro stays excluded: 8-step trivial tweaks do not justify a browser
          // launch, and run_command is already excluded there for the same reason.
          _tier !== 'micro' &&
          !abortController.signal.aborted &&
          runTokens.total < RUN_TOKEN_CAP
        ) {
          try {
            const smokeBase = process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app';
            const smokeUrl = `${smokeBase}/preview/${projectId}`;
            const first = await runPreviewSmokeCheck(smokeUrl);
            smokeGateResult = first;
            if (!first.skipped && !first.ok) {
              // Confirm before acting: one blank reading is a suspicion, not a
              // verdict. Same reasoning as the preview's own blank-check client
              // script, which requires a second pass before it reports.
              await new Promise<void>(r => setTimeout(r, 2500));
              const confirmed = await runPreviewSmokeCheck(smokeUrl);
              smokeGateResult = confirmed; // the confirm pass is the authoritative reading
              if (!confirmed.skipped && !confirmed.ok) {
                pendingSmokeErrors = confirmed.errors.slice(0, 4);
                smokeTriggeredFailure = true;
                previewPushOk = false;
                repairDiagnosticKind = 'runtime';
                logger.warn('[AgentLoop] Smoke check confirmed failure, triggering repair', {
                  projectId, errorsPreview: pendingSmokeErrors.join('; ').slice(0, 300),
                });
              } else {
                logger.info('[AgentLoop] Smoke check recovered on confirm pass (first reading was a false positive)', { projectId });
              }
            }
          } catch (e: any) {
            // Never let this block a run every other signal calls healthy.
            logger.warn('[AgentLoop] Smoke-check gate errored (ignored)', {
              projectId, error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      if (!previewPushOk && !pushWasTransportFailure) {
        const isRuntimeRepair = repairDiagnosticKind === 'runtime';
        if (!SUPPRESS_RECOVERY_UI) {
          generateStatus(projectId, { kind: 'lifecycle', phase: 'repair', detail: isRuntimeRepair ? 'runtime' : 'build' }).then((s) => {
            if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
          }).catch(() => {});
        }
        // Skip all repair attempts if already over token budget
        if (abortController.signal.aborted || runTokens.total >= RUN_TOKEN_CAP) {
          logger.warn('[AgentLoop] Skipping build repair: token budget already exhausted', {
            projectId, runTokensTotal: runTokens.total, RUN_TOKEN_CAP,
          });
        } else {
        let repairFiles = [...mergedWrites];
        let prevErrorCount = Infinity;
        let prevErrorSignature: string | null = null;
        for (let repairAttempt = 0; repairAttempt < 3; repairAttempt++) {
          const waitMs = repairAttempt === 0 ? 500 : 1200;
          await new Promise<void>(r => setTimeout(r, waitMs));

          const status = await getPreviewStatus();
          // Update kind from the live status in case it changed
          if (!status.healthy && status.diagnosticKind) repairDiagnosticKind = status.diagnosticKind;
          if (!status.healthy && status.errors.some(e => e.startsWith('status_unreachable_'))) {
            if (repairAttempt === 0) {
              await new Promise<void>(r => setTimeout(r, 1200));
              const retryStatus = await getPreviewStatus();
              if (retryStatus.healthy) {
                previewPushOk = true;
                break;
              } else { break; }
            } else { break; }
            continue;
          }

          if (status.healthy) { previewPushOk = true; break; }

          const errors = status.errors.slice(0, 15);
          // Gap G2: one-shot consume. Injected smoke errors seed the FIRST
          // attempt only; from here the loop reads pure preview status, so a
          // check that keeps failing can never hold all 3 attempts open on a
          // signal newer and less proven than build errors. Cleared even when
          // `errors` is empty, so no path leaves them sticky.
          pendingSmokeErrors = [];
          if (errors.length === 0) break;
          lastRepairErrors = errors;

          const errorSignature = errors
            .map(e => e.split('\n').slice(0, 2).join('\n').trim())
            .sort()
            .join('|');
          if (prevErrorSignature && errorSignature === prevErrorSignature) {
            logger.warn('[AgentLoop] Repair repeating identical error signature, stopping early', {
              projectId, repairAttempt, errorCount: errors.length,
            });
            break;
          }

          // Progress check: if error count didn't decrease, bail early
          if (repairAttempt > 0 && errors.length >= prevErrorCount) {
            logger.warn('[AgentLoop] Repair made no progress, stopping', {
              projectId, repairAttempt, errorCount: errors.length, prevErrorCount,
            });
            break;
          }
          prevErrorCount = errors.length;
          prevErrorSignature = errorSignature;

// ── Deduplicate cascading errors (group by root file, max 2 per file) ──
          // One bad export can generate 20 "module not found" errors. Show the LLM
          // the pattern once per file instead of flooding it with duplicates.
          const errsByFile = new Map<string, string[]>();
          const errNoFile: string[] = [];
          for (const err of errors) {
            const fm = err.match(/^([\w./\-]+\.(?:tsx?|jsx?|css|json))(?::\d+)?/m);
            const key = fm ? fm[1] : '__none__';
            if (key === '__none__') { if (errNoFile.length < 2) errNoFile.push(err); continue; }
            if (!errsByFile.has(key)) errsByFile.set(key, []);
            const arr = errsByFile.get(key)!;
            if (arr.length < 2) arr.push(err); // keep max 2 per file
          }
          const dedupedErrors: string[] = [];
          for (const arr of errsByFile.values()) dedupedErrors.push(...arr);
          dedupedErrors.push(...errNoFile);
          const displayErrors = dedupedErrors.slice(0, 8); // hard cap at 8

          const condensedErrors = displayErrors
            .map((e, i) => `[${i + 1}] ${e.split('\n').slice(0, 6).join('\n')}`)
            .join('\n\n');

          // ── Parse broken file paths + line numbers from errors ─────────────
          const brokenFileLocations = new Map<string, number>(); // relPath → errorLine
          for (const err of errors) {
            const m1 = err.match(/^([\w./\-]+\.(?:tsx?|jsx?|css|json)):(\d+)/m);
            if (m1) {
              if (!brokenFileLocations.has(m1[1])) brokenFileLocations.set(m1[1], parseInt(m1[2], 10));
            } else {
              const m2 = err.match(/^([\w./\-]+\.(?:tsx?|jsx?|css|json))(?:\s|$)/m);
              if (m2 && !brokenFileLocations.has(m2[1])) brokenFileLocations.set(m2[1], 1);
            }
          }

          const currentKind = repairDiagnosticKind === 'runtime' ? 'runtime' : 'build';
          logger.info('[AgentLoop] Auto-repair attempt starting', {
            projectId, repairAttempt: repairAttempt + 1, errorCount: errors.length, currentKind, brokenFileCount: brokenFileLocations.size,
          });
          if (!SUPPRESS_RECOVERY_UI) {
            generateStatus(projectId, { kind: 'lifecycle', phase: 'repair', detail: `${currentKind}, attempt ${repairAttempt + 1}` }).then((s) => {
              if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
            }).catch(() => {});
          }

          // ── PASS -1: Failure memory (zero LLM tokens, cheaper than mechanical) ──
          // Check whether this exact error signature has a previously-VERIFIED
          // fix from any prior run (any project). Only applies llm_diff fixes here  
          // mechanical fixes are already covered by PASS 0's sanitizeFileContent,
          // which runs unconditionally and for free, so re-applying a remembered
          // mechanical fix would be redundant.
          if (currentKind === 'build' && brokenFileLocations.size > 0) {
            for (const [relPath] of brokenFileLocations) {
              if (!/\.(tsx?|jsx?)$/.test(relPath)) continue;
              const matchingError = errors.find(e => e.includes(relPath));
              if (!matchingError) continue;
              const remembered = await lookupFailureFix(matchingError);
              if (!remembered || remembered.fixKind !== 'llm_diff') continue;
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                const original = fs.readFileSync(fullFilePath, 'utf8');
                const diffMatch = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/.exec(remembered.fixContent);
                if (!diffMatch) continue;
                const [, searchText, replaceText] = diffMatch;
                if (!original.includes(searchText)) continue; // signature matched but file content differs too much   skip, let normal passes handle it
                const patched = original.replace(searchText, replaceText);
                writeProjectFileSync({ appPath, projectId, runId: agentLockToken }, relPath, patched);
                const memPush = await httpPost(updateUrl, JSON.stringify({ files: [{ path: relPath, content: patched }], fullSync: false }));
                if (memPush.status === 200) {
                  await new Promise<void>(r => setTimeout(r, 400));
                  const memHealth = await getPreviewStatus();
                  if (memHealth.healthy) {
                    logger.info('[AgentLoop] Failure-memory fix applied, LLM repair skipped', {
                      projectId, relPath, hitCount: remembered.hitCount + 1,
                    });
                    const idx = mergedWrites.findIndex(f => f.path === relPath);
                    if (idx >= 0) mergedWrites[idx].content = patched;
                    else mergedWrites.push({ path: relPath, content: patched });
                    previewPushOk = true;
                  }
                }
              } catch (memErr: any) {
                // remembered fix didn't apply cleanly   fall through to normal repair passes
                logger.debug('_runAgentLoopInner: failure-memory fix failed to apply cleanly (non-fatal)', { projectId, relPath, error: memErr?.message });
              }
              if (previewPushOk) break;
            }
          }
          if (previewPushOk) break; // failure-memory pass already succeeded

          // ── PASS 0: Mechanical repair (zero LLM tokens) ────────────────────
          // Run sanitizeFileContent on broken .tsx/.ts files BEFORE invoking LLM.
          // Fixes: orphan closers, duplicate React imports, truncated JSX   for free.
          // If ALL errors are cleared this way, the LLM call is skipped entirely.
          if (currentKind === 'build' && brokenFileLocations.size > 0) {
            const mechPatched: Array<{ path: string; content: string }> = [];
            for (const [relPath] of brokenFileLocations) {
              if (!/\.(tsx?|jsx?)$/.test(relPath)) continue;
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                const raw = fs.readFileSync(fullFilePath, 'utf8');
                const { content: fixed, fixes } = sanitizeFileContent(relPath, raw);
                if (fixes.length > 0) {
                  writeProjectFileSync({ appPath, projectId, runId: agentLockToken }, relPath, fixed);
                  mechPatched.push({ path: relPath, content: fixed });
                  logger.info('[AgentLoop] Mechanical fix applied', { projectId, relPath, fixes });
                }
              } catch (mechErr: any) {
                logger.debug('_runAgentLoopInner: mechanical repair failed to read/fix file (skipped)', { projectId, relPath, error: mechErr?.message });
              }
            }
            if (mechPatched.length > 0) {
              // Push only the patched files (partial update, no fullSync needed)
              const mechPush = await httpPost(updateUrl, JSON.stringify({ files: mechPatched, fullSync: false }));
              if (mechPush.status === 200) {
                await new Promise<void>(r => setTimeout(r, 400));
                const mechHealth = await getPreviewStatus();
                if (mechHealth.healthy) {
                  logger.info('[AgentLoop] Mechanical repair cleared all errors, LLM skipped', { projectId, repairAttempt: repairAttempt + 1 });
                  for (const p of mechPatched) {
                    const idx = mergedWrites.findIndex(f => f.path === p.path);
                    if (idx >= 0) mergedWrites[idx].content = p.content;
                    else mergedWrites.push(p);
                  }
                  previewPushOk = true;
                  break; // skip LLM entirely
                }
                if (mechHealth.diagnosticKind) repairDiagnosticKind = mechHealth.diagnosticKind;
              }
            }
          }
          if (previewPushOk) break; // mechanical pass already succeeded

          // ── PASS 1: LLM repair with token-efficient context snippets ──────
          // Send ±40 lines around the error line instead of full files.
          // For a 300-line file this cuts context tokens by ~85%.
          let brokenFileContext = '';
          if (brokenFileLocations.size > 0 && brokenFileLocations.size <= 10) {
            const contextParts: string[] = [];
            for (const [relPath, errorLine] of brokenFileLocations) {
              // Skip npm packages   they can't be fixed by editing source files
              if (!relPath.startsWith('src/') && !relPath.startsWith('./')) continue;
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                const raw = fs.readFileSync(fullFilePath, 'utf8');
                const lines = raw.split('\n');
                if (lines.length <= 80) {
                  // Short files: send complete content
                  contextParts.push(`=== ${relPath} ===\n${raw}`);
                } else {
                  // Long files: send imports (lines 1-12) + window around error (±40)
                  const winStart = Math.max(0, errorLine - 40);
                  const winEnd = Math.min(lines.length, errorLine + 40);
                  const importSection = winStart > 12
                    ? lines.slice(0, 12).map((l, i) => `${i + 1}: ${l}`).join('\n') + '\n...\n'
                    : '';
                  const window = lines
                    .slice(winStart, winEnd)
                    .map((l, i) => `${winStart + i + 1}: ${l}`)
                    .join('\n');
                  contextParts.push(`=== ${relPath} (lines ${winStart + 1}–${winEnd} of ${lines.length}) ===\n${importSection}${window}`);
                }
              } catch { /* file may not exist */ }
            }
            if (contextParts.length > 0) {
              brokenFileContext = `\n\n# Relevant file sections\n\n${contextParts.join('\n\n')}`;
            }
          }

          const repairFilesToWrite: Array<{ path: string; content: string }> = [];
          const repairCtx: AgentContext = {
            appPath,
            projectId,
            // 2026-08 audit: this was the one unguarded path in the whole
            // loop -- every other context (see line ~508) initializes
            // readFiles, which agentToolSet.ts's write_file/edit_file guard
            // depends on (`ctx.readFiles && !ctx.readFiles.has(relPath)`).
            // Omitting it here made that check always short-circuit false,
            // so the repair agent could blind-overwrite any file without
            // having read it first -- in the one context (write_file
            // preferred for "broken files") where that's most likely.
            readFiles: new Set<string>(),
            pendingPreviewFiles: ctx.pendingPreviewFiles,
            previewServiceUrl: ctx.previewServiceUrl,
            onXmlComplete: (xml: string) => {
              parseXmlOperation(xml, { filesToWrite: repairFilesToWrite, filesEdited: [], filesToDelete: [], renames: [], dependencies: [] });
              sink.emit('tool-output', { xml });
            },
          };
          const repairToolSet = buildToolSet(repairCtx, []);

          const repairSystemPrompt = repairDiagnosticKind === 'runtime'
            ? (
'You are a runtime-error repair agent. Tool calls only   ZERO chat text.\n\n' +
'RULES: edit_file for targeted fixes; write_file only for full rewrites. Fix ONLY the crash.\n' +
'Files must be complete   no placeholders like `// rest of code`.\n\n' +
'ERROR → FIX:\n' +
'- "Cannot read properties of undefined/null" → add `?.` or `if (!x) return null`\n' +
'- "X is not a function" → wrong import (default vs named)   read_file the source\n' +
'- "Element type is invalid" → component exported wrong   read_file source\n' +
'- "React Hook called conditionally" → move ALL hooks before any if/early return\n' +
'- "Maximum update depth exceeded" → fix useEffect deps array\n' +
'- "Objects are not valid as React child" → extract string property, not whole object\n' +
'- "X is not iterable" → add `|| []` fallback\n' +
'- "Cannot destructure X of undefined" → add null check or `?? {}`\n\n' +
'PROTOCOL: think → read_file crashing file → edit_file root cause → get_build_errors once.\n' +
'Budget: 10 tool calls max.'
            ) : (
'You are a build-error repair agent. Tool calls only   ZERO chat text.\n\n' +
'RULES: write_file for broken files (complete, no placeholders). edit_file for tiny patches.\n' +
'No explicit React import needed (Vite JSX transform). shadcn: `import * as React from "react"`.\n' +
'Export name must match filename: HomePage.tsx → export default function HomePage().\n\n' +
'ERROR → FIX:\n' +
'- "Module not found" → list_files to find it, write_file to create if missing\n' +
'- "X is not exported from Y" → read_file source, fix import to match actual export\n' +
'- "Unexpected token" / truncated file → write_file a clean complete version\n' +
'- "Cannot find name X" → add import at top\n' +
'- "Duplicate identifier" → remove the duplicate\n' +
'- "JSX unclosed tag" → write_file the whole component\n' +
'- "Type X not assignable" → read BOTH files, align the types\n\n' +
'PROTOCOL: think (find ROOT CAUSE   one bad export causes 20 cascade errors) → list_files once\n' +
'→ read_file broken files → fix ALL in one batch → get_build_errors once to verify.\n' +
'Budget: 12 tool calls max.'
            );

          // Snapshot broken files BEFORE the repair call so a successful outcome
          // can be diffed and stored in failure memory for future occurrences.
          const preRepairContent = new Map<string, string>();
          for (const [relPath] of brokenFileLocations) {
            try { preRepairContent.set(relPath, fs.readFileSync(safeJoin(appPath, relPath), 'utf8')); } catch (preRepairErr: any) {
              // file may not exist yet
              logger.debug('_runAgentLoopInner: pre-repair content read failed (non-fatal)', { projectId, relPath, error: preRepairErr?.message });
            }
          }

          try {
            logger.debug('[AgentLoop] LLM repair pass: calling generateText', {
              projectId, repairAttempt: repairAttempt + 1, providerName, modelId, repairDiagnosticKind, currentKind,
              brokenFileCount: brokenFileLocations.size,
            });
            const _repairStartedAtMs = Date.now();
            const repairResult = await generateText({
              model: aiProvider,
              system: repairSystemPrompt,
              messages: [{ role: 'user', content: `Fix these ${currentKind} errors:\n\n${condensedErrors}${brokenFileContext}` }],
              tools: repairToolSet,
              stopWhen: stepCountIs(12),
              abortSignal: abortController.signal,
            });
            logger.debug('[AgentLoop] LLM repair pass: generateText complete', {
              projectId, repairAttempt: repairAttempt + 1, durationMs: Date.now() - _repairStartedAtMs,
              inputTokens: repairResult.usage?.inputTokens, outputTokens: repairResult.usage?.outputTokens,
              stepCount: repairResult.steps?.length ?? 0,
            });
          } catch (repairErr: any) {
            logger.warn('[AgentLoop] Repair pass failed', {
              projectId, repairAttempt: repairAttempt + 1, error: repairErr?.message, stack: repairErr?.stack,
            });
            break;
          }

          // Re-scan disk after repair
          const repairedDiskMap = new Map<string, string>();
          const reCollectDisk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
              logger.debug('reCollectDisk: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
              return;
            }
            for (const entry of entries) {
              if (SKIP_DIRS.has(entry.name)) continue;
              if (SKIP_FILES.has(entry.name)) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                reCollectDisk(fullPath);
              } else {
                const ext = path.extname(entry.name).toLowerCase();
                const relPath = path.relative(appPath, fullPath);
                try {
                  if (BINARY_EXTS_SET.has(ext)) {
                    repairedDiskMap.set(relPath, `${BINARY_SENTINEL}${fs.readFileSync(fullPath).toString('base64')}`);
                  } else {
                    repairedDiskMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
                  }
                } catch (readErr: any) {
                  logger.debug('reCollectDisk: failed to read file (skipped)', { relPath, error: readErr?.message });
                }
              }
            }
          };
          try {
            reCollectDisk(appPath);
          } catch (reCollectErr: any) {
            logger.debug('_runAgentLoopInner: reCollectDisk after repair failed (non-fatal)', { projectId, error: reCollectErr?.message });
          }
          repairFiles = Array.from(repairedDiskMap.entries()).map(([p, c]) => ({ path: p, content: c }));

          // Push repaired files
          const repairPush = await httpPost(updateUrl, JSON.stringify({ files: repairFiles, fullSync: true, baseSeq: new Date().toISOString() }), 120_000);
          // Always update mergedWrites to latest disk state regardless of outcome
          mergedWrites.length = 0;
          repairFiles.forEach(f => mergedWrites.push(f));
          if (repairPush.status === 200) {
            // Push returning 200 does NOT guarantee the build is healthy  
            // quickViteBuildCheck may have found esbuild errors and stored them
            // in projectDiagnostics while still returning 200. Verify /status.
            await new Promise<void>(r => setTimeout(r, 800));
            const repairHealth = await getPreviewStatus();
            if (repairHealth.healthy) {
              logger.info('[AgentLoop] Auto-repair succeeded and preview confirmed healthy', { projectId, repairAttempt: repairAttempt + 1 });
              previewPushOk = true;

              // ── Store verified fix in failure memory for next occurrence ──────
              // Only store when the diff is small and clean   a full-file rewrite
              // makes a poor SEARCH/REPLACE template for a different file's content.
              for (const [relPath, errorLine] of brokenFileLocations) {
                const before = preRepairContent.get(relPath);
                const after = repairedDiskMap.get(relPath);
                if (!before || !after || before === after) continue;
                const matchingError = errors.find(e => e.includes(relPath));
                if (!matchingError) continue;
                const diff = buildMinimalSearchReplace(before, after);
                if (diff) {
                  storeFailureFix(matchingError, 'llm_diff', diff).catch(() => {});
                }
              }
              break;
            } else {
              // Update kind for the next repair pass
              if (repairHealth.diagnosticKind) repairDiagnosticKind = repairHealth.diagnosticKind;
              logger.warn('[AgentLoop] Auto-repair push OK but preview still unhealthy, continuing repair', {
                projectId, repairAttempt: repairAttempt + 1, hint: repairHealth.errors.slice(0, 1).join('; '),
              });
            }
          } else {
            logger.warn('[AgentLoop] Auto-repair did not pass validation', {
              projectId, repairAttempt: repairAttempt + 1, status: repairPush.status,
            });
          }
        }
        } // end token-budget guard for repair loop
      } // end if (!previewPushOk && !pushWasTransportFailure)   repair section

      // Gap G2 safety: a smoke-check failure must never reach the silent-revert
      // path below. That path throws away everything the agent just built, which
      // is the right call for a build that genuinely does not compile -- but the
      // smoke check is a far newer signal whose real-world false-positive rate
      // has not been measured. A false positive here would silently delete work
      // the user explicitly asked for, which is strictly worse than the
      // pre-existing behaviour for this case (ship it; the user sees the page and
      // says so). The user still gets the Auto-fix button via 'repair-failed',
      // and the post-response pass still records preview_errors, so the signal is
      // not lost -- only its power to destroy work is.
      if (smokeTriggeredFailure && !previewPushOk) {
        logger.warn('[AgentLoop] Smoke-triggered failure survived repair, NOT reverting (unproven signal), surfacing to the user instead', { projectId });
        smokeFailureSurvivedRepair = true;
        if (lastRepairErrors.length > 0) sink.emit('repair-failed', { errors: lastRepairErrors.slice(0, 5) });
        // Same house style as the droppedFiles/genuinelyOutOfSteps honest-copy
        // blocks below: say what broke and what happens next, instead of
        // letting the unconditional success toast downstream claim otherwise.
        sink.emit('text-delta', {
          text: '\n\n> ⚠️ I made the changes, but a live browser check found the page isn\'t rendering correctly afterward, and the automatic repair couldn\'t confirm a fix. Your changes were kept rather than reverted. Tell me what looks wrong, or send your request again.',
        });
        // Restoring the flag is accurate, not a cover-up: the push genuinely DID
        // succeed (files are on disk and served) -- only the rendered result is
        // suspect. Downstream this keeps the revision's preview_url/thumbnail
        // update alive so the work stays reachable, and lets the post-response
        // pass record preview_errors. The user is not told everything is fine:
        // 'repair-failed' above drives the Auto-fix affordance, and the
        // text-delta plus smokeFailureSurvivedRepair flag above/below keep the
        // 'done' event from claiming an unverified run succeeded.
        previewPushOk = true;
      }

      if (!previewPushOk && !pushWasTransportFailure) {
          // All repair attempts exhausted. Silently restore the pre-agent state so
          // the user sees a clean working preview instead of broken generated code.
          logger.warn('[AgentLoop] All repair attempts exhausted, silently restoring pre-agent state', {
            projectId, userId, preAgentSnapshotSize: preAgentDiskSnapshot.size,
          });

          // Notify frontend so it can show the Auto-fix button
          if (lastRepairErrors.length > 0) {
            sink.emit('repair-failed', { errors: lastRepairErrors.slice(0, 5) });
          }

          if (preAgentDiskSnapshot.size > 0) {
            // Restore disk files to pre-agent state on THIS server's own disk
            // (appPath   the canonical project directory the agent tools read/write
            // directly). This used to be silent best-effort: any failure here left
            // this server's disk holding the run's bad content while the SEPARATE
            // network push below could still succeed in restoring the preview
            // service to clean   the two copies silently drifting out of sync with
            // zero visibility into why. Track and log failures instead of
            // swallowing them.
            let diskRestoreFailures = 0;
            for (const [relPath, preContent] of preAgentDiskSnapshot) {
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
                // Binary content is BINARY_SENTINEL-prefixed base64 (see
                // readFileForSync) -- writing it as 'utf8' text would corrupt
                // the actual image/font bytes on disk. Decode back to a Buffer.
                // Single-owner write path. Deliberately NO runId: this loop
                // restores the pre-agent snapshot, so it is itself a
                // compensation. Recording it as a fresh file_write would let a
                // later recovery treat the undo as something to undo.
                writeProjectFileSync(
                  { appPath },
                  relPath,
                  preContent.startsWith(BINARY_SENTINEL)
                    ? Buffer.from(preContent.slice(BINARY_SENTINEL.length), 'base64')
                    : preContent,
                );
              } catch (diskErr: any) {
                diskRestoreFailures++;
                logger.error('[AgentLoop] Pre-agent disk restore FAILED, this server\'s own copy may still hold broken content', {
                  projectId, relPath, error: diskErr?.message, stack: diskErr?.stack,
                });
              }
            }
            if (diskRestoreFailures > 0) {
              logger.error('[AgentLoop] Pre-agent disk restore: some files failed to restore locally', {
                projectId, diskRestoreFailures, totalFiles: preAgentDiskSnapshot.size,
              });
            }
            // Every file this run actually changed is about to vanish along with
            // the rest of the revert -- capture those paths for the caveat below
            // before mergedWrites (this run's attempted final state) gets
            // overwritten with the pre-agent set. Must include EXISTING files
            // whose content this run changed, not just brand-new ones: an
            // existing file (e.g. a logo/component the user asked to change)
            // silently restored to its pre-agent content is exactly as much a
            // lost change as a new file vanishing, and this array is the only
            // thing that drives the user-facing warning below -- previously an
            // existing-file revert here produced zero signal to the user.
            droppedFiles.push(...mergedWrites
              .filter((f) => preAgentDiskSnapshot.get(f.path) !== f.content)
              .map((f) => f.path));
            const preAgentFiles = Array.from(preAgentDiskSnapshot.entries()).map(([p, c]) => ({ path: p, content: c }));
            mergedWrites.length = 0;
            preAgentFiles.forEach(f => mergedWrites.push(f));
            // Push the clean pre-agent state to the preview service. This is the
            // last line of defense when repair fails   if it silently fails too,
            // the live preview stays broken with nothing telling the user. Retry
            // with backoff and verify a 200 status (httpPost resolves with
            // {status, body} rather than throwing on non-2xx, so the old
            // try/catch here never actually detected a failed push, only a
            // network-level throw).
            let restorePushOk = false;
            let lastRestoreStatus: number | undefined;
            for (let attempt = 1; attempt <= 3 && !restorePushOk; attempt++) {
              try {
                const restoreRes = await httpPost(updateUrl, JSON.stringify({ files: preAgentFiles, fullSync: true, baseSeq: new Date().toISOString() }), 120_000);
                lastRestoreStatus = restoreRes.status;
                if (restoreRes.status === 200) {
                  restorePushOk = true;
                } else if (attempt < 3) {
                  await new Promise((r) => setTimeout(r, attempt * 1000));
                }
              } catch (restoreErr: any) {
                logger.warn('[AgentLoop] Pre-agent restore push attempt threw', {
                  projectId, attempt, maxAttempts: 3, error: restoreErr?.message,
                });
                if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
              }
            }
            if (restorePushOk) {
              logger.info('[AgentLoop] Pre-agent state restored to preview', { projectId, fileCount: preAgentFiles.length });
            } else {
              logger.error('[AgentLoop] Pre-agent restore push FAILED after 3 attempts, live preview may still show broken code', {
                projectId, lastRestoreStatus: lastRestoreStatus ?? 'none',
              });
              sink.emit('repair-failed', {
                errors: ['Restore to last known-good state failed to reach the preview service   the preview may still show broken code. Try again or manually refresh.'],
              });
            }
          } else {
            // No pre-agent snapshot available   scan disk and push whatever is there
            logger.warn('[AgentLoop] No pre-agent snapshot available, scanning disk and pushing whatever is there', { projectId });
            const salvageDiskMap = new Map<string, string>();
            const collectSalvage = (dir: string) => {
              let entries: fs.Dirent[];
              try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (dirErr: any) {
                logger.debug('collectSalvage: readdirSync failed (non-fatal)', { dir, error: dirErr?.message });
                return;
              }
              for (const entry of entries) {
                if (SKIP_DIRS.has(entry.name)) continue;
                if (SKIP_FILES.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  collectSalvage(fullPath);
                } else {
                  const ext = path.extname(entry.name).toLowerCase();
                  const relPath = path.relative(appPath, fullPath);
                  try {
                    if (BINARY_EXTS_SET.has(ext)) {
                      salvageDiskMap.set(relPath, `${BINARY_SENTINEL}${fs.readFileSync(fullPath).toString('base64')}`);
                    } else {
                      salvageDiskMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
                    }
                  } catch (readErr: any) {
                    logger.debug('collectSalvage: failed to read file (skipped)', { relPath, error: readErr?.message });
                  }
                }
              }
            };
            try { collectSalvage(appPath); } catch (salvageErr: any) {
              logger.debug('_runAgentLoopInner: collectSalvage failed (non-fatal)', { projectId, error: salvageErr?.message });
            }
            const salvageFiles = Array.from(salvageDiskMap.entries()).map(([p, c]) => ({ path: p, content: c }));
            mergedWrites.length = 0;
            salvageFiles.forEach(f => mergedWrites.push(f));
            try {
              await httpPost(updateUrl, JSON.stringify({ files: salvageFiles, fullSync: true, baseSeq: new Date().toISOString() }), 120_000);
            } catch (salvagePushErr: any) {
              logger.warn('_runAgentLoopInner: no-snapshot salvage push failed (non-fatal)', { projectId, error: salvagePushErr?.message });
            }
          }
        }
      } catch (pushErr: any) {
        logger.warn('[AgentLoop] Preview push error', { projectId, userId, error: pushErr?.message, stack: pushErr?.stack });
        throw pushErr;
      }
    } else if (runtimeMode === 'build' && !agentWroteFiles) {
      logger.info('[AgentLoop] No file operations, skipping preview push', { projectId, outerFinishReason });
      if (outerFinishReason === 'tool-calls') {
        // finishReason 'tool-calls' with zero files written can mean two very
        // different things, and telling them apart matters for what the user
        // should actually do next:
        //  - stepCount is near MAX_STEPS: the run genuinely used its whole
        //    budget mid-task   "try again" is honest advice, it'll pick up
        //    roughly where it left off.
        //  - stepCount is low (observed: 5 of 25): the model itself gave up
        //    early, most often right after a provider fallback to a weaker
        //    model (e.g. the primary provider's billing circuit was open).
        //    Claiming "ran out of steps" here is simply false   it burns the
        //    user's trust and points them at the wrong fix ("just resend")
        //    when the real issue is a degraded model, not a budget limit.
        const genuinelyOutOfSteps = stepCount >= MAX_STEPS - 1;
        // Only blame "a fallback provider" when one actually ran this turn
        // (providerFellBackThisRun)   otherwise this was the tier-assigned model
        // (e.g. glm-4.5-flash on the micro tier, max 8 steps) simply not finishing
        // on its own, which is a different, honest thing to tell the user.
        const text = genuinelyOutOfSteps
          ? '\n\n> I ran out of steps before completing the changes. Please send your request again and I\'ll continue from where I left off.'
          : providerFellBackThisRun
          ? `\n\n> I stopped without finishing this change (after ${stepCount} step${stepCount === 1 ? '' : 's'})   a backup AI provider took over partway through this run and didn't complete the change. Nothing was changed. Please send your request again.`
          : `\n\n> I stopped without finishing this change (after ${stepCount} step${stepCount === 1 ? '' : 's'} of ${MAX_STEPS})   the assigned model gave up early rather than running out of budget. Nothing was changed. Please send your request again; a more detailed request sometimes routes to a stronger model.`;
        sink.emit('text-delta', { text });
      }
    }

    const doneFilesToWrite = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...mergedWrites];
    // Include rename "from" paths in filesToDelete so the frontend removes old file entries
    // from workspace state (otherwise both old and new path persist after a rename).
    const renameFromPaths = renames.map(r => r.from).filter(p => !filesToDelete.includes(p));
    const doneFilesToDelete = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...filesToDelete, ...renameFromPaths];
    const doneRenames = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...renames];
    const doneDependencies = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...dependencies];
    const unsupportedPreviewDependencies = doneDependencies.filter((pkg) => !PRE_INSTALLED_PACKAGES.includes(pkg));

    if (unsupportedPreviewDependencies.length > 0) {
      // Legacy XML-declared packages not in the pre-installed set   these should now
      // be installed via run_command by the agent. Show a mild warning for visibility.
      sink.emit('text-delta', {
        text: `\n> *Note: ${unsupportedPreviewDependencies.join(', ')} ${unsupportedPreviewDependencies.length === 1 ? 'was' : 'were'} declared via legacy <ecomgear-add-dependency>. In future runs, use \`run_command\` to install packages directly.*\n\n`,
      });
    }

    if (droppedFiles.length > 0) {
      // See droppedFiles' declaration above: this run wrote these but they
      // failed preview validation and got silently dropped/reverted so the
      // live preview stays healthy. Without this, the response above can
      // read as "done" while part of the request quietly never landed.
      const shown = [...new Set(droppedFiles)].slice(0, 5);
      const more = droppedFiles.length - shown.length;
      sink.emit('text-delta', {
        text: `\n\n> ⚠️ ${shown.map((f) => `\`${f}\``).join(', ')}${more > 0 ? ` (+${more} more)` : ''} failed to build, so ${shown.length + more === 1 ? 'that change was' : 'those changes were'} left out to keep the live preview working. Tell me to try again if you still want ${shown.length + more === 1 ? 'it' : 'them'}.`,
      });
    }

    // Eco is only charged when the run actually wrote/deleted files (ghost
    // runs   text-only answers, plan proposals   stay free), mirroring the
    // wroteFiles gate in ai.routes.ts's incrementEcoUsage call site.
    const chargeableRun = doneFilesToWrite.length > 0 || doneFilesToDelete.length > 0;
    const finalCostUsd = chargeableRun
      ? (runCostUsd > 0 ? runCostUsd : calcCost(runTokens.inputTokens, runTokens.outputTokens, runTokens.cacheReadTokens, runTokens.cacheWriteTokens))
      : 0;
    const finalEcoUsed = chargeableRun ? computeEcoCost(finalCostUsd) : 0;

    // Budget cap hit mid-task, but real progress was made (files actually
    // landed) and the model wasn't just spinning (stuckAnalysisAbortReason
    // unset)   this is the safe case to auto-continue: another pass would
    // very likely pick up and finish, same as a user manually replying
    // "continue" would today. Not offered for a stuck/looping run   retrying
    // that blindly is more likely to spend money re-failing the same way.
    //
    // hitStepCap (checkpoint 6, 2026-08-13) extends this to the step-count
    // ceiling, not just the token/cost cap: a run that used its whole step
    // budget (mirrors genuinelyOutOfSteps's calc above) with real progress
    // and no stuck signal previously got NO signal at all when it wrote some
    // files (the honest zero-files message above only fires when
    // !agentWroteFiles) -- it just silently ended with partial work. This is
    // the same safe-to-continue shape as the budget-cap case, just reached
    // via a different exhausted resource.
    const hitStepCap = outerFinishReason === 'tool-calls' && stepCount >= MAX_STEPS - 1;
    const needsAutoContinue = (Boolean(budgetAbortReason) || hitStepCap) && !stuckAnalysisAbortReason && anySuccessfulWriteThisRun;
    const continuationPrompt = needsAutoContinue
      ? `Continue exactly where you left off on this request: "${prompt}". Do not redo files you already finished   pick up with whatever is left.`
      : undefined;

    // The preview push above already sent mergedWrites (binaries included) to
    // preview-service. The browser gets the same list minus the base64 blobs it
    // cannot use -- see clientFilePayload.ts for why that is safe to omit.
    const clientFilesToWrite = stripBinariesForClient(doneFilesToWrite);
    if (clientFilesToWrite.length !== doneFilesToWrite.length) {
      logger.info('[AgentLoop] done payload: binaries withheld from client', {
        projectId,
        filesTotal: doneFilesToWrite.length,
        filesSent: clientFilesToWrite.length,
        bytesBefore: payloadBytes(doneFilesToWrite),
        bytesAfter: payloadBytes(clientFilesToWrite),
      });
    }

    // NOW send 'done'   preview is synced, frontend shows correct state
    sink.emit('done', {
      ghostRun: runtimeMode === 'build' && !agentWroteFiles,
      filesToWrite: clientFilesToWrite,
      filesToDelete: doneFilesToDelete,
      renames: doneRenames,
      dependencies: doneDependencies,
      mode: runtimeMode,
      summary,
      tokensUsed: runTokens.total || 0,
      costUsd: finalCostUsd,
      ecoUsed: finalEcoUsed,
      // Only expose snapshot to frontend when code actually changed
      snapshotId: doneFilesToWrite.length > 0 ? snapshotId : null,
      previewPushed: previewPushOk,
      // Files were kept (not reverted) but a browser smoke check found the
      // rendered page broken and repair couldn't confirm a fix -- the frontend
      // uses this to hold back its success toast for this run only.
      smokeFailureSurvivedRepair,
      needsAutoContinue,
      continuationPrompt,
    });

    // ── Background: save token usage + npm install (non-blocking) ───────────
    logger.debug('[AgentLoop] background post-response tasks starting', { projectId, userId, agentRunId, stepCount });
    void (async () => {
      // runTokens is already populated by onStepFinish at this point.
      // Fall back to result.usage only if onStepFinish captured nothing (e.g. non-Anthropic provider).
      let tokensUsed = runTokens.total;
      if (tokensUsed === 0) {
        try {
          const usage = await result!.usage;
          tokensUsed = usage?.totalTokens ?? 0;
          runTokens.inputTokens  = (usage as any)?.promptTokens     ?? (usage as any)?.inputTokens     ?? 0;
          runTokens.outputTokens = (usage as any)?.completionTokens ?? (usage as any)?.outputTokens    ?? 0;
        } catch (usageErr: any) {
          logger.debug('_runAgentLoopInner: fallback result.usage read failed (non-fatal)', { projectId, error: usageErr?.message });
        }
      }

      const finalCost = runCostUsd > 0 ? runCostUsd : calcCost(runTokens.inputTokens, runTokens.outputTokens, runTokens.cacheReadTokens, runTokens.cacheWriteTokens);

      // Orchestration Phase 2b (2026-08-09): first real DOM/browser check.
      // Everything before this only proves the code compiles (esbuild, then
      // real type-checking as of Phase 2a) -- neither one loads the actual
      // page, so a runtime-only failure (bad hook order, null deref only
      // reachable once mounted) had zero signal reaching anywhere. Runs here
      // (background, post-response) so it never adds latency to what the
      // user sees. Deliberately observability-only for this pass: records
      // the result to agent_runs.preview_errors (an existing column, never
      // populated before now) rather than wiring it to trigger another
      // repair cycle inside the already-deep, already-many-branched repair
      // loop above -- that's the natural next step once real false-positive
      // rates are known from this data, not a change to make blind.
      // Gated to feature/build tiers (their step budgets are the ones sized
      // for this) and only when the push already looked healthy and code
      // actually changed -- no point checking a run that wrote nothing.
      let previewSmokeErrors: string | null = null;
      // Same tier coverage as the repair-triggering gate above (gap G3): the
      // feature/build-only restriction meant this recorded nothing for 3 days
      // straight, because 84% of real runs are edit or fix.
      //
      // Reuses the pre-response gate's reading when there is one -- that gate
      // already loaded this exact URL in a real browser moments ago, so
      // re-launching Chromium here would double the cost to re-answer a
      // question already answered. Only runs the check itself when the gate
      // did not (kill switch off, or the run reached here another way).
      if (previewPushOk && doneFilesToWrite.length > 0 && _tier !== 'micro') {
        try {
          let smokeResult = smokeGateResult;
          if (!smokeResult) {
            const smokeCheckPreviewBase = process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app';
            smokeResult = await runPreviewSmokeCheck(`${smokeCheckPreviewBase}/preview/${projectId}`);
          }
          if (!smokeResult.skipped && !smokeResult.ok) {
            previewSmokeErrors = smokeResult.errors.join('; ').slice(0, 2000);
            logger.warn('[AgentLoop] Preview smoke check failed (post-response)', { projectId, previewSmokeErrors });
          }
        } catch (smokeErr: any) {
          logger.warn('[AgentLoop] Preview smoke check errored (non-fatal, post-response)', { projectId, error: smokeErr?.message });
        }
      }

      if (tokensUsed > 0) {
        sink.emit('usage', {
          tokensUsed,
          breakdown: {
            input:       runTokens.inputTokens,
            output:      runTokens.outputTokens,
            cacheRead:   runTokens.cacheReadTokens,
            cacheWrite:  runTokens.cacheWriteTokens,
          },
          estimatedCostUsd: parseFloat(finalCost.toFixed(5)),
        });
      }

      // files_written must be the DISTINCT files the agent actually wrote or
      // edited this run (same tracked set the sanitize pass scopes to above),
      // NOT doneFilesToWrite.length -- that is mergedWrites, the fullSync
      // preview payload built from a whole-project-dir walk, so it reads as
      // "entire project" (~180+) on every run that writes anything. That fake
      // number derailed two separate runaway-edit investigations on 2026-08-09
      // before the metric itself was found to be the bug.
      const distinctAgentEditCount = (runtimeMode === 'plan' || !agentWroteFiles)
        ? 0
        : new Set<string>([...filesToWrite.map((f) => f.path), ...filesEdited]).size;

      // Update agent_runs with all completion data (status + token count + snapshot_id)
      if (supabase && agentRunId) {
        supabase.from('agent_runs').update({
          status: 'completed',
          // The column has existed since 20260417100000 with DEFAULT false and
          // nothing ever wrote it, so all 3478 rows read "not promoted" --
          // indistinguishable from 3478 genuinely failed pushes. previewPushOk
          // already holds the answer (and is already reported to the client as
          // `previewPushed`); it just never reached the row.
          preview_promoted: previewPushOk,
          preview_errors: previewSmokeErrors,
          steps_taken: stepCount,
          files_written: distinctAgentEditCount,
          files_deleted: doneFilesToDelete.length,
          dependencies: doneDependencies,
          summary,
          tokens_used: tokensUsed,  // column added in 20260405130000_agent_runs_tokens.sql
          request_tier:       _tier ?? null,
          model_used:         modelId,
          estimated_cost_usd: finalCost,
          input_tokens:       runTokens.inputTokens,
          output_tokens:      runTokens.outputTokens,
          cache_read_tokens:  runTokens.cacheReadTokens,
          cache_write_tokens: runTokens.cacheWriteTokens,
          is_internal:        isInternalRun,
          narration_cost_usd: getNarrationCost(projectId),
          // Only link snapshot when code actually changed; null means no restore point
          snapshot_id: doneFilesToWrite.length > 0 ? snapshotId : null,
          completed_at: new Date().toISOString(),
          // Both computed above but previously discarded after the 'done' SSE
          // event   this is the queryable data Phase 2 of the enhancement
          // checklist needed to stop tuning STUCK_ANALYSIS_THRESHOLD and the
          // step-budget-exhaustion logic by incident instead of real outcomes.
          stuck_abort_reason:  stuckAnalysisAbortReason,
          needs_auto_continue: needsAutoContinue,
          edit_search_miss_count:          ctx.editSearchMissCount ?? 0,
          build_error_circuit_break_count: ctx.buildErrorCircuitBreakCount ?? 0,
          net_new_write_count:                    ctx.netNewWriteCount ?? 0,
          net_new_write_without_retrieval_count:   ctx.netNewWriteWithoutRetrievalCount ?? 0,
        }).eq('id', agentRunId).then(
          ({ error }) => {
            if (error) {
              logger.warn('[AgentLoop] agent_runs update failed', { projectId, agentRunId, error: error.message });
            } else {
              logger.debug('_runAgentLoopInner: agent_runs update succeeded', { projectId, agentRunId });
            }
          },
          (e: any) => logger.warn('[AgentLoop] agent_runs update rejected', { projectId, agentRunId, error: e?.message }),
        );
      }

      // Server-side revision persistence (2026-08-10). The durable record of
      // this run's output must be written HERE, by the run itself -- not
      // delegated to the browser's fire-and-forget saveWorkspaceToDb(), whose
      // silent client-side failure left revisions describing pre-run state
      // and let a later Editor preview sync revert the agent's work (CardPro
      // logo, 2026-08-09). Awaited deliberately: a couple of seconds of
      // dedup-aware uploads at run-end buys a durability guarantee; failures
      // log server-side where they are actually observable.
      if (supabase && userId && doneFilesToWrite.length > 0) {
        try {
          const persistResult = await persistAgentRevision(
            projectId, userId, doneFilesToWrite,
            summary || `Agent run: ${stepCount} step(s)`, prompt,
          );
          if (persistResult.ok) {
            logger.info('[AgentLoop] Revision persisted server-side', {
              projectId, userId, revisionId: persistResult.revisionId, fileCount: doneFilesToWrite.length,
            });
          } else {
            logger.warn('[AgentLoop] Server-side revision persist FAILED, durable state may lag the live preview', {
              projectId, userId, error: persistResult.error,
            });
          }
        } catch (persistErr: any) {
          logger.warn('[AgentLoop] Server-side revision persist threw', { projectId, userId, error: persistErr?.message });
        }
      }

      // If no code changed (ghost run or plan), delete the snapshot dir we pre-created
      if (snapshotDir && doneFilesToWrite.length === 0) {
        fs.promises.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
      }

      // Update the latest revision's preview_url after a successful preview push
      // so the Editor can load it directly without needing to re-sync on open.
      if (supabase && previewPushOk && doneFilesToWrite.length > 0) {
        const publicPreviewBase = process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app';
        const revisionPreviewUrl = `${publicPreviewBase}/preview/${projectId}/`;
        supabase.from('revisions')
          .update({ preview_url: revisionPreviewUrl, preview_status: 'ready' })
          .eq('project_id', projectId)
          .then(
            ({ error }) => {
              if (error) logger.warn('[AgentLoop] revision preview_url update failed', { projectId, error: error.message });
            },
            (e: any) => logger.warn('[AgentLoop] revision preview_url update rejected', { projectId, error: e?.message }),
          );

        // Capture a screenshot thumbnail   fire-and-forget, never blocks the response
        captureThumbnail(projectId, revisionPreviewUrl, supabase);
      }

      // ── Prune old snapshots for this project (keep MAX_SNAPSHOTS_PER_PROJECT) ──
      // Runs in the background after agent_runs is updated so it can query the DB.
      if (supabase) {
        (async () => {
          try {
            // Fetch all completed snapshots for this project, oldest first
            const { data: runs } = await supabase
              .from('agent_runs')
              .select('id, snapshot_id, created_at')
              .eq('project_id', projectId)
              .eq('status', 'completed')
              .not('snapshot_id', 'is', null)
              .order('created_at', { ascending: false });

            if (!runs || runs.length <= MAX_SNAPSHOTS_PER_PROJECT) return;

            const toprune = runs.slice(MAX_SNAPSHOTS_PER_PROJECT);
            const pruneIds = toprune.map((r: any) => r.id);
            const pruneSnapshotIds = toprune.map((r: any) => r.snapshot_id as string).filter(Boolean);

            // Delete snapshot directories from disk
            for (const sid of pruneSnapshotIds) {
              const dir = path.join(SNAPSHOTS_DIR, sid);
              try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (rmErr: any) {
                logger.debug('_runAgentLoopInner: snapshot dir removal failed (skipped)', { projectId, snapshotId: sid, error: rmErr?.message });
              }
            }

            // Clear snapshot_id from those DB rows (they're gone from disk)
            await supabase
              .from('agent_runs')
              .update({ snapshot_id: null })
              .in('id', pruneIds);
            logger.debug('_runAgentLoopInner: snapshot pruning complete', { projectId, prunedCount: pruneIds.length });
          } catch (pruneErr: any) {
            logger.warn('[AgentLoop] Snapshot pruning failed', { projectId, error: pruneErr?.message });
          }
        })();
      }
    })();

    // Semantic cache: only store a fresh, empty-project, first-message BUILD
    // run that actually produced files and didn't get stuck -- that's the one
    // context (see the read-side hint above) where reusing this exact output
    // for a different project's near-identical prompt is safe: a fresh
    // project has nothing to conflict with. Fire-and-forget; never blocks the
    // response the user is waiting on.
    if (isEmptyProject && isFirstMessage && runtimeMode === 'build'
      && doneFilesToWrite.length > 0 && !stuckAnalysisAbortReason) {
      const snapshot: Record<string, string> = {};
      for (const f of doneFilesToWrite) snapshot[f.path] = f.content;
      void storeSemanticCache({ prompt, framework: 'react', fileSnapshot: snapshot });
    }

    if (agentTimeoutId) clearTimeout(agentTimeoutId);
    clearInterval(heartbeatId);
    logger.info('_runAgentLoopInner: returning successfully', {
      projectId, userId, durationMs: Date.now() - _innerStartedAtMs, stepCount,
      filesWritten: doneFilesToWrite.length, filesDeleted: doneFilesToDelete.length, renames: doneRenames.length,
      costUsd: finalCostUsd, ecoUsed: finalEcoUsed, needsAutoContinue: Boolean(needsAutoContinue),
      stuckAborted: Boolean(stuckAnalysisAbortReason), runtimeMode,
    });
    return { filesToWrite: doneFilesToWrite, filesToDelete: doneFilesToDelete, renames: doneRenames, dependencies: doneDependencies, summary, costUsd: finalCostUsd, ecoUsed: finalEcoUsed, needsAutoContinue, continuationPrompt, buildHealthy: ctx.lastBuildErrorsHealthy === true, stuckAborted: Boolean(stuckAnalysisAbortReason), runtimeMode };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (agentTimeoutId) clearTimeout(agentTimeoutId);
    clearInterval(heartbeatId);

    const isAbort = abortController.signal.aborted || err?.name === 'AbortError';
    if (isAbort) {
      if (abortSignal?.aborted) {
        logger.warn('[AgentLoop] Aborted due to client disconnect', { projectId, userId, stepCount, durationMs: Date.now() - _innerStartedAtMs });
      } else {
        logger.warn('[AgentLoop] Aborted due to timeout/cancellation', { projectId, userId, stepCount, durationMs: Date.now() - _innerStartedAtMs });
      }

      const abortError = err instanceof Error ? err : new Error('Generation cancelled');
      (abortError as { sseErrorEmitted?: boolean }).sseErrorEmitted = true;
      (abortError as { clientAborted?: boolean }).clientAborted = Boolean(abortSignal?.aborted);

      if (supabase && agentRunId) {
        supabase.from('agent_runs').update({
          status: 'failed',
          error_message: abortSignal?.aborted ? 'Cancelled: client disconnected' : 'Cancelled: aborted',
          completed_at: new Date().toISOString(),
          is_internal: isInternalRun,
          estimated_cost_usd: runCostUsd,
          input_tokens: runTokens.inputTokens,
          output_tokens: runTokens.outputTokens,
          cache_read_tokens: runTokens.cacheReadTokens,
          cache_write_tokens: runTokens.cacheWriteTokens,
          narration_cost_usd: getNarrationCost(projectId),
          stuck_abort_reason: stuckAnalysisAbortReason,
          edit_search_miss_count:          ctx.editSearchMissCount ?? 0,
          build_error_circuit_break_count: ctx.buildErrorCircuitBreakCount ?? 0,
          net_new_write_count:                    ctx.netNewWriteCount ?? 0,
          net_new_write_without_retrieval_count:   ctx.netNewWriteWithoutRetrievalCount ?? 0,
        }).eq('id', agentRunId).then(() => {}, () => {});
      }

      throw abortError;
    }

    logger.error('[AgentLoop] Error', {
      projectId, userId, stepCount, durationMs: Date.now() - _innerStartedAtMs,
      error: err?.message, stack: err?.stack,
    });

    let errorMessage = err?.message ?? 'Agent loop failed';

    // Network errors: give a clear, actionable message instead of the raw DNS error
    if (isNetworkError(err)) {
      if (isTransientStreamDrop(err)) {
        // Mid-stream connection reset   transient, not a server connectivity issue
        errorMessage = 'Connection to AI provider dropped mid-generation (network blip). This is usually temporary   please try again.';
      } else {
        errorMessage = 'Could not reach the AI provider (network error). Check your server\'s internet connectivity or configure a different model in Admin → Settings.';
      }
    }

    // Provider outage (credit exhaustion, usage limits, quota)   OUR problem,
    // not the user's. This branch must win over the raw-body extraction below:
    // before this reordering, Anthropic's literal billing text ("Your credit
    // balance is too low... go to Plans & Billing") was forwarded verbatim to
    // end users (observed in production logs, 18 occurrences Jun 12 - Jul 17).
    const isOutage = isAuthOrBillingError(err);
    if (isOutage) {
      logger.error('[ProviderOutage] severity=critical, all providers failed with billing/credit/quota errors', {
        projectId, userId, rawErrorMessage: String(err?.message ?? err).slice(0, 300),
      });
      errorMessage = 'The AI service is temporarily unavailable   this is an issue on our side, not with your project. Your work is safe. Please try again in a little while.';
    } else {
      // Extract inner AI SDK APICallError messages if present
      if (errorMessage.includes('No output generated')) {
        errorMessage = err?.cause?.message ||
          'The AI provider rejected the request. Please try again in a moment.';
      }
      // Look for provider-specific API errors in the raw data
      if (err?.data?.error?.message) {
        errorMessage = err.data.error.message;
      } else if (err?.responseBody) {
        try {
          const body = JSON.parse(err.responseBody);
          if (body.error?.message) {
            errorMessage = body.error.message;
          }
        } catch (parseErr: any) {
          // ignore JSON parse error
          logger.debug('_runAgentLoopInner: err.responseBody JSON parse failed (ignored)', { projectId, error: parseErr?.message });
        }
      }
    }
    logger.error('[AgentLoop] emitting error to sink and marking agent_runs failed', {
      projectId, userId, agentRunId, errorMessage,
    });

    sink.emit('error', { message: errorMessage });
    if (err && typeof err === 'object') {
      (err as { sseErrorEmitted?: boolean }).sseErrorEmitted = true;
    }
    // Update agent_runs on failure
    if (supabase && agentRunId) {
      supabase.from('agent_runs').update({
        status: 'failed',
        error_message: err?.message ?? 'Unknown error',
        completed_at: new Date().toISOString(),
        is_internal: isInternalRun,
        estimated_cost_usd: runCostUsd,
        input_tokens: runTokens.inputTokens,
        output_tokens: runTokens.outputTokens,
        cache_read_tokens: runTokens.cacheReadTokens,
        cache_write_tokens: runTokens.cacheWriteTokens,
        narration_cost_usd: getNarrationCost(projectId),
        stuck_abort_reason: stuckAnalysisAbortReason,
        edit_search_miss_count:          ctx.editSearchMissCount ?? 0,
        build_error_circuit_break_count: ctx.buildErrorCircuitBreakCount ?? 0,
        net_new_write_count:                    ctx.netNewWriteCount ?? 0,
        net_new_write_without_retrieval_count:   ctx.netNewWriteWithoutRetrievalCount ?? 0,
      }).eq('id', agentRunId).then(() => {}, () => {});
    }
    throw err;
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
}
