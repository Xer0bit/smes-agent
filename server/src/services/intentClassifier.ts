/**
 * Lightweight request-tier classifier — zero LLM cost, ~0ms.
 *
 * Classifies a user prompt into one of five tiers so the agent loop can
 * select the appropriate model and step budget instead of always running the
 * most expensive path.
 *
 * Tier → MAX_STEPS → default model
 *   micro   →  6  → Gemini Flash  (color, text, spacing, icon tweaks — only tier that uses cheap model)
 *   fix     → 28  → user choice   (error fixes, broken previews)
 *   edit    → 18  → user choice   (update/modify/remove one thing)
 *   feature → 22  → user choice   (add a page/section/component)
 *   build   → 30  → user choice   (new project or full rebuild)
 */

export type RequestTier = 'micro' | 'fix' | 'edit' | 'feature' | 'build';

// ── Micro signal words — checked FIRST so "change color" beats "change" ──────
// Matches any CSS-property-level visual tweak. No structural change, no new components.
// "logo" and "size" deliberately excluded — too ambiguous ("logo section", "resize page").
const MICRO_RE = /\b(color|colour|font.?size|font.?weight|font.?family|margin|padding|spacing|opacity|border.?radius|border.?color|shadow|background.?color|bg.?color|letter.?spacing|line.?height|text.?align|bold|italic|underline|uppercase|lowercase|capitalize|placeholder|wording|typo|rounded|gradient|hover|sticky|blur|transparent|animation|animate|transition|smooth|glow|cursor|outline|brightness|contrast|saturate|scale|rotate|translate|skew)\b/i;

// ── Fix signal — checked before build so "build error" → fix not build ───────
const FIX_RE = /\b(fix|repair|resolve|debug|broken|not working|doesn'?t work|can'?t|won'?t|crash|fail(s|ed|ing)?|blank\s+screen|white\s+screen|404|disappear|TypeError|ReferenceError|build\s+error|compile\s+error|console\s+error|not\s+(showing|loading|rendering|displaying|appearing)|stopped\s+working|keeps?\s+(crashing|failing|breaking))\b/i;

// ── Build — only when explicitly creating a new project, not just using "make/create" as verbs ──
const BUILD_RE = /\b(new project|from scratch|website for|app for|set up|scaffold)\b|\b(build|create|make|generate)\s+(a\s+|an?\s+|the\s+)?(new\s+)?(website|web\s*app|landing\s*page|portfolio|store|shop|restaurant|saas|dashboard\s+app)\b/i;

// ── Feature — adding a substantial new element ────────────────────────────────
// Expanded verbs beyond just "add": create, include, insert, implement, build, make, generate, put.
// BUILD_RE is checked first, so "build a website" → build, "build a navbar" → feature.
// Allows up to two adjective words between verb and noun ("add a beautiful contact form").
const FEATURE_RE = /\b(add|create|include|insert|implement|build|make|generate|put)\s+(?:a\s+|an?\s+|the\s+|new\s+|me\s+a?\s*)?(?:\w+\s+){0,2}(page|section|component|feature|tab|modal|form|table|chart|graph|navbar|nav\s*bar|footer|header|sidebar|hero|banner|carousel|slider|dropdown|accordion|breadcrumb|stepper|wizard|dashboard|login|signup|register|auth|checkout|cart|product|blog|portfolio|gallery|map|video|player|timeline|faq|testimonial|pricing|contact|about|team|service|features?|menu|widget|panel|drawer|sheet|popover|tooltip|notification|toast|badge|chip|tag|search\s*bar|search|filter|sort\s*by|pagination|upload|profile|settings)\b/i;

// ── Broad-scope words — these imply touching many files → feature tier ────────
// "redesign", "revamp", "rework", "refactor", "restructure", "overhaul", "redo",
// "polish", "improve", "modernize", "restyle" — checked BEFORE EDIT_RE.
const BROAD_RE = /\b(redesign|revamp|rework|refactor|restructure|overhaul|redo|polish\s+(the\s+)?(ui|interface|design|look|style|page|app)|improve\s+(the\s+)?(ui|interface|design|look|style)|modernize|restyle|clean\s+up\s+(the\s+)?(ui|design|layout|style|code)|make\s+(?:it|this|the\s+\w+(?:\s+\w+)?)\s+(?:look|feel)\s+(?:more\s+)?(?:better|modern|clean|polished|professional)|full\s+(ui|design|style)\s+overhaul)\b/i;

// ── Edit — targeted single-thing changes to existing elements ─────────────────
const EDIT_RE = /\b(change|update|modify|remove|delete|replace|move|reorder|rename|hide|show|toggle|enable|disable|adjust|add\s+(a\s+|the\s+)?(button|link|field|input|label|icon|image|text|title|heading|paragraph|list|item|row|column|class|attribute|prop))\b/i;

export function classifyRequest(prompt: string, isEmptyProject: boolean): RequestTier {
  if (isEmptyProject) return 'build';
  // Micro first — "change the button color" should be micro not edit
  if (MICRO_RE.test(prompt)) return 'micro';
  // Fix before build — "build error" must not trigger build tier
  if (FIX_RE.test(prompt)) return 'fix';
  if (BUILD_RE.test(prompt)) return 'build';
  if (FEATURE_RE.test(prompt)) return 'feature';
  // Broad-scope words imply touching many files → feature tier, not edit
  if (BROAD_RE.test(prompt)) return 'feature';
  if (EDIT_RE.test(prompt)) return 'edit';
  // Fallback: short prompts are likely targeted edits, long ones are features
  return prompt.trim().length > 400 ? 'feature' : 'edit';
}

/** Step budgets per tier
 *  fix needs 28+ — agent reads 3-4 files, diagnoses, writes, verifies, may re-edit
 *  edit needs 25+ — read + write + build check + possible re-edit cycle
 */
export const TIER_MAX_STEPS: Record<RequestTier, number> = {
  micro:    8,
  fix:     28,
  edit:    25,
  feature: 35,
  build:   45,
};

/**
 * Model routing per tier (enforced in ai.routes.ts):
 *   micro   → Gemini Flash  (CHEAP_TASK_MODEL)   — visual tweaks, $0.075/MTok
 *   fix     → Gemini Pro    (FIX_TIER_MODEL)      — error diagnosis, $1.25/MTok
 *   edit+   → user's model  (primary/free)        — full reasoning needed
 *
 * isCheapTier: true only for micro — routes to Flash regardless of user selection.
 * Fix gets Gemini Pro via separate branch in ai.routes.ts (not this function).
 */
export function isCheapTier(tier: RequestTier): boolean {
  return tier === 'micro';
}
