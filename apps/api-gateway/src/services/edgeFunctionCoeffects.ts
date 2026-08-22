/**
 * Reactive coeffects for edge functions -- Phase 4 of spatiotemporal
 * composability adoption.
 *
 * Basis: Shi, Zhang & Cui, "A Programming Paradigm for Spatiotemporal
 * Composability" (PKU + DeepSeek-AI, 2026), section 3.2 and its implementation
 * in 5.1.2. A component declares the coeffects it requires; every change to the
 * context is classified against that declaration as activating, deactivating,
 * or neutral; and "a plugin whose dependency is unavailable stays inactive
 * until it appears, without erroring" (section 5.3).
 *
 * THE GAP THIS CLOSES. database.service.ts already scans a function's code for
 * the tables it touches, in order to grant permissions. When a referenced table
 * does not exist it skips it with the comment "typo'd/not-yet-created table --
 * not this function's problem". So a function that queries a table nobody
 * created deploys clean, reports success, and then fails at runtime in a
 * customer's browser with no signal pointing at the cause. In coeffect terms
 * the function declared a dependency that was never satisfied, and we activated
 * it anyway.
 *
 * That is the CardPro failure shape generalised: auth-login-v2 shipped
 * "working" and only its users discovered otherwise. Resolving declared
 * requirements BEFORE reporting a deploy as usable is what turns a runtime
 *500 into a deploy-time sentence.
 *
 * Extraction is deliberately regex-based rather than a full parse, matching the
 * existing scan in database.service.ts. It is therefore INCOMPLETE by
 * construction: it finds the literal-string cases that generated code
 * overwhelmingly uses, and misses dynamic ones. That is why an unsatisfied
 * requirement is reported rather than enforced -- a false negative must not
 * block a legitimate deploy. See resolveCoeffects.
 */

/** What a function needs from its environment in order to work. */
export interface Coeffects {
  tables: string[];
  rpcs: string[];
  secrets: string[];
}

/** Section 3.2's reactive classification of a context change. */
export type CoeffectChange = 'activating' | 'deactivating' | 'neutral';

export interface CoeffectResolution {
  satisfied: boolean;
  missing: Coeffects;
  /** How this resolution differs from the previous one, when there was one. */
  change: CoeffectChange;
}

// Mirrors database.service.ts's ensureFunctionDbAccess scan so the two cannot
// disagree about what a function is asking for.
const TABLE_RE = /\bdb\.(?:select|insert|update|delete|count)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
const RPC_RE = /\bdb\.rpc\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
// `secrets` is the injected object the runner provides (see runEdgeFunction.js).
// Both member and index access appear in generated code.
const SECRET_DOT_RE = /\bsecrets\.([A-Z][A-Z0-9_]*)\b/g;
const SECRET_IDX_RE = /\bsecrets\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;

function uniqueMatches(code: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out].sort();
}

/** Read a function's declared environmental requirements out of its code. */
export function extractCoeffects(code: string): Coeffects {
  return {
    tables: uniqueMatches(code, TABLE_RE),
    rpcs: uniqueMatches(code, RPC_RE),
    secrets: [...new Set([...uniqueMatches(code, SECRET_DOT_RE), ...uniqueMatches(code, SECRET_IDX_RE)])].sort(),
  };
}

/**
 * Resolve requirements against what the environment actually provides.
 *
 * `previouslySatisfied` supplies section 3.2's reactive classification: the same
 * resolution means something different depending on what it was before. A
 * dependency appearing is activating, one disappearing is deactivating, and a
 * change that does not flip satisfaction is neutral and must not cause churn --
 * Cordis reloads a fiber "precisely when one of its declared keys comes to be
 * provided by a different fiber", not on every context change.
 *
 * RPCs are intentionally not resolved here. The existing permission preflight
 * grants schema USAGE for pgcrypto-backed helpers, and enumerating every
 * available function to prove absence is a much heavier query than the value
 * justifies -- an unresolvable rpc still surfaces at test_edge_function time.
 */
export function resolveCoeffects(
  required: Coeffects,
  available: { tables: Set<string>; secrets: Set<string> },
  previouslySatisfied?: boolean,
): CoeffectResolution {
  const missing: Coeffects = {
    tables: required.tables.filter((t) => !available.tables.has(t)),
    rpcs: [],
    secrets: required.secrets.filter((s) => !available.secrets.has(s)),
  };
  const satisfied = missing.tables.length === 0 && missing.secrets.length === 0;

  let change: CoeffectChange = 'neutral';
  if (previouslySatisfied !== undefined && previouslySatisfied !== satisfied) {
    change = satisfied ? 'activating' : 'deactivating';
  }

  return { satisfied, missing, change };
}

/**
 * A human-facing sentence naming exactly what is missing, or null when
 * everything resolves.
 *
 * This is the whole user-visible payoff of the phase: the difference between
 * "deployed successfully" followed by a 500 in production, and being told at
 * deploy time which table nobody created.
 */
export function describeUnsatisfied(resolution: CoeffectResolution): string | null {
  if (resolution.satisfied) return null;
  const parts: string[] = [];
  if (resolution.missing.tables.length > 0) {
    parts.push(
      `table(s) that do not exist yet: ${resolution.missing.tables.join(', ')} ` +
      `(create them with query_database before this function can work)`,
    );
  }
  if (resolution.missing.secrets.length > 0) {
    parts.push(
      `secret(s) that are not set: ${resolution.missing.secrets.join(', ')} ` +
      `(set them with set_secret; refer to them by NAME only)`,
    );
  }
  return (
    `This function declares requirements its environment does not currently provide -- ` +
    `${parts.join('; and ')}. It is deployed but will fail at runtime until they exist. ` +
    `Do NOT report it as working to the user yet.`
  );
}
