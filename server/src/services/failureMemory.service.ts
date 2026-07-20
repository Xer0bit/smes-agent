/**
 * Failure memory   error signature -> verified fix.
 *
 * Checked before escalating any build error to the LLM repair agent
 * (agentLoopService.ts PASS -1, before the existing mechanical-repair PASS 0).
 * Only ever stores an outcome AFTER the build passed following that fix  
 * grounded in a verified result, so it can't drift the way an LLM summary
 * would. Global across projects (not per-project) since the same error
 * classes   missing imports, bracket imbalance, wrong router API   recur
 * across independent projects built from the same base template.
 */

import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY || '';

function getClient() {
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

const MAX_ENTRIES = 2000; // LRU cap   evict oldest by last_used_at beyond this

// Fix content is replayed verbatim into OTHER projects, so it must never contain
// anything that looks like a real credential (JWT, tenant schema name, API key).
// A fix that legitimately needed one of these should reference the env var, not
// a literal value   so rejecting on sight is safe and catches the leak class
// where an LLM diff hardcodes a working secret instead of an env reference.
const SECRET_SHAPE_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|tenant_[a-f0-9]{10,}/i;

function containsSecretShape(text: string): boolean {
  return SECRET_SHAPE_RE.test(text);
}

export type FixKind = 'mechanical' | 'llm_diff';

export interface FailureMemoryEntry {
  fixKind: FixKind;
  fixContent: string;
  hitCount: number;
}

/**
 * Normalize a raw error message into a stable signature: strip file paths,
 * line/column numbers, and project-specific identifiers so the same error
 * CLASS (not the same exact occurrence) matches across projects.
 */
export function normalizeErrorSignature(rawError: string): string {
  return rawError
    .split('\n')
    .slice(0, 2)
    .join(' ')
    .replace(/\/[\w./\-]+\.(tsx?|jsx?|css|json)(:\d+(:\d+)?)?/g, '<file>') // file paths + line:col
    .replace(/\b[a-f0-9]{8,}\b/gi, '<hash>') // hashes/ids
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/** Look up a previously-verified fix for this error signature. Returns null on miss or if DB unavailable. */
export async function lookupFailureFix(rawError: string): Promise<FailureMemoryEntry | null> {
  const db = getClient();
  if (!db) return null;

  const signature = normalizeErrorSignature(rawError);
  if (!signature) return null;

  try {
    const { data, error } = await db
      .from('agent_failure_memory')
      .select('fix_kind, fix_content, hit_count')
      .eq('error_signature', signature)
      .maybeSingle();

    if (error || !data) return null;

    // Defense in depth: never replay a fix into another project if it somehow
    // contains a secret-shaped value (should already be blocked at store time).
    if (containsSecretShape(data.fix_content)) {
      logger.warn(`[FailureMemory] Refusing to replay fix for signature (contains secret-shaped content): ${signature.slice(0, 80)}`);
      return null;
    }

    // Fire-and-forget: bump hit_count + last_used_at (LRU freshness)
    db.from('agent_failure_memory')
      .update({ hit_count: data.hit_count + 1, last_used_at: new Date().toISOString() })
      .eq('error_signature', signature)
      .then(() => {}, () => {});

    return { fixKind: data.fix_kind as FixKind, fixContent: data.fix_content, hitCount: data.hit_count };
  } catch (err) {
    logger.warn('[FailureMemory] lookup error:', err);
    return null;
  }
}

/**
 * Store a fix that was JUST VERIFIED to clear this error (caller must confirm
 * the build passed after applying it   this function does not re-verify).
 */
export async function storeFailureFix(rawError: string, fixKind: FixKind, fixContent: string): Promise<void> {
  const db = getClient();
  if (!db) return;

  const signature = normalizeErrorSignature(rawError);
  if (!signature || !fixContent) return;

  if (containsSecretShape(fixContent)) {
    logger.warn(`[FailureMemory] Refusing to store fix (contains secret-shaped content) for signature: ${signature.slice(0, 80)}`);
    return;
  }

  try {
    await db.from('agent_failure_memory').upsert(
      {
        error_signature: signature,
        fix_kind: fixKind,
        fix_content: fixContent.slice(0, 4000),
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'error_signature' },
    );
    logger.info(`[FailureMemory] Stored fix for signature: ${signature.slice(0, 80)}`);

    // Best-effort LRU eviction   cheap count check, only runs the delete when over cap.
    const { count } = await db.from('agent_failure_memory').select('id', { count: 'exact', head: true });
    if (typeof count === 'number' && count > MAX_ENTRIES) {
      const { data: oldest } = await db
        .from('agent_failure_memory')
        .select('id')
        .order('last_used_at', { ascending: true })
        .limit(count - MAX_ENTRIES);
      if (oldest && oldest.length > 0) {
        await db.from('agent_failure_memory').delete().in('id', oldest.map(r => r.id));
      }
    }
  } catch (err) {
    logger.warn('[FailureMemory] store error:', err);
  }
}
