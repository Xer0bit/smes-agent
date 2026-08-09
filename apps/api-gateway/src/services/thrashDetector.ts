/**
 * Session-level thrash detector (Phase 2 of the 2026-08-06 agent-loop root-cause
 * audit). Distinct from get_build_errors.ts's own circuit breaker: that one
 * detects the same error twice IN A ROW within a single ~10-minute window and
 * deletes its counter the moment it trips, so it has no memory across trips.
 * This module tracks trips PERSISTENTLY (agent_error_thrash table) so a second
 * trip on the same underlying error   even after the model was already told
 * once to rewrite from scratch and tried again   can be escalated to an honest
 * "I've tried N times, here's what's still broken" instead of another
 * confident rewrite. See agent_error_thrash migration for the full rationale.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const thrashDb = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Entries older than this are treated as a new session   an error that hasn't
// recurred in 2 hours isn't the same thrash loop, it's a fresh problem (or a
// fresh attempt days later). Deliberately longer than the 10-minute per-call
// breaker window in get_build_errors.ts: this tracks across MULTIPLE breaker
// trip-and-reset cycles, not just repeats within one.
const THRASH_SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

// Escalate on the 2nd trip of the SAME fingerprint within the session window.
// Matches the audit's "start at 2 repeats" instruction   the underlying
// get_build_errors breaker already handles the 1st trip (rewrite-from-scratch
// nudge); this only needs to catch the case where that nudge didn't work.
const THRASH_ESCALATION_THRESHOLD = 2;

const errorKindPatterns: Array<[RegExp, string]> = [
  [/cannot find module ['"]([^'"]+)['"]/i, 'missing-module'],
  [/module not found/i, 'missing-module'],
  [/failed to resolve (?:import|module)/i, 'missing-module'],
  [/is not defined\b/i, 'not-defined'],
  [/unexpected token/i, 'syntax'],
  [/unexpected end of (?:input|file)/i, 'syntax'],
  [/is not a function\b/i, 'not-a-function'],
  [/cannot read propert(?:y|ies) of (?:undefined|null)/i, 'null-deref'],
  [/cannot read propert(?:y|ies) .* of undefined/i, 'null-deref'],
  [/\bts\d{4}\b/i, 'type-error'],
  [/type error/i, 'type-error'],
  [/is missing the following properties/i, 'type-error'],
  [/maximum call stack/i, 'infinite-recursion'],
  [/is not exported/i, 'bad-export'],
  [/has no exported member/i, 'bad-export'],
];

/** Classify an error line into a normalized, low-cardinality kind   NOT the
 *  raw message text, which varies slightly run to run (different line
 *  numbers, different variable names) even for the structurally same bug. */
function classifyErrorKind(errorText: string): string {
  for (const [re, kind] of errorKindPatterns) {
    if (re.test(errorText)) return kind;
  }
  return 'other';
}

/** Extract the first project-relative source file path mentioned in an error line. */
function extractFilePath(errorText: string): string {
  const m = errorText.match(/\b(?:projects\/[^/]+\/)?(src\/[\w./-]+\.(?:tsx?|jsx?))\b/);
  return m ? m[1] : 'unknown-file';
}

/**
 * Fingerprint a batch of condensed error strings as `file::kind` pairs, one
 * per unique combination, sorted for a stable signature regardless of the
 * order errors were reported in. This is file+error-class based, not a hash
 * of the raw text   the audit explicitly called out that raw-text signatures
 * (used elsewhere in the existing per-call breaker) miss the "same bug,
 * slightly different wording" case.
 */
export function computeErrorFingerprint(errors: string[]): string {
  const pairs = new Set<string>();
  for (const e of errors) {
    pairs.add(`${extractFilePath(e)}::${classifyErrorKind(e)}`);
  }
  return Array.from(pairs).sort().join('|') || 'unknown';
}

export interface ThrashSignalResult {
  /** True when this fingerprint has now tripped the underlying breaker
   *  THRASH_ESCALATION_THRESHOLD+ times in the session window   stop retrying,
   *  surface honestly to the user instead. */
  escalate: boolean;
  /** Total times this fingerprint's breaker has tripped in the session window. */
  tripCount: number;
}

// In-memory fallback, mirrors get_build_errors.ts's degrade-gracefully pattern
// for local dev without Supabase configured. Not shared across PM2 workers   a
// known, accepted limitation there too (see that file's own comment); this
// mechanism is a defense-in-depth layer on top of that one, not the sole guard.
const fallbackStore = new Map<string, { tripCount: number; ts: number }>();

/**
 * Record a circuit-breaker trip event for (projectId, fingerprint). Call this
 * from get_build_errors.ts exactly when its OWN in-call breaker trips   this
 * function's counter is a level up from that one, tracking trips-of-trips.
 */
export async function recordThrashTrip(projectId: string, fingerprint: string): Promise<ThrashSignalResult> {
  const now = Date.now();
  const key = `${projectId}::${fingerprint}`;

  if (!thrashDb) {
    const prev = fallbackStore.get(key);
    const isExpired = prev !== undefined && (now - prev.ts) > THRASH_SESSION_WINDOW_MS;
    const tripCount = (!prev || isExpired) ? 1 : prev.tripCount + 1;
    fallbackStore.set(key, { tripCount, ts: now });
    const escalate = tripCount >= THRASH_ESCALATION_THRESHOLD;
    console.warn(`[ThrashDetector] project=${projectId} fingerprint="${fingerprint}" tripCount=${tripCount} escalate=${escalate} (in-memory fallback)`);
    return { escalate, tripCount };
  }

  const { data: row } = await thrashDb
    .from('agent_error_thrash')
    .select('trip_count, last_seen_at')
    .eq('project_id', projectId)
    .eq('fingerprint', fingerprint)
    .maybeSingle();
  const isExpired = row != null && (now - new Date(row.last_seen_at).getTime()) > THRASH_SESSION_WINDOW_MS;
  const tripCount = (!row || isExpired) ? 1 : row.trip_count + 1;

  await thrashDb.from('agent_error_thrash').upsert({
    project_id: projectId,
    fingerprint,
    trip_count: tripCount,
    last_seen_at: new Date(now).toISOString(),
    ...(!row || isExpired ? { first_seen_at: new Date(now).toISOString() } : {}),
  }, { onConflict: 'project_id,fingerprint' });

  const escalate = tripCount >= THRASH_ESCALATION_THRESHOLD;
  console.warn(`[ThrashDetector] project=${projectId} fingerprint="${fingerprint}" tripCount=${tripCount} escalate=${escalate}`);
  return { escalate, tripCount };
}
