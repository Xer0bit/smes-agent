/**
 * The capability preamble: tell the agent its budgets and rules BEFORE it spends
 * a round trip discovering them.
 *
 * Measured over 477 traced runs / 4,256 steps: **390 steps (9.2%) ended in a
 * refusal**, and 182 runs (38%) hit at least one. The single largest kind was
 * `BLOCKED (tier file budget)` at 208 occurrences -- a cap that appeared
 * nowhere in any prompt. The agent planned a change, started writing, and was
 * cut off mid-task at the cap, then had to re-plan around a constraint it had
 * just discovered by violating it.
 *
 * Generated from the same constants the gates enforce (TIER_MAX_STEPS,
 * TIER_FILE_CAPS) rather than hand-written prose. A hand-maintained list would
 * be a second source of truth, and this codebase has already paid for that once:
 * the edge-function validator told the agent that hashing was impossible while
 * the sandbox injected Web Crypto and pgcrypto sat in the `extensions` schema.
 * A description that can drift from the enforcement is worse than no
 * description, because it is believed.
 */
import { TIER_FILE_CAPS, TIER_MAX_STEPS, type RequestTier } from '../services/intentClassifier.js';

/** Below this share of the project's recent size, the visible source is treated as truncated. */
const SOURCE_TRUNCATION_RATIO = 0.6;
/** Projects smaller than this are too small for the ratio to mean anything. */
const MIN_FILES_TO_JUDGE_SCALE = 10;

/**
 * True when the source this run can see is materially smaller than the project's
 * own recent history -- i.e. the run is probably looking at a damaged copy.
 */
export function isSourceTruncated(sourceFiles: number, expectedFiles: number): boolean {
  if (expectedFiles < MIN_FILES_TO_JUDGE_SCALE) return false;
  return sourceFiles < expectedFiles * SOURCE_TRUNCATION_RATIO;
}

/** Rules the tool gates enforce, stated up front instead of on violation. */
const GATE_RULES: readonly string[] = [
  'Before your first edit in a fix task, call `get_build_errors` -- a fix must be grounded in the real error, and an ungrounded edit is refused.',
  'If you called `declare_scope`, writes outside the declared paths are refused. Re-declare if the scope genuinely needs to grow.',
  'Replacing the same reference across three or more files is routed to the bulk tool; do not do it one `edit_file` at a time.',
  'A write that would ship syntactically broken code is refused before it reaches disk.',
  'Repeating an identical failing call is refused; change the approach rather than retrying it verbatim.',
  'After you write a file, any earlier read of that file in this conversation is stale. Re-read before building a SEARCH/REPLACE block against it.',
  'NEVER rebuild or replace an existing app wholesale. If the project looks empty, or much smaller than you expected, that is a SYMPTOM -- say so and stop. Do not recreate files you believe are missing.',
];

/**
 * @param tier the resolved request tier for this run
 * @param availableTools tool names actually present in this run's tool set
 * @param withheldTools tool names removed for this tier/context, if any
 */
export function buildCapabilityPreamble(
  tier: RequestTier | undefined,
  availableTools: readonly string[],
  withheldTools: readonly string[] = [],
  scale?: { sourceFiles: number; expectedFiles: number },
): string {
  if (!tier) return '';

  const steps = TIER_MAX_STEPS[tier];
  const fileCap = TIER_FILE_CAPS[tier];

  const lines: string[] = [
    '## Your budget and limits for this run',
    '',
    `Tier: **${tier}**.`,
    `Steps: up to ${steps}.`,
    fileCap === undefined
      ? 'Files: no fixed cap on distinct files modified.'
      : `Files: you may modify at most **${fileCap} distinct files**. Reaching the cap stops further writes, so if the task plainly needs more, say so before you start rather than after ${fileCap} files.`,
  ];

  if (availableTools.length > 0) {
    lines.push('', `Tools available: ${[...availableTools].sort().join(', ')}.`);
  }
  if (withheldTools.length > 0) {
    lines.push(
      `Not available on this tier: ${[...withheldTools].sort().join(', ')} -- do not plan around them.`,
    );
  }

  // Scale reference. The agent gets an accurate tree of whatever is on disk, but
  // no sense of how big the project SHOULD be -- so a truncated source looks
  // internally consistent and it "helpfully" recreates the app. That is exactly
  // what happened on 2026-09-02: a 25-file copy of a 199-file project, and the
  // run replaced the UI it believed was missing.
  if (scale && scale.expectedFiles > 0) {
    if (isSourceTruncated(scale.sourceFiles, scale.expectedFiles)) {
      lines.push(
        '',
        `**STOP -- this project's source looks incomplete.** You can see ${scale.sourceFiles} files, but this ` +
        `project recently had ${scale.expectedFiles}. Files are probably missing from your view, NOT from the ` +
        `project. Do not recreate anything and do not replace the existing UI. Report what you can see and ask ` +
        'the user to check, or restore a previous version.',
      );
    } else {
      lines.push('', `This project has ${scale.sourceFiles} source files. Work within it; do not recreate it.`);
    }
  }

  lines.push('', 'Rules enforced on tool calls (violations are refused, which costs you a step):');
  for (const r of GATE_RULES) lines.push(`- ${r}`);

  return lines.join('\n');
}
