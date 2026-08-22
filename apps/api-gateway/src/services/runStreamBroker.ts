/**
 * Cross-worker run stream broker -- Phase 5 of spatiotemporal composability
 * adoption.
 *
 * Basis: Shi, Zhang & Cui, "A Programming Paradigm for Spatiotemporal
 * Composability" (PKU + DeepSeek-AI, 2026), section 6.2, "Cross-process
 * invocation": each process hosts its own local providers and "a coordinating
 * component links them, treating each as a remote provider", with access
 * mediated by a mechanism that preserves the interface.
 *
 * WHAT THIS FIXES. `activeAgentRuns` is a per-process Map but `ecomgear-gen`
 * runs 2 PM2 cluster workers, so a live run is only attachable from the worker
 * that owns it. Phase 0 made the OTHER worker at least tell the truth
 * (`attachable: false`) instead of reporting an idle project and then rejecting
 * the next message -- but a user landing on the wrong worker still could not
 * see the run's output, only wait it out. This carries the actual stream
 * across the process boundary so either worker can serve it.
 *
 * WHY REDIS STREAMS AND NOT PUB/SUB. A subscriber that joins mid-run needs the
 * chunks it missed, exactly as the in-process path replays
 * `currentRun.buffer`. Pub/sub has no history, so a late joiner would attach to
 * a run already in progress and render a truncated answer -- worse than not
 * attaching. A stream gives backlog and live tail through one mechanism: read
 * from id 0 and keep reading.
 *
 * BEST-EFFORT, LIKE THE LEDGER. Redis being down must never fail a run: every
 * function here degrades to a no-op or `false`, and the caller falls back to
 * today's behaviour (`attachable: false`). Section 6.2 also warns that a
 * cross-process call "may fail mid-flight", which is why the relay reports
 * completion rather than assuming it.
 */
import { redisClient } from './agentProjectLock.js';
import { logger } from '../utils/logger.js';

/** Chunks live only as long as a run plausibly could. */
const STREAM_TTL_SECONDS = 30 * 60;
/** Bound on retained chunks per run, so a pathological run cannot grow without limit. */
const STREAM_MAXLEN = 5000;
/** How long a tailing read parks before looping to re-check its abort signal. */
const BLOCK_MS = 5000;

const FIELD_CHUNK = 'c';
const FIELD_END = 'end';

function streamKey(projectId: string, runId: string): string {
  return `runstream:${projectId}:${runId}`;
}

function redisUsable(): boolean {
  return redisClient.status === 'ready';
}

/**
 * Append one SSE chunk for cross-worker subscribers.
 *
 * Deliberately not awaited by callers on the hot path: an agent run must not
 * slow down or fail because a mirror write did. Errors are swallowed to a debug
 * line -- a missing chunk degrades the remote view, it does not break the run
 * whose local subscribers are served from memory regardless.
 */
export async function publishRunChunk(projectId: string, runId: string, chunk: string): Promise<void> {
  if (!redisUsable()) return;
  const key = streamKey(projectId, runId);
  try {
    // MAXLEN ~ is the cheap approximate trim; exact trimming is not worth the
    // cost when the bound exists only to stop unbounded growth.
    await redisClient.xadd(key, 'MAXLEN', '~', String(STREAM_MAXLEN), '*', FIELD_CHUNK, chunk);
    await redisClient.expire(key, STREAM_TTL_SECONDS);
  } catch (err) {
    logger.debug('[run-broker] xadd failed (non-fatal)', { projectId, runId, error: (err as Error).message });
  }
}

/** Mark the run finished so tailing subscribers stop rather than hang to TTL. */
export async function publishRunEnd(projectId: string, runId: string): Promise<void> {
  if (!redisUsable()) return;
  const key = streamKey(projectId, runId);
  try {
    await redisClient.xadd(key, '*', FIELD_END, '1');
    await redisClient.expire(key, STREAM_TTL_SECONDS);
  } catch (err) {
    logger.debug('[run-broker] end marker failed (non-fatal)', { projectId, runId, error: (err as Error).message });
  }
}

export interface RelayCallbacks {
  onChunk: (chunk: string) => void;
  onEnd: () => void;
}

/**
 * Replay this run's chunks then follow it live, until it ends or the caller
 * aborts. Returns false when Redis is unavailable, so the caller can fall back
 * instead of leaving the client waiting on a stream that will never arrive.
 *
 * Uses a DUPLICATED connection: XREAD BLOCK occupies its connection for the
 * duration, so issuing it on the shared client would stall every other Redis
 * user in this process (the project lock included). `maxRetriesPerRequest` is
 * cleared on the duplicate because ioredis counts a parked blocking read
 * against that budget and would tear the connection down mid-tail.
 */
export async function relayRunStream(
  projectId: string,
  runId: string,
  callbacks: RelayCallbacks,
  signal: AbortSignal,
): Promise<boolean> {
  if (!redisUsable()) return false;

  const key = streamKey(projectId, runId);
  const sub = redisClient.duplicate({ maxRetriesPerRequest: null, enableOfflineQueue: true });

  try {
    // '0' rather than '$': start at the beginning so a subscriber joining
    // mid-run receives what it missed. This is the whole reason for a stream.
    let lastId = '0';
    while (!signal.aborted) {
      const res = (await sub.xread('BLOCK', BLOCK_MS, 'STREAMS', key, lastId)) as
        | Array<[string, Array<[string, string[]]>]>
        | null;

      // Null means the block elapsed with nothing new. Loop so the abort signal
      // is re-checked; do NOT treat it as end-of-run, the agent may simply be
      // thinking between tool calls.
      if (!res) continue;

      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          lastId = id;
          // fields is a flat [name, value, ...] array.
          for (let i = 0; i < fields.length - 1; i += 2) {
            if (fields[i] === FIELD_END) {
              callbacks.onEnd();
              return true;
            }
            if (fields[i] === FIELD_CHUNK) callbacks.onChunk(fields[i + 1]);
          }
        }
      }
    }
    return true;
  } catch (err) {
    logger.warn('[run-broker] relay failed', { projectId, runId, error: (err as Error).message });
    return false;
  } finally {
    // disconnect(), not quit(): quit() waits for a reply, and this connection
    // may be parked in a blocking read that will not answer.
    try { sub.disconnect(); } catch { /* already gone */ }
  }
}

/** True when some worker has published chunks for this run. */
export async function runStreamExists(projectId: string, runId: string): Promise<boolean> {
  if (!redisUsable()) return false;
  try {
    return (await redisClient.exists(streamKey(projectId, runId))) === 1;
  } catch {
    return false;
  }
}
