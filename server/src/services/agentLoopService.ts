
import { streamText, generateText, ToolSet, stepCountIs, jsonSchema, wrapLanguageModel } from 'ai';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { AgentContext } from '../agent-tools/types.js';
import { safeJoin } from '../agent-tools/types.js';
import { EDGE_FUNCTIONS_DIR } from '../agent-tools/write_edge_function.js';
import { sanitizeFileContent, sanitizeConfigFile } from '../agent-tools/sanitize.js';
import ts from 'typescript';
import { getAppBuilderBuildSystemPrompt, getAppBuilderSystemPrompt, MICRO_SYSTEM_PROMPT, getFixSystemPrompt, getEditSystemPrompt } from '../prompts/app-builder.prompt.js';
import { PRE_INSTALLED_PACKAGES } from './baseTemplateService.js';
import { RunStateLedger } from './runStateLedger.js';
import { canonicalizeModelId, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL } from '../config/models.js';
import { indexFile, indexFiles, retrieveRelevantFiles, extractSymbols } from '../knowledgebase/index.js';
import { captureThumbnail } from './thumbnailService.js';
import { createStripToolsForCacheMiddleware } from './geminiToolCache.service.js';
import { beginRun as beginNarration, updateThought, endRun as endNarration, generateStatus, getNarrationCost, type LifecyclePhase } from './narration.service.js';
import { lookupFailureFix, storeFailureFix } from './failureMemory.service.js';
import { databaseService } from './database.service.js';
import {
  isBillingCircuitOpen, tripBillingCircuit, extractCacheUsage,
  isRetryableError, isRateLimitError, sanitizeErrorMessage, isAuthOrBillingError,
  isNetworkError, isTransientStreamDrop, getRetryAfterMs, getDefaultAgentTimeoutMs,
  isLikelyFixRequest, buildFallbackCandidates, createProviderForModel, resolveProviderWithFallback,
} from './agentProviderResolution.js';
import { snapshotProject, restoreSnapshot, createGeminiRunCache, SNAPSHOTS_DIR, MAX_SNAPSHOTS_PER_PROJECT } from './agentSnapshot.js';
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

// Supabase service-role client for agent_runs tracking (fire-and-forget)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const SUPPRESS_RECOVERY_UI = (process.env.AGENT_SUPPRESS_RECOVERY_UI ?? '1') !== '0';

// Self-healing backfill for projects that had edge functions written before
// the __edge_functions__/ mirror existed. Runs once at the start of every
// agent run   cheap (single query, early-exits when nothing's missing) and
// spreads the fix across every existing project the next time each one is
// actually used, instead of a one-off bulk migration touching every live
// preview at once.
async function backfillEdgeFunctionMirrors(appPath: string, projectId: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: fns } = await supabase
      .from('edge_functions')
      .select('name, code')
      .eq('project_id', projectId);
    if (!fns || fns.length === 0) return;

    for (const fn of fns) {
      if (!fn.name || typeof fn.code !== 'string') continue;
      const mirrorPath = safeJoin(appPath, `${EDGE_FUNCTIONS_DIR}/${fn.name}.js`);
      if (fs.existsSync(mirrorPath)) continue;
      try {
        fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
        fs.writeFileSync(mirrorPath, fn.code, 'utf8');
      } catch { /* best-effort   a write failure here shouldn't block the run */ }
    }
  } catch { /* best-effort   DB unavailable shouldn't block the run */ }
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
  return Math.round(clamped * 10) / 10;
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
  return union === 0 ? 0 : intersection / union;
}

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
}

export async function runAgentLoop(params: AgentRunParams): Promise<AgentRunResult> {
  const { projectId } = params;

  // ── Per-project mutex: prevent interleaved file writes from concurrent runs ──
  const lock = acquireProjectLock(projectId);
  await lock.ready;
  try {
  return await _runAgentLoopInner(params);
  } finally {
    lock.release();
    endNarration(projectId);
    // Clean up the lock chain entry if we're the last in queue
    cleanupProjectLock(projectId);
  }
}

async function _runAgentLoopInner(params: AgentRunParams): Promise<AgentRunResult> {
  const { prompt, projectId, appPath, model, mode, existingFiles, history, olderSummary, promptIntent, attachments, projectKnowledge, projectSecrets, sink, userId, abortSignal, agentLockToken } = params;

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

  const boundedPrompt = clampContextSection('User prompt', prompt, MAX_PROMPT_CHARS);
  const boundedOlderSummary = olderSummary
    ? clampContextSection('Earlier conversation summary', olderSummary, MAX_OLDER_SUMMARY_CHARS)
    : undefined;
  const runtimeMode: 'build' | 'plan' = mode === 'plan' ? 'plan' : 'build';

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
    console.warn(`[AgentLoop] Requested model ${requestedModelId} is disabled (AI_DISABLED_MODEL_IDS)   substituting ${substitute}`);
    requestedModelId = substitute;
  }

  if (requestedModelId === 'deepseek-reasoner') {
    throw new Error('DeepSeek Reasoner (R1) does not support the necessary tool-calling features. Please select deepseek-chat instead.');
  }

  const resolvedModel = resolveProviderWithFallback(requestedModelId);
  const aiProvider = resolvedModel.provider;
  const providerName = resolvedModel.providerName;
  const modelId = resolvedModel.modelId;
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
    const { data: projectOrgRow } = await supabase
      .from('projects')
      .select('organization_id, organizations!inner(is_internal)')
      .eq('id', projectId)
      .maybeSingle();
    projectOrgId = (projectOrgRow as any)?.organization_id ?? null;
    orgIsInternal = Boolean((projectOrgRow as any)?.organizations?.is_internal);
  }

  // ─── agent_runs tracking (fire-and-forget) ───────────────────────────────────
  let agentRunId: string | null = null;
  if (supabase && userId) {
    const { data } = await supabase
      .from('agent_runs')
      .insert({ project_id: projectId, user_id: userId, prompt, model: modelId, organization_id: projectOrgId })
      .select('id')
      .single();
    agentRunId = data?.id ?? null;
  }

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
  let circuitBreakerNote = '';

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
    readFiles: new Set<string>(),
    pendingPreviewFiles: new Map<string, string>(),
    editFailures: new Map<string, number>(),
    buildErrorCallCount: 0,
    dbQueryCallCount: 0,
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

  if (_tier === 'micro') {
    // ── MICRO FAST PATH ──────────────────────────────────────────────────────
    // A color/text/spacing change touches exactly one file. Find it with a
    // targeted scan   no full disk read, no import graph, no KB query.
    const promptWords = promptLower.split(/[\s,./'"!?()[\]{}]+/).filter(w => w.length > 2);
    const findMentioned = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { findMentioned(fullPath); continue; }
        const relPath = path.relative(appPath, fullPath);
        const fname = entry.name.toLowerCase().replace(/\.(tsx?|jsx?|css)$/, '');
        if (fname && promptWords.some(w => fname.includes(w) || w.includes(fname))) {
          try { preAgentDiskSnapshot.set(relPath, fs.readFileSync(fullPath, 'utf8')); } catch {}
        }
      }
    };
    try { findMentioned(path.join(appPath, 'src')); } catch {}
    // If nothing matched by name, grab App.tsx as fallback orientation
    if (preAgentDiskSnapshot.size === 0) {
      const appTsx = path.join(appPath, 'src', 'App.tsx');
      try {
        const rel = path.relative(appPath, appTsx);
        preAgentDiskSnapshot.set(rel, fs.readFileSync(appTsx, 'utf8'));
      } catch {}
    }
  } else {
    // ── FULL DISK SNAPSHOT (fix / edit / feature / build) ────────────────────
    const snapDisk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SNAP_SKIP_FILES.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { snapDisk(fullPath); }
        else {
          const relPath = path.relative(appPath, fullPath);
          try { preAgentDiskSnapshot.set(relPath, fs.readFileSync(fullPath, 'utf8')); } catch {}
        }
      }
    };
    try { snapDisk(appPath); } catch {}
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
    indexFiles(projectId, fileSources).catch(() => {});
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

  // KB vector retrieval   skip for micro (partial snapshot) and fix (2s latency with no benefit;
  // fix agent calls get_build_errors first and reads only the broken file).
  const kbScores = new Map<string, number>(); // path → 0-50 bonus points
  if (_tier !== 'micro' && _tier !== 'fix' && projectId) {
    try {
      const kbResults = await Promise.race([
        retrieveRelevantFiles(projectId, prompt, fileSources, {
          maxFiles: 6,
          graphExpansion: false,
          mentionedPaths: [...directlyMentioned],
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('kb timeout')), 2000)),
      ]);
      // Multiply by 80 so a strong KB hit (score 0.8) = 64 pts   enough to beat the
      // criticalFiles baseline (60) and actually influence file selection.
      for (const r of kbResults) kbScores.set(r.path, Math.round(r.score * 80));
    } catch {
      // Non-fatal   heuristic sort still works without KB
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
    } catch {
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
    const TEXT_TYPES = new Set([
      'text/plain', 'text/csv', 'text/markdown',
      'application/json',
    ]);

    const parts: string[] = [];
    for (const att of attachments) {
      // Validate tempPath exists and is under /tmp to prevent path traversal
      const resolvedPath = path.resolve(att.tempPath);
      if (!resolvedPath.startsWith(os.tmpdir()) || !fs.existsSync(resolvedPath)) {
        parts.push(`- **${att.name}**   file not found or access denied`);
        continue;
      }

      if (att.category === 'image') {
        try {
          const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');

          // Read bytes upfront   needed for both vision analysis and preview push
          let imgBytes: Buffer | null = null;
          try { imgBytes = await fs.promises.readFile(resolvedPath); } catch { /* best-effort */ }

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
            inlineAnalysis = await analyzeImageWithVision(
              imgBytes.toString('base64'), att.type, att.name, aiProvider, abortSignal,
              (usage) => {
                const p = priceFor(modelId);
                runTokens.inputTokens += usage.inputTokens;
                runTokens.outputTokens += usage.outputTokens;
                runCostUsd += (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
              },
            );
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
            } catch { /* best-effort */ }

            // NOTE: imageVisionData.push already done unconditionally above this if/else block

            const visualDesc = inlineAnalysis
              ? `\n  Visual analysis: ${inlineAnalysis}`
              : '';

            const oldAssetsNote = existingAssetsList
              ? `\n  Existing image assets: ${existingAssetsList}. If you are REPLACING one of these, call delete_file on the old path FIRST, then call place_asset.`
              : '';

            parts.push(
              `- **Image**: "${att.name}"${visualDesc}\n` +
              `  Temporary path: \`${resolvedPath}\`\n` +
              `  The image has NOT been copied to the project yet. To use it as a project asset:\n` +
              `  1. Determine WHERE it should go based on the user's message AND the visual analysis above (logo, hero, background, icon, etc.)\n` +
              `  2. If replacing an existing asset: call delete_file("old/path/here") FIRST\n` +
              `  3. Call place_asset(tmpPath: "${resolvedPath}", destName: "${safeName}") to copy it to public/assets/${safeName}\n` +
              `  4. Update every component/file that referenced the old asset to use the new filename\n` +
              `  Path rules after placing (MUST follow   preview runs at non-root base URL):\n` +
              `  • CORRECT: <img src={\`\${import.meta.env.BASE_URL}assets/${safeName}\`} />\n` +
              `  • WRONG:   <img src="/assets/${safeName}" />  (404 in preview)\n` +
              `  • WRONG:   any hardcoded http:// or localhost URL\n` +
              `  Always use import.meta.env.BASE_URL (no leading slash on the filename part).${oldAssetsNote}`
            );
          }
        } catch (copyErr: any) {
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
    attachmentContext = `\n\n# User-Attached Files\n\nThe user attached the following files with this message.\n\n**IMPORTANT   Images are NOT yet in the project.** Each image stays in a temporary path until you explicitly call \`place_asset\` to copy it to \`public/assets/\`. You MUST call \`place_asset\` before you can reference an image in any component.\n\n**YOUR OBLIGATION:** You MUST act on these files as the user instructs. Do not just acknowledge them   actually use them in the code.\n\nCommon scenarios   execute immediately:\n- "use as logo / header logo" → call place_asset to place the image, then update the Navbar/Header component to render an \`<img>\` using it\n- "use as favicon" → call place_asset, then write to \`public/favicon.ico\` (or .png) and update \`index.html\` \`<link rel="icon">\`\n- "use as hero / banner" → call place_asset, then place in the hero section of the relevant page\n- "use as background" → call place_asset, then apply as CSS \`background-image\` on the specified element\n- "use this data / content" → parse the document content and populate the UI with it\n- General "use this" → infer the best placement from context and the image description\n\nAlways modify the actual component files to reference the image. An image that was never placed with \`place_asset\` cannot be referenced in code.\n\n${parts.join('\n\n')}`;
    attachmentContext = clampContextSection('Attachment context', attachmentContext, MAX_ATTACHMENT_CONTEXT_CHARS);
  }

  // ── Pre-flight vision analysis ────────────────────────────────────────────
  // BEFORE the agent loop starts, ask the model to describe each uploaded image.
  // This gives the agent a concrete textual understanding of the image content
  // ("company logo with a blue shield and white text 'EcomGear'") so it can
  // decide the correct action without guessing from the filename alone.
  // Only runs when the selected model supports vision (Claude, Gemini   not DeepSeek).
  if (visionCapable && imageVisionData.length > 0) {
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

  // Detect if this is the first build on an empty/new project.
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
  const shouldConfirmFirst = isEmptyProject && isFirstMessage && runtimeMode === 'build';

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

  // Efficiency instruction   scope it to the tier so micro/fix stay fast but edit
  // still verifies imports (skipping that check is the #1 source of build errors).
  // In plan mode, tier instructions must be suppressed   they reference file-modification
  // workflows (touch, read, write) that contradict plan-mode restrictions.
  const tierInstruction = runtimeMode === 'plan' ? ''
    : _tier === 'micro'
      ? '\n\n# Efficiency Mode\nDo NOT write any text before your first tool call. Call `think` once (≤40 words), read the file, make the change, done.\n\n**REQUIRED final message**   write exactly this format:\n"I\'ve [verb] [what] in [filename]. [One sentence on what the user will now see.]"\nExample: "I\'ve changed the button color to indigo in Header.tsx. The nav bar buttons now match the brand palette."\nFORBIDDEN: "Done.", "OK.", empty message, or any single-word reply.'
      : _tier === 'fix'
        ? '\n\n# Fix Mode\nDo NOT write any text before your first tool call. Start with tools directly. Call `think` once   identify root cause, read the broken file, fix it, verify with `get_build_errors`.\n\n**Progress narration**   after each file you fix, write one short sentence like "Fixed the import error in Navbar.tsx   now checking the build." before moving to the next file.\n\n**REQUIRED final message**   AT LEAST 2 sentences:\n1. What the error was and which file it was in.\n2. What you changed to fix it.\nFORBIDDEN: "Done.", "Fixed.", "OK.", or any single-word reply.'
        : _tier === 'edit'
          ? '\n\n# Edit Mode\nDo NOT write any text before your first tool call. Start with tool calls directly. Call `think` once   list the 1–3 files you will touch.\n\n**Progress narration (REQUIRED)**   after each file you write or edit, output one short sentence telling the user what you just did and what you\'re doing next. Examples:\n- "Updated the Navbar   now working on the hero section."\n- "Added the cart drawer to CartDrawer.tsx   updating the context next."\nThis keeps the user informed while you work.\n\n**HARD FILE LIMIT**   more than 5 files? STOP after the 5th, tell the user what changed and what remains.\n\n**REQUIRED final message**   AT LEAST 2 sentences: what changed and what the user will see differently.\nFORBIDDEN: "Done.", "OK.", any single word, or any message under 15 words.'
          : '\n\nDo NOT write any text before your first tool call. Start with tool calls directly.\n\n**Progress narration (REQUIRED)**   after each file you write or create, output one short sentence telling the user what you just did and what comes next. Keep it brief and specific. Examples:\n- "Built the Navbar with sticky positioning and a cart icon   now creating the hero banner."\n- "Added HeroBanner.tsx with a full-width gradient   moving on to the categories section."\n- "Categories grid done   now wiring up the product cards."\nThis narration shows the user the build is progressing in real time.\n\n**REQUIRED final message**   AT LEAST 3 sentences after ALL changes:\n1. What you built and in which files.\n2. How the feature works from the user\'s perspective.\n3. Any important decisions the user should know.\nFORBIDDEN: "Done.", "Complete.", or any response under 20 words.';

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
                includeSeo: promptIntent?.isWebsiteBuild === true,
                includeIntegration: promptIntent?.hasIntegrationRequest === true,
                includeErrorPatterns: isEmptyProject,
                includeCapabilities: isEmptyProject,
                includePreviewEnvironment: isEmptyProject,
              })
            : getAppBuilderSystemPrompt(promptProfile);

  console.log(
    `[AgentLoop] Prompt profile=${promptProfile} tier=${_tier ?? 'unset'} maxSteps=${MAX_STEPS} staticChars=${staticSystemPrompt.length} ` +
    `website=${promptIntent?.isWebsiteBuild === true} integration=${promptIntent?.hasIntegrationRequest === true} emptyProject=${isEmptyProject}`
  );

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
      try {
        const tables = await databaseService.listTables(userId, projectId);
        liveSchemaBlock = tables.length === 0
          ? '\n\n**Current schema: no tables yet.** Use `query_database` with CREATE TABLE to add some before writing data-dependent code.'
          : '\n\n**Current schema (live, as of this message):**\n' + tables.map((t) => {
              const cols = t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(', ');
              return `- ${t.name} (${t.row_count ?? '?'} rows): ${cols}`;
            }).join('\n') +
            '\n\nUse these EXACT table/column names   never guess or invent one. If you need to change the schema, call `query_database`, then re-check via `get_database_schema` before writing dependent code.';
      } catch {
        // Non-fatal   agent can still call get_database_schema itself
      }
    }

    const dbNote = hasDb
      ? '\n\nThis project\'s hosted database is the ONLY place for application data (any table the user asks for   posts, products, orders, custom records, etc.).' +
        '\n\n**⚠️ CRITICAL   this database has NO row-level security.** `VITE_DB_ANON_KEY` is bundled straight into the public JS bundle (anyone can read it via devtools), and its role has a flat `GRANT SELECT` on every table   not scoped per user, per row, or by ownership. There is no `auth.uid()`-style policy layer like real Supabase. Direct client-side PostgREST access lets every visitor read or corrupt every table in full, public data or not   there is nothing stopping them. This is why direct frontend database access is never used here (see the rule right below): edge functions are the only place `db.*` access is safe to grant.' +
        '\n\n**ALL database work MUST go through edge functions   never call the database directly from frontend code, including read-only data.** Use `write_edge_function` for every read and write: user-specific/private data (orders, profiles, messages, anything with an owner), ALL writes (INSERT/UPDATE/DELETE from the browser bypasses any validation you meant to enforce), anything requiring authorization logic ("only the owner can see this"), AND plain public reads (a product catalog, public blog posts, a leaderboard)   there is no exception for "it\'s just public read-only data." The frontend must never construct a `import.meta.env.VITE_DB_API_URL/rest/v1/<table>` fetch itself; every piece of data the UI needs comes from an edge function you write and the frontend invokes via the pattern below. Inside an edge function, `VITE_DB_API_URL` is never needed   the privileged `db.*` helper is already scoped to this project\'s isolated schema.' + liveSchemaBlock +
        (hasSb ? ' This hosted database has NO auth/login server of its own   it is Postgres + PostgREST only. Never attempt to hit `VITE_DB_API_URL/auth/...`   that endpoint does not exist here; auth always goes through Supabase (above).' : '') +
        '\n\n**Login/signup/password checks are SECURITY-CRITICAL and MUST be an edge function   never a direct client-side PostgREST call.** Querying `users?email=eq.X&password=eq.Y` straight from the browser puts the password in the URL (logged everywhere) and exposes the whole table to anyone with the anon key. Write an edge function that looks up the user via `db.select` and compares a HASHED password server-side; return only a session token/user object.\n' +
        '\n\n**Edge functions**   use `write_edge_function` for server-side logic the browser should never run directly: auth/password checks (above), any user-specific or private data access, any write, code that needs a secret API key, webhook handlers, scheduled/triggered jobs, or any multi-step backend operation. Do NOT put that logic in frontend code just because it seems simpler   if it touches private/owned data, writes anything, needs a secret, touches passwords, or must run server-side, it MUST be an edge function. Inside the function, read saved secrets with the EXACT key name they were saved under, including a `VITE_` prefix if that\'s how it\'s stored   `secrets.VITE_DB_API_URL`, not `secrets.DB_API_URL`. Guessing a shortened name silently breaks every call in the function (the "secrets not configured" guard trips immediately) with no visible error until someone actually tests it. Check the actual secret list above instead of assuming a name (save new keys with `set_secret` first   never paste key values into function code or frontend files).\n' +
        '\n\n**Writing an edge function is not the task   wiring it up is.** A function that exists in the database but that no frontend code ever calls does nothing; the app keeps using whatever it was using before, and it will look to the user like "the edge function isn\'t doing anything" even though the function itself is fine. Every time you write or update an edge function for an existing feature, in the SAME turn: (1) find every place in the frontend that currently does this work directly (a raw fetch, a `getDbUrl(...)` call, inline logic) and (2) replace it with an invoke call to the function, deleting the old direct-access code path. Never leave a newly written function orphaned while the old code keeps running.\n' +
        '\n\n**Do not write a generic pass-through proxy** (e.g. one function that accepts an arbitrary `path`/`method`/`body` and forwards it straight to the database) as a way to satisfy "route through edge functions." That technically avoids a direct frontend fetch but adds zero real authorization or validation   it\'s functionally identical to direct client access, just relocated. Each edge function should implement one specific operation (or a small, named set of operations) with real server-side logic: check who\'s asking, validate the input, only allow what that specific operation actually needs.\n' +
        'Invoke a written function from the frontend with:\n```ts\nconst res = await fetch(`${import.meta.env.VITE_FUNCTIONS_API_URL}/api/v1/functions/<name>/invoke`, {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\', apikey: import.meta.env.VITE_DB_ANON_KEY },\n  body: JSON.stringify({ params: { /* ... */ } }),\n});\n```\nNo project_id is needed   the anon key itself identifies which project\'s function to run.\n' +
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
  const EDIT_MODE_INSTRUCTION = '\n\n# Runtime Mode Instruction\nExecute immediately   start with tool calls directly. Do NOT write any text before your first tool call. No "I\'ll...", no "Let me...", no acknowledgments before tools. Do NOT ask for confirmation. Do NOT rewrite files not involved in the change. If intent is unclear, ask one short question before calling tools.\n\n**Progress narration (REQUIRED)**   after each file you edit or create, write one short sentence telling the user what you just changed and what you\'re doing next. Example: "Updated the header in Navbar.tsx   now fixing the color in HeroBanner.tsx." This keeps the user informed while you work.\n\n**REQUIRED final message**   once all changes are done, write AT LEAST 2 full sentences. Start with "I\'ve [verb]..." and name the files and exact changes. Then explain what the user will see differently. FORBIDDEN: "Done.", "OK.", "Updated.", any single word, or any message shorter than 15 words.';
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
    tierInstruction +
    (boundedOlderSummary
      ? `\n\n# Earlier Conversation Summary\n\nThis is a summary of older messages in this conversation. Use it to maintain continuity:\n\n${boundedOlderSummary}`
      : '') +
    (boundedFileTree
      ? `\n\n# Project File Tree\n\nThese are ALL the files currently on disk. This is authoritative   if a file is not listed here, it does NOT exist. Use this to verify imports and plan which files to create or edit.\n\n\`\`\`\n${boundedFileTree}\n\`\`\``
      : '\n\n# Project File Tree\n\nThe project directory is empty   this is a fresh project. You must create all files from scratch.') +
    (effectiveFilesContext
      ? `\n\n# Current Project File Contents\n\nFocused previews of the most relevant project files. Use these to get oriented quickly, then call \`read_file\` for any file you need in full before editing.\n\n${effectiveFilesContext}${_tier !== 'micro' ? truncatedFilesNote + excludedFilesNote : ''}`
      : '') +
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

  // Per-run brain memory   survives context compaction across steps.
  // Hoisted above the Gemini cache block because buildToolSet needs it.
  const brainMemory: string[] = [];
  const toolSet = runtimeMode === 'plan' ? undefined : buildToolSet(ctx, brainMemory, _tier);

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
  // lands. Plan mode is unaffected (never sends tools, so no conflict there).
  const geminiToolCacheName: string | null = null;
  if (providerName === 'gemini' && runtimeMode === 'plan') {
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
    console.warn(`[AgentLoop] Timeout hit after ${AGENT_TIMEOUT_MS}ms   salvaging files before aborting`);

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
        console.warn(`[AgentLoop] Timeout salvage: using clean pre-agent snapshot (${salvageFiles.length} files) instead of current (possibly mid-repair) disk state`);
      } else {
        const SKIP_DIRS_TIMEOUT = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.tmp', 'coverage']);
        const SKIP_FILES_TIMEOUT = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
        const BINARY_EXTS_TIMEOUT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
        const BIN_SENTINEL = '__ECOMGEAR_BIN64__';

        const salvageMap = new Map<string, string>();
        const salvageCollect = (dir: string) => {
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
              } catch { /* skip */ }
            }
          }
        };
        salvageCollect(appPath);
        salvageFiles = Array.from(salvageMap.entries()).map(([p, c]) => ({ path: p, content: c }));
      }

      if (salvageFiles.length > 0) {
        sink.emit('done', {
          filesToWrite: runtimeMode === 'plan' ? [] : salvageFiles,
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
      }
    } catch (salvageErr) {
      console.warn('[AgentLoop] File salvage on timeout failed:', salvageErr);
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
      snapshotProject(appPath, snapshotDir).catch(() => {});
    }

    let currentUserContent: any = boundedPrompt;
    if (visionCapable && imageVisionData.length > 0) {
      const contentParts: any[] = imageVisionData.map(img => ({
        type: 'image',
        image: img.base64,
        mimeType: img.type,
      }));
      contentParts.push({ type: 'text', text: boundedPrompt });
      currentUserContent = contentParts;
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
        onStepFinish: ({ text, toolCalls, toolResults, usage, providerMetadata, reasoningText }: any) => {
          stepCount++;
          runLedger.setStep(stepCount);
          const toolNames = (toolCalls ?? []).map((tc: any) => tc.toolName);
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
          const isFailureResult = (s: string) => /^(Error|ERROR|BLOCKED|PREFER EDIT)/.test(s);
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
              console.warn(`[AgentLoop] Circuit breaker: "${toolName}" failed with the identical error ${streak.count}x in a row (user=${userId ?? 'unknown'})`);
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

          // ── Stuck-analysis detector: no successful write/edit for N steps ──
          // Must recognize EVERY state-modifying tool, not just write_file/edit_file  
          // a run that's productively calling write_edge_function repeatedly (e.g.
          // building 6 edge functions in a row) was being misclassified as "stuck"
          // and hard-stopped mid-way, even though each call was succeeding. Confirmed
          // live 2026-07-13: a CardPro run called write_edge_function successfully 6
          // times in a row (auth-login, auth-signup, get-cards, get-mystery-cases,
          // get-shops, process-payment) and was killed by this exact check.
          const STATE_MODIFYING_TOOLS = new Set([
            'write_file', 'edit_file', 'write_edge_function', 'delete_edge_function', 'delete_file', 'rename_file', 'place_asset',
          ]);
          // DIAGNOSTIC (2026-07-21): three consecutive Anthropic runs showed
          // write_file steps that looked successful in the log yet never reset
          // stepsSinceLastWrite   the detector then fired on productive runs.
          // Log the exact shape+prefix of every state-modifying tool result so
          // the next occurrence shows WHY it wasn't counted, instead of a 4th
          // round of hypothesis. Cheap (only fires on write-ish tools); remove
          // once the counter bug is confirmed fixed.
          for (const tr of (toolResults ?? []) as any[]) {
            const tn = tr?.toolName as string | undefined;
            if (!tn || !STATE_MODIFYING_TOOLS.has(tn)) continue;
            const out = tr?.output;
            console.log(
              `[AgentLoop][write-audit] step=${stepCount} tool=${tn} outputType=${typeof out}` +
              (typeof out === 'string'
                ? ` prefix=${JSON.stringify(out.slice(0, 80))}`
                : ` shape=${out === null ? 'null' : Array.isArray(out) ? 'array' : out && typeof out === 'object' ? `object keys=[${Object.keys(out).slice(0, 6).join(',')}]` : String(out)}`),
            );
          }
          const hadSuccessfulWriteThisStep = (toolResults ?? []).some((tr: any) => {
            const toolName = tr?.toolName as string | undefined;
            const result = tr?.output;
            if (!toolName || !STATE_MODIFYING_TOOLS.has(toolName)) return false;
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
            stepsSinceLastWrite >= STUCK_ANALYSIS_THRESHOLD && runTokens.total > RUN_TOKEN_CAP * 0.65;
          // Content-based fast path: three consecutive `think` calls that
          // restate near-identical reasoning (>=0.55 word-overlap) is a much
          // stronger stuck signal than step-count alone, and short-circuits
          // straight to hard-stop instead of waiting for STUCK_ANALYSIS_THRESHOLD
          // steps AND multiple ignored nudges   real multi-file investigation
          // always produces different reasoning text per step, so this can't
          // false-positive on the legitimate case the threshold history above
          // was tuned to protect.
          const stuckAndContentRepeating = consecutiveSimilarThinkSteps >= 3;
          if (
            stuckAndBudgetCritical ||
            stuckAndContentRepeating ||
            (
              stepsSinceLastWrite >= STUCK_ANALYSIS_THRESHOLD &&
              stepCount - stuckAnalysisNoteFiredAt >= STUCK_ANALYSIS_THRESHOLD
            )
          ) {
            stuckAnalysisFireCount++;
            stuckAnalysisNoteFiredAt = stepCount;
            if (stuckAndBudgetCritical || stuckAndContentRepeating || stuckAnalysisFireCount >= STUCK_ANALYSIS_HARD_STOP_FIRINGS) {
              console.warn(`[AgentLoop] Stuck-analysis hard stop: ${stepsSinceLastWrite} steps with no successful write/edit${stuckAndBudgetCritical ? ` (budget-critical: ${runTokens.total}/${RUN_TOKEN_CAP} tokens used)` : stuckAndContentRepeating ? ` (content-repeating: ${consecutiveSimilarThinkSteps} near-identical think calls)` : ` after ${stuckAnalysisFireCount - 1} ignored nudges`} (user=${userId ?? 'unknown'})`);
              stuckAnalysisAbortReason = stuckAndContentRepeating
                ? `stuck repeating near-identical reasoning for ${consecutiveSimilarThinkSteps} steps in a row`
                : `stuck analyzing without making a change for ${stepsSinceLastWrite} steps`;
              generateStatus(projectId, { kind: 'lifecycle', phase: 'budget-reached' }).then((s) => {
                if (s) sink.emit('step-finish', { step: stepCount, toolCount: 0, tools: [], status: s });
              }).catch(() => {});
              abortController.abort();
            } else {
              console.warn(`[AgentLoop] Stuck-analysis detector: ${stepsSinceLastWrite} steps with no successful write/edit (user=${userId ?? 'unknown'})`);
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

          console.log(
            `[AgentLoop] project=${projectId} Step ${stepCount} | provider=${pName} model=${servingModelId}` +
            ` | tools: ${toolNames.join(', ') || 'none'}` +
            `${failedEdits > 0 ? ` (${failedEdits} failed)` : ''}` +
            ` | tokens: in=${stepInp} out=${stepOut} cacheR=${stepCacheR} cacheW=${stepCacheW}` +
            ` | step $${stepCost.toFixed(5)} | run total $${runCost.toFixed(4)}` +
            (userId ? ` | user=${userId}` : '') +
            (isInternalRun ? ' | internal=1' : ''),
          );

          // ── Per-run hard caps ────────────────────────────────────────────
          // Two gates: token count + dollar cost. Whichever fires first aborts the run.
          // Token cap is tier-based (RUN_TOKEN_CAP) so build gets more headroom than micro.
          // Cost cap is a hard ceiling regardless of tier.
          const HARD_COST_CAP = isInternalRun
            ? parseFloat(process.env.AGENT_COST_CAP_USD_INTERNAL || process.env.AGENT_COST_CAP_USD || '1.50')
            : parseFloat(process.env.AGENT_COST_CAP_USD || '1.50');
          if (runTokens.total > RUN_TOKEN_CAP || runCost > HARD_COST_CAP) {
            const reason = runCost > HARD_COST_CAP
              ? `cost cap $${HARD_COST_CAP} hit ($${runCost.toFixed(3)} spent)`
              : `token cap ${RUN_TOKEN_CAP} hit (${runTokens.total} used)`;
            console.warn(`[AgentLoop] Run aborted   ${reason} (user=${userId ?? 'unknown'})`);
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
      try {
        for await (const part of stream.fullStream) {
          if (part.type === 'text-delta') {
            textBuffer += part.text;
            const safeText = sanitizeUserFacingDelta(part.text);
            if (safeText) {
              sink.emit('text-delta', { text: safeText });
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
            console.log(
              `[AgentLoop] RUN COMPLETE` +
              ` | input=${totalIn} output=${totalOut} cacheRead=${totalCR} cacheWrite=${totalCW}` +
              ` | total tokens=${totalIn + totalOut + totalCR + totalCW}` +
              ` | est cost $${totalCost.toFixed(4)}` +
              ` | finishReason=${lastFinishReason ?? 'unknown'}` +
              (userId ? ` | user=${userId}` : '') +
              (agentRunId ? ` | runId=${agentRunId}` : ''),
            );
            // Warn when model produces nothing   helps diagnose Gemini empty-response issues
            if (totalOut === 0) {
              console.warn(
                `[AgentLoop] ⚠️  Model produced 0 output tokens (finishReason=${lastFinishReason ?? 'unknown'}).` +
                ` This usually means conflicting prompt instructions or a safety filter triggered.` +
                ` provider=${providerName} model=${modelId}`,
              );
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
      return { text: textBuffer, err: partError };
    };

    let result: ReturnType<typeof streamText> | null = null;
    let outerFinishReason: string | undefined;

    // Primary model: retry with exponential backoff (skip retries for network errors)
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
          console.warn('[AgentLoop] Anthropic rate-limited   skipping same-provider retries and switching to fallback');
          generateStatus(projectId, { kind: 'lifecycle', phase: 'provider-fallback' }).then((s) => {
            if (s) sink.emit('step-finish', { step: 0, toolCount: 0, status: s });
          }).catch(() => {});
          break;
        }
        // Network errors (DNS, connection refused) won't resolve with retries   go straight to fallback.
        if (isNetworkError(err)) {
          console.warn(`[AgentLoop] Network error on ${providerName}   skipping retries, going to fallback: ${err?.message}`);
          break;
        }
        // Auth/billing errors (org disabled, 401, 403) won't resolve with retries   go straight to fallback.
        if (isAuthOrBillingError(err)) {
          tripBillingCircuit(providerName);
          console.warn(`[AgentLoop] Auth/billing error on ${providerName}   circuit-breaking provider for this session: ${err?.message}`);
          break;
        }
        if (!isRetryableError(err) || attempt === MAX_RETRIES) break;
        // Rate limits (429) need longer backoff. Honor the retry-after header from Anthropic.
        // If retry-after is meaningfully long it's better to fall back than hold the UI open.
        const retryAfterMs = isRateLimitError(err) ? getRetryAfterMs(err) : null;
        if (retryAfterMs !== null && retryAfterMs > 10_000) {
          console.warn(`[AgentLoop] Rate limit: retry-after=${Math.ceil(retryAfterMs / 1000)}s   skipping retries, trying fallback providers`);
          break;
        }
        // Other retryable errors (500/529/overloaded) use shorter backoff (2s/4s/8s).
        const delay = isRateLimitError(err)
          ? (retryAfterMs ?? Math.min(3000 * Math.pow(2, attempt), 10_000)) // honor header, else 3s/6s/10s
          : Math.min(1000 * Math.pow(2, attempt), 8000);  // 1s, 2s, 4s, max 8s
        console.warn(`[AgentLoop] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err?.message ?? err}. Retrying in ${delay}ms...`);
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
    if (lastStreamError && (isRetryableError(lastStreamError) || isNetworkError(lastStreamError) || isAuthOrBillingError(lastStreamError) || isModelNotFound)) {
      // Build a prioritised list of fallback candidates. Gemini-to-Gemini fallback is
      // now allowed (different model) so a bad gemini-2.5-pro can fall to gemini-flash-latest.
      const fallbackCandidates = buildFallbackCandidates(providerName, modelId);
      for (const fallbackModelId of fallbackCandidates) {
        const fallbackInfo = createProviderForModel(fallbackModelId);
        if (!fallbackInfo) continue;
        console.warn(`[AgentLoop] Primary provider ${providerName} failed. Falling back to ${fallbackInfo.providerName}/${fallbackModelId}`);
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
          break; // fallback succeeded
        } catch (fallbackErr: any) {
          console.warn(`[AgentLoop] Fallback ${fallbackInfo.providerName} also failed: ${fallbackErr?.message}`);
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
      console.warn(`[AgentLoop] ${recoveryReason} (${streamError?.message ?? streamError}). Trying fallback recovery once.`);
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
            console.log(`[AgentLoop] Stream recovery succeeded via ${fallbackInfo.providerName}/${fallbackModelId}`);
            break;
          }
          streamError = recoveredConsume.err;
        } catch (recoveryErr: any) {
          streamError = recoveryErr;
          console.warn(`[AgentLoop] Recovery fallback ${fallbackInfo.providerName} failed: ${recoveryErr?.message ?? recoveryErr}`);
        }
      }
    }

    if (streamError) {
      // If the timeout handler already sent a 'done' event, suppress re-throwing so the
      // route-level catch doesn't emit a second 'error' SSE that overwrites the done result.
      if (timeoutDoneSent || (streamError as any)?.isAgentTimeout) {
        console.log('[AgentLoop] Timeout abort   swallowing streamError, done already sent.');
        return { filesToWrite: [], filesToDelete: [], renames: [], dependencies: [], summary: '', costUsd: 0, ecoUsed: 0 };
      }
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
      console.warn(`[AgentLoop] Hallucinated completion claim detected (zero writes, text claims a change)   forcing corrective continuation. user=${userId ?? 'unknown'}`);
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
          console.warn('[AgentLoop] Corrective continuation stream errored (non-fatal):', correctiveConsume.err?.message ?? correctiveConsume.err);
        }
      } catch (correctiveErr: any) {
        console.warn('[AgentLoop] Corrective continuation failed (non-fatal):', correctiveErr?.message ?? correctiveErr);
      }
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
        console.warn(`[AgentLoop] Empty run detected (finishReason=${outerFinishReason}, zero text/tools/writes)   retrying once via fallback provider. user=${userId ?? 'unknown'}`);
        let recovered = false;
        for (const fallbackModelId of buildFallbackCandidates(providerName, modelId)) {
          const fallbackInfo = createProviderForModel(fallbackModelId);
          if (!fallbackInfo) continue;
          try {
            const retryStream = await attemptStream(fallbackInfo.provider, 0, fallbackInfo.providerName);
            const retryConsume = await consumeResultStream(retryStream);
            if (!retryConsume.err && retryConsume.text.trim()) {
              accumulatedText = retryConsume.text;
              console.log(`[AgentLoop] Empty-run retry succeeded via ${fallbackInfo.providerName}/${fallbackModelId}`);
              recovered = true;
              break;
            }
          } catch (retryErr: any) {
            console.warn(`[AgentLoop] Empty-run retry via ${fallbackInfo.providerName} failed: ${retryErr?.message ?? retryErr}`);
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

    const finalText = accumulatedText;

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
        console.warn(`[AgentLoop] Stuck-abort WITH rejected write attempts (${rejectedWriteAttempts.length})   guard-caused, not analysis paralysis (user=${userId ?? 'unknown'})`);
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
        console.log(`[AgentLoop] Post-gen validation: ${newPageFiles.length} page(s) written but App.tsx not updated   codegenerating App.tsx`);
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
        } catch { /* ignore */ }

        const pagesForRouter = allPagesOnDisk.length > 0 ? allPagesOnDisk : newPageFiles;

        // Deterministic codegen   zero LLM calls, zero wiring failures. Replaces
        // the old generateText-based "App.tsx fix pass", which could hallucinate
        // routes, forget imports, or truncate mid-file like any other LLM write.
        try {
          const generatedAppTsx = generateAppTsxFromPages(pagesForRouter);
          const fullPath = safeJoin(appPath, 'src/App.tsx');
          fs.writeFileSync(fullPath, generatedAppTsx, 'utf8');
          const existing = filesToWrite.findIndex(f => f.path === 'src/App.tsx');
          if (existing >= 0) filesToWrite[existing].content = generatedAppTsx;
          else filesToWrite.push({ path: 'src/App.tsx', content: generatedAppTsx });
          if (ctx.pendingPreviewFiles) ctx.pendingPreviewFiles.set('src/App.tsx', generatedAppTsx);
          console.log(`[AgentLoop] App.tsx codegen completed   ${pagesForRouter.length} route(s) wired`);
        } catch (appFixErr) {
          console.warn('[AgentLoop] App.tsx codegen failed (non-fatal):', appFixErr);
        }
      }
    }
    // ─── End App.tsx validation ─────────────────────────────────────────────────

    // Constants for binary handling   declared before use in agentWrittenFiles filter.
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.tmp', 'coverage']);
    const SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
    const BINARY_EXTS_SET = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
    const BINARY_SENTINEL = '__ECOMGEAR_BIN64__';

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
      } catch {
        // Fall back to tracked content if path validation/read fails.
      }
      return { path: relativePath, content: fallbackContent };
    });

    const diskFilesMap = new Map<string, string>();
    const MAX_DISK_FILES = 5000;
    const MAX_TEXT_FILE_SIZE = 512 * 1024; // 512KB per text file
    const collectDiskFiles = (dir: string) => {
      if (diskFilesMap.size >= MAX_DISK_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
            } catch { /* skip unreadable */ }
          }
        }
      }
    };
    try { collectDiskFiles(appPath); } catch { /* skip if project dir missing */ }

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
      } catch {
        return 0; // transpileModule exceptions are rare   don't treat as an error signal
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
            console.warn(`[AgentLoop] Final sanitize REJECTED for ${f.path}   would have made syntax errors worse (${errorsBefore} → ${errorsAfter}); keeping original content. Attempted fixes: ${fixes.join(', ')}`);
          } else {
            f.content = sanitized;
            try {
              const fullPath = safeJoin(appPath, f.path);
              fs.writeFileSync(fullPath, sanitized, 'utf8');
            } catch {}
            console.log(`[AgentLoop] Final sanitize: ${f.path}   ${fixes.join(', ')}`);
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
              console.warn(`[AgentLoop] Final syntax check failed for ${f.path}: ${errors}   repair loop will fix`);
            }
          } catch { /* don't block push on transpileModule exceptions */ }
        }
      }
      if (/\.json$/i.test(f.path) && !f.path.startsWith('node_modules')) {
        const { content: repaired, fixes } = sanitizeConfigFile(f.path, f.content);
        if (fixes.length > 0) {
          f.content = repaired;
          try {
            const fullPath = safeJoin(appPath, f.path);
            fs.writeFileSync(fullPath, repaired, 'utf8');
          } catch {}
          console.log(`[AgentLoop] Config repair: ${f.path}   ${fixes.join(', ')}`);
        }
      }
    }

    const agentWroteFiles = filesToWrite.length > 0 || filesEdited.length > 0 || filesToDelete.length > 0 || renames.length > 0;

    let previewPushOk = false;
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
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body: responseBody }));
          });
          req.on('error', (e: Error) => { resolve({ status: 0, body: e.message }); });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
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
          req.on('error', (e: Error) => { resolve({ status: 0, body: e.message }); });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
          req.end();
        });

      const getPreviewStatus = async (): Promise<{ healthy: boolean; errors: string[]; diagnosticKind?: string }> => {
        const statusRes = await httpGet(`${previewServiceUrl}/preview/${projectId}/status`);
        if (statusRes.status !== 200) {
          return { healthy: false, errors: [`status_unreachable_${statusRes.status || 0}`], diagnosticKind: 'service' };
        }
        try {
          const parsed = JSON.parse(statusRes.body) as { healthy?: boolean; errors?: string[]; diagnosticKind?: string };
          return {
            healthy: Boolean(parsed.healthy),
            errors: Array.isArray(parsed.errors) ? parsed.errors : [],
            diagnosticKind: typeof parsed.diagnosticKind === 'string' ? parsed.diagnosticKind : undefined,
          };
        } catch {
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

      // First attempt: normal push
      const firstAttempt = await httpPost(updateUrl, JSON.stringify({ files: mergedWrites, fullSync: true }));
      if (firstAttempt.status === 200) {
        console.log(`[AgentLoop] Preview push OK: ${mergedWrites.length} files`);
        previewPushOk = true;
      } else if (firstAttempt.status === 422) {
        console.warn(`[AgentLoop] Preview validation failed (422). Attempting surgical revert of broken files.`);

        // ── Surgical revert: identify broken files from the 422 response and
        // replace them with the pre-agent version before trying LLM repair.
        // This is much faster and more reliable than the full LLM repair loop.
        try {
          const errBody = JSON.parse(firstAttempt.body);
          const validationErrors: Array<{ file?: string }> = Array.isArray(errBody?.validationErrors) ? errBody.validationErrors : [];
          const brokenFiles = new Set(validationErrors.map(e => e.file).filter(Boolean) as string[]);

          if (brokenFiles.size > 0 && brokenFiles.size <= 10) {
            // Use pre-agent snapshot (disk state captured before push) which
            // works even when frontend doesn't send existingFiles.
            const preAgentMap = preAgentDiskSnapshot;

            let reverted = 0;
            let removed = 0;
            const revertedMerged = mergedWrites
              .map(f => {
                if (brokenFiles.has(f.path)) {
                  if (preAgentMap.has(f.path)) {
                    // File existed before agent   restore original version
                    reverted++;
                    return { path: f.path, content: preAgentMap.get(f.path)! };
                  } else {
                    // File is NEW (created by agent) and broken   remove from push
                    removed++;
                    return null;
                  }
                }
                return f;
              })
              .filter((f): f is { path: string; content: string } => f !== null);

            if (reverted > 0 || removed > 0) {
              console.log(`[AgentLoop] Surgical revert: reverted ${reverted}, removed ${removed} broken file(s): ${[...brokenFiles].join(', ')}`);
              const revertAttempt = await httpPost(updateUrl, JSON.stringify({ files: revertedMerged, fullSync: true }));
              if (revertAttempt.status === 200) {
                console.log(`[AgentLoop] Surgical revert succeeded   preview is healthy`);
                // Update mergedWrites so 'done' sends the reverted set
                mergedWrites.length = 0;
                revertedMerged.forEach(f => mergedWrites.push(f));
                // Also revert the on-disk files so they match what was pushed
                for (const brokenPath of brokenFiles) {
                  const preContent = preAgentMap.get(brokenPath);
                  if (preContent != null) {
                    try {
                      const fullFilePath = safeJoin(appPath, brokenPath);
                      fs.writeFileSync(fullFilePath, preContent, 'utf8');
                    } catch { /* best-effort disk revert */ }
                  } else {
                    // New file created by agent   delete from disk
                    try {
                      const fullFilePath = safeJoin(appPath, brokenPath);
                      fs.unlinkSync(fullFilePath);
                    } catch { /* best-effort delete */ }
                  }
                }
                previewPushOk = true;
                const revertMsg = [
                  reverted > 0 ? `reverted ${reverted}` : '',
                  removed > 0 ? `removed ${removed} new broken` : '',
                ].filter(Boolean).join(' and ');
                console.log(`[AgentLoop] Surgical revert complete (silent): ${revertMsg} file(s)`);
              } else {
                console.warn(`[AgentLoop] Surgical revert still failed (${revertAttempt.status})   falling to LLM repair`);
              }
            }
          }
        } catch {
          // 422 body parse failed   fall through to LLM repair
        }
      } else {
        console.warn(`[AgentLoop] Preview push returned ${firstAttempt.status}`);
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
          console.warn(`[AgentLoop] Preview reported unhealthy after successful push (${repairDiagnosticKind}): ${hint}`);
        } else {
          // Second check at 1.2s total   catches slower Vite transforms on production
          await new Promise<void>(r => setTimeout(r, 600));
          status = await getPreviewStatus();
          if (!status.healthy) {
            previewPushOk = false;
            repairDiagnosticKind = status.diagnosticKind ?? 'build';
            const hint = status.errors.slice(0, 1).join('\n') || 'unknown preview error';
            console.warn(`[AgentLoop] Preview reported unhealthy on second check (${repairDiagnosticKind}): ${hint}`);
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
          console.warn('[AgentLoop] Skipping build repair   token budget already exhausted');
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
          if (errors.length === 0) break;
          lastRepairErrors = errors;

          const errorSignature = errors
            .map(e => e.split('\n').slice(0, 2).join('\n').trim())
            .sort()
            .join('|');
          if (prevErrorSignature && errorSignature === prevErrorSignature) {
            console.warn(`[AgentLoop] Repair repeating identical error signature (${errors.length} errors)   stopping early`);
            break;
          }

          // Progress check: if error count didn't decrease, bail early
          if (repairAttempt > 0 && errors.length >= prevErrorCount) {
            console.warn(`[AgentLoop] Repair made no progress (${errors.length} errors, was ${prevErrorCount})   stopping`);
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
          console.log(`[AgentLoop] Auto-repair attempt ${repairAttempt + 1}: ${errors.length} ${currentKind} error(s) in ${brokenFileLocations.size} file(s)`);
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
                fs.writeFileSync(fullFilePath, patched, 'utf8');
                const memPush = await httpPost(updateUrl, JSON.stringify({ files: [{ path: relPath, content: patched }], fullSync: false }));
                if (memPush.status === 200) {
                  await new Promise<void>(r => setTimeout(r, 400));
                  const memHealth = await getPreviewStatus();
                  if (memHealth.healthy) {
                    console.log(`[AgentLoop] Failure-memory fix applied for ${relPath} (hit #${remembered.hitCount + 1})   LLM repair skipped`);
                    const idx = mergedWrites.findIndex(f => f.path === relPath);
                    if (idx >= 0) mergedWrites[idx].content = patched;
                    else mergedWrites.push({ path: relPath, content: patched });
                    previewPushOk = true;
                  }
                }
              } catch { /* remembered fix didn't apply cleanly   fall through to normal repair passes */ }
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
                  fs.writeFileSync(fullFilePath, fixed, 'utf8');
                  mechPatched.push({ path: relPath, content: fixed });
                  console.log(`[AgentLoop] Mechanical fix: ${relPath}   ${fixes.join(', ')}`);
                }
              } catch { /* skip unreadable */ }
            }
            if (mechPatched.length > 0) {
              // Push only the patched files (partial update, no fullSync needed)
              const mechPush = await httpPost(updateUrl, JSON.stringify({ files: mechPatched, fullSync: false }));
              if (mechPush.status === 200) {
                await new Promise<void>(r => setTimeout(r, 400));
                const mechHealth = await getPreviewStatus();
                if (mechHealth.healthy) {
                  console.log(`[AgentLoop] Mechanical repair cleared all errors   LLM skipped`);
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
            try { preRepairContent.set(relPath, fs.readFileSync(safeJoin(appPath, relPath), 'utf8')); } catch { /* file may not exist yet */ }
          }

          try {
            await generateText({
              model: aiProvider,
              system: repairSystemPrompt,
              messages: [{ role: 'user', content: `Fix these ${currentKind} errors:\n\n${condensedErrors}${brokenFileContext}` }],
              tools: repairToolSet,
              stopWhen: stepCountIs(12),
              abortSignal: abortController.signal,
            });
          } catch (repairErr) {
            console.warn(`[AgentLoop] Repair pass ${repairAttempt + 1} failed:`, repairErr);
            break;
          }

          // Re-scan disk after repair
          const repairedDiskMap = new Map<string, string>();
          const reCollectDisk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
                } catch {}
              }
            }
          };
          try { reCollectDisk(appPath); } catch {}
          repairFiles = Array.from(repairedDiskMap.entries()).map(([p, c]) => ({ path: p, content: c }));

          // Push repaired files
          const repairPush = await httpPost(updateUrl, JSON.stringify({ files: repairFiles, fullSync: true }));
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
              console.log(`[AgentLoop] Auto-repair ${repairAttempt + 1} succeeded and preview confirmed healthy`);
              previewPushOk = true;
              console.log(`[AgentLoop] Auto-repair ${repairAttempt + 1} resolved all errors (silent).`);

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
              console.warn(`[AgentLoop] Auto-repair ${repairAttempt + 1} push OK but preview still unhealthy (${repairHealth.errors.slice(0, 1).join('; ')})   continuing repair`);
            }
          } else {
            console.warn(`[AgentLoop] Auto-repair ${repairAttempt + 1} did not pass validation (${repairPush.status})`);
          }
        }
        } // end token-budget guard for repair loop
      } // end if (!previewPushOk && !pushWasTransportFailure)   repair section

      if (!previewPushOk && !pushWasTransportFailure) {
          // All repair attempts exhausted. Silently restore the pre-agent state so
          // the user sees a clean working preview instead of broken generated code.
          console.warn('[AgentLoop] All repair attempts exhausted   silently restoring pre-agent state');

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
                fs.writeFileSync(fullFilePath, preContent, 'utf8');
              } catch (diskErr) {
                diskRestoreFailures++;
                console.error(`[AgentLoop] Pre-agent disk restore FAILED for ${relPath}   this server's own copy may still hold broken content`, diskErr);
              }
            }
            if (diskRestoreFailures > 0) {
              console.error(`[AgentLoop] Pre-agent disk restore: ${diskRestoreFailures}/${preAgentDiskSnapshot.size} file(s) failed to restore locally for project=${projectId}`);
            }
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
                const restoreRes = await httpPost(updateUrl, JSON.stringify({ files: preAgentFiles, fullSync: true }));
                lastRestoreStatus = restoreRes.status;
                if (restoreRes.status === 200) {
                  restorePushOk = true;
                } else if (attempt < 3) {
                  await new Promise((r) => setTimeout(r, attempt * 1000));
                }
              } catch (restoreErr) {
                console.warn(`[AgentLoop] Pre-agent restore push attempt ${attempt}/3 threw`, restoreErr);
                if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
              }
            }
            if (restorePushOk) {
              console.log(`[AgentLoop] Pre-agent state restored to preview (${preAgentFiles.length} files)`);
            } else {
              console.error(`[AgentLoop] Pre-agent restore push FAILED after 3 attempts (last status: ${lastRestoreStatus ?? 'none'})   live preview may still show broken code for project=${projectId}`);
              sink.emit('repair-failed', {
                errors: ['Restore to last known-good state failed to reach the preview service   the preview may still show broken code. Try again or manually refresh.'],
              });
            }
          } else {
            // No pre-agent snapshot available   scan disk and push whatever is there
            const salvageDiskMap = new Map<string, string>();
            const collectSalvage = (dir: string) => {
              let entries: fs.Dirent[];
              try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
                  } catch {}
                }
              }
            };
            try { collectSalvage(appPath); } catch {}
            const salvageFiles = Array.from(salvageDiskMap.entries()).map(([p, c]) => ({ path: p, content: c }));
            mergedWrites.length = 0;
            salvageFiles.forEach(f => mergedWrites.push(f));
            try {
              await httpPost(updateUrl, JSON.stringify({ files: salvageFiles, fullSync: true }));
            } catch {}
          }
        }
      } catch (pushErr) {
        console.warn('[AgentLoop] Preview push error:', pushErr);
        throw pushErr;
      }
    } else if (runtimeMode === 'build' && !agentWroteFiles) {
      console.log(`[AgentLoop] No file operations   skipping preview push`);
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
    const needsAutoContinue = Boolean(budgetAbortReason) && !stuckAnalysisAbortReason && anySuccessfulWriteThisRun;
    const continuationPrompt = needsAutoContinue
      ? `Continue exactly where you left off on this request: "${prompt}". Do not redo files you already finished   pick up with whatever is left.`
      : undefined;

    // NOW send 'done'   preview is synced, frontend shows correct state
    sink.emit('done', {
      ghostRun: runtimeMode === 'build' && !agentWroteFiles,
      filesToWrite: doneFilesToWrite,
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
      needsAutoContinue,
      continuationPrompt,
    });

    // ── Background: save token usage + npm install (non-blocking) ───────────
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
        } catch {}
      }

      const finalCost = runCostUsd > 0 ? runCostUsd : calcCost(runTokens.inputTokens, runTokens.outputTokens, runTokens.cacheReadTokens, runTokens.cacheWriteTokens);

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

      // Update agent_runs with all completion data (status + token count + snapshot_id)
      if (supabase && agentRunId) {
        supabase.from('agent_runs').update({
          status: 'completed',
          steps_taken: stepCount,
          files_written: doneFilesToWrite.length,
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
        }).eq('id', agentRunId).then(
          ({ error }) => { if (error) console.warn(`[AgentLoop] agent_runs update failed: ${error.message}`); },
          (e: any) => console.warn('[AgentLoop] agent_runs update rejected:', e?.message)
        );
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
            ({ error }) => { if (error) console.warn(`[AgentLoop] revision preview_url update failed: ${error.message}`); },
            (e: any) => console.warn('[AgentLoop] revision preview_url update rejected:', e?.message)
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
              try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* skip */ }
            }

            // Clear snapshot_id from those DB rows (they're gone from disk)
            await supabase
              .from('agent_runs')
              .update({ snapshot_id: null })
              .in('id', pruneIds);
          } catch (pruneErr) {
            console.warn('[AgentLoop] Snapshot pruning failed:', pruneErr);
          }
        })();
      }
    })();

    if (agentTimeoutId) clearTimeout(agentTimeoutId);
    clearInterval(heartbeatId);
    return { filesToWrite: doneFilesToWrite, filesToDelete: doneFilesToDelete, renames: doneRenames, dependencies: doneDependencies, summary, costUsd: finalCostUsd, ecoUsed: finalEcoUsed, needsAutoContinue, continuationPrompt, stuckAborted: Boolean(stuckAnalysisAbortReason) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (agentTimeoutId) clearTimeout(agentTimeoutId);
    clearInterval(heartbeatId);

    const isAbort = abortController.signal.aborted || err?.name === 'AbortError';
    if (isAbort) {
      if (abortSignal?.aborted) {
        console.warn('[AgentLoop] Aborted due to client disconnect');
      } else {
        console.warn('[AgentLoop] Aborted due to timeout/cancellation');
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
        }).eq('id', agentRunId).then(() => {}, () => {});
      }

      throw abortError;
    }

    console.error('[AgentLoop] Error:', err);

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
      console.error(
        `[ProviderOutage] severity=critical all providers failed with billing/credit/quota errors` +
        ` | project=${projectId}` + (userId ? ` user=${userId}` : '') +
        ` | raw=${String(err?.message ?? err).slice(0, 300)}`,
      );
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
        } catch {
          // ignore JSON parse error
        }
      }
    }

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
      }).eq('id', agentRunId).then(() => {}, () => {});
    }
    throw err;
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
}
