/**
 * Lightweight request-tier classifier   zero LLM cost, ~0ms.
 *
 * Classifies a user prompt into one of five tiers so the agent loop can
 * select the appropriate model and step budget instead of always running the
 * most expensive path.
 *
 * Tier → MAX_STEPS → default model
 *   micro   →  6  → Gemini Flash  (color, text, spacing, icon tweaks   only tier that uses cheap model)
 *   fix     → 28  → user choice   (error fixes, broken previews)
 *   edit    → 18  → user choice   (update/modify/remove one thing)
 *   feature → 22  → user choice   (add a page/section/component)
 *   build   → 30  → user choice   (new project or full rebuild)
 */

import { logger } from '../utils/logger.js';

export type RequestTier = 'micro' | 'fix' | 'edit' | 'feature' | 'build';

// ── Micro signal words   checked FIRST so "change color" beats "change" ──────
// Matches any CSS-property-level visual tweak. No structural change, no new components.
// "logo" and "size" deliberately excluded   too ambiguous ("logo section", "resize page").
const MICRO_RE = /\b(color|colour|font.?size|font.?weight|font.?family|margin|padding|spacing|opacity|border.?radius|border.?color|shadow|background.?color|bg.?color|letter.?spacing|line.?height|text.?align|bold|italic|underline|uppercase|lowercase|capitalize|placeholder|wording|typo|rounded|gradient|hover|sticky|blur|transparent|animation|animate|transition|smooth|glow|cursor|outline|brightness|contrast|saturate|scale|rotate|translate|skew)\b/i;

// ── Fix signal   checked before build so "build error" → fix not build ───────
const FIX_RE = /\b(fix|repair|resolve|debug|broken|not working|doesn'?t work|can'?t|won'?t|crash|fail(s|ed|ing)?|blank\s+screen|white\s+screen|404|disappear|TypeError|ReferenceError|build\s+error|compile\s+error|console\s+error|not\s+(showing|loading|rendering|displaying|appearing)|stopped\s+working|keeps?\s+(crashing|failing|breaking))\b/i;

// ── Strong (unambiguous) fix signal   FIX_RE minus "can't"/"won't" ─────────
// Those two are common casual filler in requests that aren't about a defect
// at all ("can't you also change the color while you're at it?"), so they
// stay in the full FIX_RE fallback but don't get to override MICRO_RE below.
// Everything else here is an explicit "something is broken" statement, and
// must win over a cosmetic-only match: "fix the broken button color" needs
// fix tier's 28-step diagnostic budget, not micro's 8, even though "color"
// alone would read as a cosmetic tweak. This was the checklist's own
// worked example of the ordered-regex-cascade misclassification bug.
const FIX_STRONG_RE = /\b(fix|repair|resolve|debug|broken|not working|doesn'?t work|crash|fail(s|ed|ing)?|blank\s+screen|white\s+screen|404|disappear|TypeError|ReferenceError|build\s+error|compile\s+error|console\s+error|not\s+(showing|loading|rendering|displaying|appearing)|stopped\s+working|keeps?\s+(crashing|failing|breaking))\b/i;

// ── Build   only when explicitly creating a new project, not just using "make/create" as verbs ──
const BUILD_RE = /\b(new project|from scratch|website for|app for|set up|scaffold)\b|\b(build|create|make|generate)\s+(a\s+|an?\s+|the\s+)?(new\s+)?(website|web\s*app|landing\s*page|portfolio|store|shop|restaurant|saas|dashboard\s+app)\b/i;

// ── Feature   adding a substantial new element ────────────────────────────────
// Expanded verbs beyond just "add": create, include, insert, implement, build, make, generate, put.
// BUILD_RE is checked first, so "build a website" → build, "build a navbar" → feature.
// Allows up to two adjective words between verb and noun ("add a beautiful contact form").
const FEATURE_RE = /\b(add|create|include|insert|implement|build|make|generate|put)\s+(?:a\s+|an?\s+|the\s+|new\s+|me\s+a?\s*)?(?:\w+\s+){0,2}(page|section|component|feature|tab|modal|form|table|chart|graph|navbar|nav\s*bar|footer|header|sidebar|hero|banner|carousel|slider|dropdown|accordion|breadcrumb|stepper|wizard|dashboard|login|signup|register|auth|checkout|cart|product|blog|portfolio|gallery|map|video|player|timeline|faq|testimonial|pricing|contact|about|team|service|features?|menu|widget|panel|drawer|sheet|popover|tooltip|notification|toast|badge|chip|tag|search\s*bar|search|filter|sort\s*by|pagination|upload|profile|settings)\b/i;

// ── Broad-scope words   these imply touching many files → feature tier ────────
// "redesign", "revamp", "rework", "refactor", "restructure", "overhaul", "redo",
// "polish", "improve", "modernize", "restyle"   checked BEFORE EDIT_RE.
const BROAD_RE = /\b(redesign|revamp|rework|refactor|restructure|overhaul|redo|polish\s+(the\s+)?(ui|interface|design|look|style|page|app)|improve\s+(the\s+)?(ui|interface|design|look|style)|modernize|restyle|clean\s+up\s+(the\s+)?(ui|design|layout|style|code)|make\s+(?:it|this|the\s+\w+(?:\s+\w+)?)\s+(?:look|feel)\s+(?:more\s+)?(?:better|modern|clean|polished|professional)|full\s+(ui|design|style)\s+overhaul)\b/i;

// ── Edit   targeted single-thing changes to existing elements ─────────────────
// Split in two because the two halves carry very different amounts of evidence.
// EDIT_SPECIFIC names the thing being changed, so the tier is well supported.
// EDIT_GENERIC is a bare verb: "change the logo", "update the hero" tell us an
// edit is wanted but nothing about its size, and a bare verb is exactly how
// "logo" ended up needing a hardcoded fast-path. Those go to the resolver
// below instead of being answered confidently from a verb alone.
const EDIT_SPECIFIC_RE = /\badd\s+(a\s+|the\s+)?(button|link|field|input|label|icon|image|text|title|heading|paragraph|list|item|row|column|class|attribute|prop)\b/i;
const EDIT_GENERIC_RE = /\b(change|update|modify|remove|delete|replace|move|reorder|rename|hide|show|toggle|enable|disable|adjust)\b/i;

/**
 * How much evidence the matched rule actually carried.
 *
 * 'high' means a rule matched something specific: a named CSS property, an
 * explicit defect statement, a verb paired with a concrete noun. 'low' means the
 * cascade produced an answer it cannot really justify -- a bare verb, casual
 * "can't" filler, or the length fallback, which is a coin flip wearing a
 * threshold. Only the low band is worth paying a model to resolve.
 */
export type TierConfidence = 'high' | 'low';

export interface TierDecision {
  tier: RequestTier;
  /** Which rule decided, so misroutes can be traced to a specific pattern. */
  rule: string;
  confidence: TierConfidence;
}

/**
 * A pasted error payload or log block: a defect report that carries no defect
 * VOCABULARY.
 *
 * FIX_RE matches "build error", "compile error", "console error" -- but not the
 * shape errors actually arrive in from this product's own edge-function console:
 *
 *   { "result": null, "logs": [], "error": "Invalid credentials or inactive account." }
 *
 * Measured over 477 real prompts: 42 (9%) carried a pasted error or log and were
 * routed AWAY from fix, median 8 steps, $13.42 of spend. Several of them open
 * with an explicit "DO NOT modify code yet" -- the user asking for diagnosis and
 * getting an editing agent.
 *
 * Requires real structure (a JSON error field, a named JS error class, or a
 * fenced block containing error text) rather than the bare word "error", which
 * appears constantly in ordinary requests like "add an error message".
 */
const ERROR_PAYLOAD_RE = /["']?error["']?\s*:\s*["'\[{]|["']?error["']?\s*:\s*null|\b(TypeError|ReferenceError|SyntaxError|RangeError)\b|```[\s\S]*\berror\b[\s\S]*```/i;

/** An explicit instruction not to change anything yet. */
const NO_MODIFY_RE = /\b(do not|don'?t)\s+(modify|change|edit|rewrite|touch|write)\b/i;

export function classifyRequestDetailed(prompt: string, isEmptyProject: boolean): TierDecision {
  if (isEmptyProject) return { tier: 'build', rule: 'empty-project', confidence: 'high' };
  // Unambiguous defect signal wins over a cosmetic-only match, even one
  // that mentions a MICRO_RE word like "color"   see FIX_STRONG_RE comment.
  if (FIX_STRONG_RE.test(prompt)) return { tier: 'fix', rule: 'fix-strong', confidence: 'high' };
  // A pasted error payload is a defect report even without defect vocabulary,
  // and it outranks a cosmetic word: "{ error: ... } make the button blue" is
  // still a bug report. Placed after FIX_STRONG (which already routes to fix)
  // and before MICRO for that reason.
  if (ERROR_PAYLOAD_RE.test(prompt)) return { tier: 'fix', rule: 'error-payload', confidence: 'high' };
  // "Do not modify anything yet" plus an error payload is an investigation
  // request. There is no read-only tier yet (designed, not built), so route to
  // fix -- it is the diagnostic tier and gates edits behind get_build_errors,
  // which is far closer to the intent than edit tier's write-first posture.
  if (NO_MODIFY_RE.test(prompt)) return { tier: 'fix', rule: 'no-modify-request', confidence: 'high' };
  // Micro next   "change the button color" (no defect signal) stays micro.
  if (MICRO_RE.test(prompt)) return { tier: 'micro', rule: 'micro', confidence: 'high' };
  // Fix before build   "build error" must not trigger build tier. This is the
  // weak can't/won't phrasing, which FIX_STRONG deliberately excludes because it
  // is just as often casual filler ("can't you also make it blue?").
  if (FIX_RE.test(prompt)) return { tier: 'fix', rule: 'fix-weak', confidence: 'low' };
  if (BUILD_RE.test(prompt)) return { tier: 'build', rule: 'build', confidence: 'high' };
  if (FEATURE_RE.test(prompt)) return { tier: 'feature', rule: 'feature', confidence: 'high' };
  // Broad-scope words imply touching many files → feature tier, not edit
  if (BROAD_RE.test(prompt)) return { tier: 'feature', rule: 'broad', confidence: 'high' };
  if (EDIT_SPECIFIC_RE.test(prompt)) return { tier: 'edit', rule: 'edit-specific', confidence: 'high' };
  if (EDIT_GENERIC_RE.test(prompt)) return { tier: 'edit', rule: 'edit-generic', confidence: 'low' };
  // Fallback: short prompts are likely targeted edits, long ones are features.
  return prompt.trim().length > 400
    ? { tier: 'feature', rule: 'length-fallback', confidence: 'low' }
    : { tier: 'edit', rule: 'length-fallback', confidence: 'low' };
}

/** Rules-only tier. Unchanged behaviour; kept for callers that cannot await. */
export function classifyRequest(prompt: string, isEmptyProject: boolean): RequestTier {
  return classifyRequestDetailed(prompt, isEmptyProject).tier;
}

/** Step budgets per tier
 *  fix needs 28+   agent reads 3-4 files, diagnoses, writes, verifies, may re-edit
 *  edit needs 25+   read + write + build check + possible re-edit cycle
 */
/**
 * How many DISTINCT files one run of each tier may modify, enforced in
 * agentToolSet.ts. Lives next to TIER_MAX_STEPS because they are the same
 * concept -- a tier's budget -- and because the capability preamble generates
 * its text from both. Keeping the cap in a single exported place is what lets
 * the prompt state it and the gate enforce it without the two drifting.
 *
 * Tiers absent here are uncapped.
 */
export const TIER_FILE_CAPS: Partial<Record<RequestTier, number>> = { micro: 3, edit: 10, fix: 10 };

export const TIER_MAX_STEPS: Record<RequestTier, number> = {
  micro:    8,
  fix:     28,
  edit:    25,
  feature: 35,
  build:   45,
};

/**
 * Model routing per tier (enforced in ai.routes.ts):
 *   micro   → Gemini Flash  (CHEAP_TASK_MODEL)     visual tweaks, $0.075/MTok
 *   fix     → Gemini Pro    (FIX_TIER_MODEL)        error diagnosis, $1.25/MTok
 *   edit+   → user's model  (primary/free)          full reasoning needed
 *
 * isCheapTier: true only for micro   routes to Flash regardless of user selection.
 * Fix gets Gemini Pro via separate branch in ai.routes.ts (not this function).
 */
export function isCheapTier(tier: RequestTier): boolean {
  return tier === 'micro';
}

// ── Resolving the low-confidence band ────────────────────────────────────────

const TIERS: readonly RequestTier[] = ['micro', 'fix', 'edit', 'feature', 'build'];

const RESOLVER_PROMPT = `You route a web-app edit request to a work tier. Answer with ONE word, nothing else.

micro   - a CSS-level visual tweak to something that already exists (colour, spacing, font, radius, shadow). No new elements, no logic.
edit    - change, replace or remove one existing thing. Touches roughly one file.
fix     - something is broken or not behaving correctly, and the cause must be found first.
feature - add a new page, section, component or capability, or restyle broadly across many files.
build   - create a whole new site or app, or rebuild one from scratch.

Request: `;

/**
 * A slow router must not delay a run, but 2500ms was too tight to ever succeed:
 * measured live 2026-09-01, a Flash round-trip for this took ~3s and the ceiling
 * fired on every ambiguous prompt, so the resolver paid the latency and always
 * fell back to the rules. 6s clears the observed round-trip with headroom.
 */
const RESOLVER_TIMEOUT_MS = 6000;

export interface ResolvedTier extends TierDecision {
  source: 'rules' | 'llm';
}

function parseTier(raw: string): RequestTier | null {
  const word = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  return TIERS.find((t) => t === word) ?? null;
}

async function askModelForTier(prompt: string): Promise<string> {
  // Imported lazily so the classifier stays a pure, dependency-free module for
  // every caller that only wants the rules.
  const [{ generateText }, { getCheapProvider }] = await Promise.all([
    import('ai'),
    import('./cheapModel.js'),
  ]);
  const { model } = getCheapProvider();
  const result = await Promise.race([
    generateText({
      model,
      messages: [{ role: 'user', content: `${RESOLVER_PROMPT}${prompt.slice(0, 1500)}` }],
      maxOutputTokens: 5,
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tier resolver timeout')), RESOLVER_TIMEOUT_MS)),
  ]);
  return result.text ?? '';
}

/**
 * The tier to actually run with.
 *
 * High-confidence rule matches are returned as-is: they are free, instant, and
 * carry real evidence. A model is consulted ONLY for the low-confidence band --
 * a bare verb, weak "can't" phrasing, or the length fallback -- which is where
 * misroutes concentrate and where the cascade was previously guessing while
 * looking certain. That keeps the cost at a handful of tokens on a minority of
 * requests instead of a routing call on every one.
 *
 * Fails open in every direction: a timeout, an error, or any answer that is not
 * one of the five tier words leaves the rules' own verdict in place, so routing
 * can never be worse than it was before this existed.
 *
 * @param ask injectable for tests; defaults to the real cheap-model call.
 */
export async function resolveRequestTier(
  prompt: string,
  isEmptyProject: boolean,
  ask: (p: string) => Promise<string> = askModelForTier,
): Promise<ResolvedTier> {
  const ruled = classifyRequestDetailed(prompt, isEmptyProject);
  if (ruled.confidence === 'high') return { ...ruled, source: 'rules' };

  try {
    const answer = await ask(prompt);
    const parsed = parseTier(answer);
    if (!parsed) {
      // Falling back silently is how a router that never works looks healthy.
      logger.warn('[tier-resolver] unusable answer, keeping the rules verdict', {
        rule: ruled.rule, tier: ruled.tier, answer: answer.slice(0, 40),
      });
      return { ...ruled, source: 'rules' };
    }
    return { tier: parsed, rule: `${ruled.rule}->llm`, confidence: 'high', source: 'llm' };
  } catch (err) {
    logger.warn('[tier-resolver] call failed, keeping the rules verdict', {
      rule: ruled.rule, tier: ruled.tier, error: (err as Error).message,
    });
    return { ...ruled, source: 'rules' };
  }
}
