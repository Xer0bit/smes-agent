/**
 * Lightweight request-tier classifier — zero LLM cost, ~0ms.
 *
 * Classifies a user prompt into one of five tiers so the agent loop can
 * select the appropriate model and step budget instead of always running the
 * most expensive path.
 *
 * Tier → MAX_STEPS → default model
 *   micro   →  6  → Gemini Flash  (color, text, spacing, icon tweaks)
 *   fix     →  8  → Gemini Flash  (error fixes, broken previews)
 *   edit    → 12  → Gemini Flash  (update/modify/remove one thing)
 *   feature → 18  → user choice   (add a page/section/component)
 *   build   → 25  → user choice   (new project or full rebuild)
 */

export type RequestTier = 'micro' | 'fix' | 'edit' | 'feature' | 'build';

// Order matters: more-specific patterns are checked before general ones.
const BUILD_RE = /\b(build|create|make|generate|new project|from scratch|website for|app for|landing page|set up|scaffold)\b/i;

const FEATURE_RE = /\badd\s+(a\s+|the\s+|an?\s+)?(page|section|component|feature|tab|modal|form|table|chart|graph|navbar|nav bar|footer|header|sidebar|hero|banner|carousel|slider|dropdown|accordion|breadcrumb|stepper|wizard|dashboard|login|signup|register|auth|checkout|cart|product|blog|portfolio|gallery|map|video|player|timeline|FAQ)\b/i;

const FIX_RE = /\b(fix|repair|resolve|debug|broken|error|bug|issue|problem|not working|doesn'?t work|can'?t|wont|won'?t|crash|fail(s|ed|ing)?|blank|white screen|404|missing|disappear|undefined|null|type error|build error|compile)\b/i;

const EDIT_RE = /\b(change|update|modify|remove|delete|replace|adjust|move|reorder|rename|hide|show|toggle|enable|disable|add\s+(a\s+|the\s+)?(button|link|field|input|label|icon|image|text|title|heading|paragraph|list|item|row|column|class|style|attribute|prop|property))\b/i;

const MICRO_RE = /\b(color|colour|font|size|font.?size|margin|padding|spacing|opacity|border|shadow|radius|background|bg|width|height|align|justify|flex|grid|gap|letter.?spacing|line.?height|text.?align|weight|bold|italic|underline|uppercase|lowercase|capitalize|icon|logo|placeholder|wording|typo|typo.?fix|rename|relabel)\b/i;

export function classifyRequest(prompt: string, isEmptyProject: boolean): RequestTier {
  if (isEmptyProject) return 'build';
  if (BUILD_RE.test(prompt)) return 'build';
  if (FEATURE_RE.test(prompt)) return 'feature';
  if (FIX_RE.test(prompt)) return 'fix';
  if (EDIT_RE.test(prompt)) return 'edit';
  if (MICRO_RE.test(prompt)) return 'micro';
  // Fallback: short prompts are likely targeted edits, long ones are features
  return prompt.trim().length > 400 ? 'feature' : 'edit';
}

/** Step budgets per tier */
export const TIER_MAX_STEPS: Record<RequestTier, number> = {
  micro:   6,
  fix:     8,
  edit:    12,
  feature: 18,
  build:   25,
};

/** Whether a tier should be force-routed to the cheap model regardless of user selection */
export function isCheapTier(tier: RequestTier): boolean {
  return tier === 'micro' || tier === 'fix' || tier === 'edit';
}
