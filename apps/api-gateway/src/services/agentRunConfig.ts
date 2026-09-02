/**
 * Run configuration: budgets, runtime mode, model substitution.
 *
 * First extraction of `_runAgentLoopInner`'s Group A (#2). These four decisions
 * are made in the first ~90 lines of a ~5,300-line function, are entirely
 * determined by their inputs, and were untestable because they only existed as
 * inline expressions between two log lines.
 *
 * The step budget also removes a duplicated table: the loop carried its own
 * tier->steps ladder under a comment reading "Values must match TIER_MAX_STEPS
 * in intentClassifier.ts". Two tables that must match by convention eventually
 * do not, which is the same failure shape as the edge-function validator
 * describing a world that had moved on.
 */
import { TIER_MAX_STEPS, type RequestTier } from './intentClassifier.js';

/** Legacy step ceilings for requests that arrive without a tier (old clients). */
const LEGACY_BUILD_STEPS = 45;
const LEGACY_EDIT_STEPS = 25;
/** A tier-less prompt this long is treated as build-shaped. */
const LEGACY_LONG_PROMPT_CHARS = 600;

/**
 * Raw-token ceilings per tier.
 *
 * These count input + output + cacheRead + cacheWrite, and cacheRead bills at
 * roughly a tenth of a fresh token, so they are a runaway-loop backstop rather
 * than a cost control -- the $1.50 cost cap is the real one. They were doubled
 * on 2026-07-15 after a well-cached edit run was killed at 536K raw tokens
 * having spent $0.47, 31% of the cost cap: the old values were tuned when
 * caching was effectively zero and fired first on exactly the cheap runs that
 * should be allowed to continue.
 */
const TIER_TOKEN_CAPS: Record<RequestTier, number> = {
  micro: 160_000,
  fix: 700_000,
  edit: 900_000,
  feature: 1_200_000,
  build: 1_600_000,
};
const LEGACY_TOKEN_CAP = 1_600_000;

export function resolveStepBudget(
  tier: RequestTier | undefined,
  legacy: { isWebsiteBuild?: boolean; promptLength: number },
): number {
  if (tier) return TIER_MAX_STEPS[tier];
  const buildShaped = (legacy.isWebsiteBuild ?? false) || legacy.promptLength > LEGACY_LONG_PROMPT_CHARS;
  return buildShaped ? LEGACY_BUILD_STEPS : LEGACY_EDIT_STEPS;
}

/**
 * @param envCap raw AGENT_TOKEN_CAP value; only ever LOWERS the tier ceiling,
 *   so a misconfigured env cannot hand a run a bigger budget than its tier allows.
 */
export function resolveTokenCap(tier: RequestTier | undefined, envCap?: string): number {
  const tierCap = tier ? TIER_TOKEN_CAPS[tier] : LEGACY_TOKEN_CAP;
  if (!envCap) return tierCap;
  const parsed = parseInt(envCap, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return tierCap;
  return Math.min(parsed, tierCap);
}

/**
 * A plan-mode request whose text is an execution confirmation runs as build.
 *
 * This decision used to live client-side and only moved the client's own
 * toggle, while the server trusted whatever `mode` arrived -- so the mode a run
 * actually executed under was decided in the browser with no server awareness.
 */
const EXECUTE_CONFIRM_RE =
  /^(execute|apply|do\s+it|go\s+ahead|proceed|yes|confirm|run|ship\s+it|make\s+(the\s+)?changes|ok\s+do\s+it)\b/i;

export function resolveRuntimeMode(mode: string | undefined, prompt: string): 'build' | 'plan' {
  if (mode !== 'plan') return 'build';
  return EXECUTE_CONFIRM_RE.test(prompt.trim()) ? 'build' : 'plan';
}

/**
 * Swap a model that ops has disabled by id.
 *
 * Distinct from AI_DISABLE_<PROVIDER>, which kills a whole provider: the client
 * sends an explicit model on every request, so changing the server default does
 * not stop requests naming a quota-exhausted model. Confirmed 2026-07-17, when
 * gemini-3.1-pro-preview hit its daily cap and requests kept asking for it by
 * name and dying mid-run.
 */
export function substituteDisabledModel(
  requestedModelId: string,
  disabledCsv: string | undefined,
  fallbackModelId: string,
): { modelId: string; substituted: boolean } {
  const disabled = new Set(
    (disabledCsv || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (!disabled.has(requestedModelId)) return { modelId: requestedModelId, substituted: false };
  return { modelId: fallbackModelId, substituted: true };
}

/**
 * Whether this run belongs to an internal (dogfooding) account.
 *
 * Two independent signals, either sufficient: the org's own `is_internal`
 * flag, or a comma-separated AGENT_INTERNAL_USER_IDS env list, which catches
 * internal testers outside the seeded orgs without a migration each time.
 */
export function isInternalRun(orgIsInternal: boolean, userId: string | undefined, envList?: string): boolean {
  if (orgIsInternal) return true;
  if (!userId) return false;
  return (envList ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId);
}

/** Default per-run USD ceiling. The ultimate backstop above the token caps. */
const DEFAULT_COST_CAP_USD = 1.50;

/**
 * The run's hard cost ceiling.
 *
 * Internal runs may use a separate, usually higher cap: a 2026-07-21 audit found
 * internal accounts were 81% of all aborts, i.e. dogfooding kept dead-ending at
 * the customer wall. A malformed env value falls back to the default rather than
 * producing NaN -- `cost > NaN` is always false, which would remove the cap
 * entirely and is the one failure mode this must not have.
 */
export function resolveCostCapUsd(
  internal: boolean,
  env: { AGENT_COST_CAP_USD?: string; AGENT_COST_CAP_USD_INTERNAL?: string },
): number {
  // `||` not `??`, matching the original chain: an EMPTY internal cap falls
  // through to the shared one rather than being treated as "set to nothing".
  const raw = internal
    ? (env.AGENT_COST_CAP_USD_INTERNAL || env.AGENT_COST_CAP_USD)
    : env.AGENT_COST_CAP_USD;
  const parsed = parseFloat(raw ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COST_CAP_USD;
}
