// @ts-ignore
import Redlock, { Lock } from 'redlock';
import { Redis } from 'ioredis';

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisUrl = process.env.REDIS_URL;

// Instantiate Redis Client for Redlock distributed locking
export const redisClient = redisUrl
  ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false })
  : new Redis({
      host: redisHost,
      port: redisPort,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });

let isRedisConnected = false;

redisClient.on('connect', () => {
  isRedisConnected = true;
});

redisClient.on('ready', () => {
  isRedisConnected = true;
});

redisClient.on('error', () => {
  isRedisConnected = false;
});

redisClient.on('end', () => {
  isRedisConnected = false;
});

// Configure Redlock with drift factor, retry count, delay, and retry jitter
export const redlock = new Redlock([redisClient], {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});

// ── Local In-Memory Lock Fallback Map (for offline/disconnected single-node operation) ──
const localProjectLocks = new Map<string, Promise<void>>();

function acquireLocalLock(projectId: string): { release: () => void; ready: Promise<void> } {
  const prev = localProjectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  localProjectLocks.set(projectId, prev.then(() => gate));
  return {
    release: () => {
      release();
      cleanupProjectLock(projectId);
    },
    ready: prev,
  };
}

export interface ProjectLockHandle {
  ready: Promise<void>;
  release: () => Promise<void>;
}

// How long a second run will queue behind a lock-holder before failing loudly.
// Queueing (like the local fallback's promise chain) is the correct semantic;
// proceeding in parallel is never acceptable -- that silently interleaves two
// runs' disk writes and preview pushes on the same project.
const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;
const CONTENTION_RETRY_MS = 1000;

/**
 * Acquire a distributed lock for a project using Redlock on `locks:project:${projectId}`.
 *
 * Contention vs outage are handled DIFFERENTLY (2026-08-10 -- verified live
 * that the old code conflated them): if Redis is healthy but the lock is
 * held, we keep waiting (queue semantics, up to MAX_QUEUE_WAIT_MS, then
 * reject loudly). Only a genuine Redis outage degrades to the per-process
 * in-memory fallback. The old catch-all fallback meant a second same-project
 * run waited ~2s of Redlock retries and then proceeded IN PARALLEL via its
 * own process's empty local map -- defeating the lock exactly when it
 * mattered; reproduced with two processes before this fix.
 *
 * The held lock is auto-extended every ttlMs/2 while the run is in flight:
 * redlock.acquire()'s manual API never self-extends, so the default 45s TTL
 * silently expired under any multi-minute run. If the process crashes, the
 * TTL lapses within ttlMs and the next run proceeds -- extension only
 * happens while we're alive to do it.
 */
export function acquireProjectLock(projectId: string, ttlMs: number = 45000): ProjectLockHandle {
  const resourceKey = `locks:project:${projectId}`;

  let redlockLock: Lock | null = null;
  let localRelease: (() => void) | null = null;
  let extendTimer: NodeJS.Timeout | null = null;
  let released = false;

  const startExtending = () => {
    extendTimer = setInterval(async () => {
      if (released || !redlockLock) return;
      try {
        redlockLock = await redlockLock.extend(ttlMs);
      } catch {
        // Extension failed (Redis blip or lock expired). Don't crash the run;
        // the worst case is the pre-fix behavior (lock lapses at TTL).
      }
    }, Math.max(1000, Math.floor(ttlMs / 2)));
    extendTimer.unref?.();
  };

  const readyPromise = (async () => {
    // Attempt lazy connect if status is wait
    if (redisClient.status === 'wait') {
      try {
        await redisClient.connect();
        isRedisConnected = true;
      } catch {
        isRedisConnected = false;
      }
    }

    if (isRedisConnected && redisClient.status === 'ready') {
      const deadline = Date.now() + MAX_QUEUE_WAIT_MS;
      while (true) {
        try {
          redlockLock = await redlock.acquire([resourceKey], ttlMs);
          startExtending();
          return;
        } catch {
          if (redisClient.status !== 'ready') {
            // Genuine Redis outage mid-wait -> degrade to local fallback below.
            break;
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Project ${projectId} is locked by another in-flight run and did not free up within ${MAX_QUEUE_WAIT_MS / 60000} minutes. ` +
              `Not proceeding in parallel -- retry once the other run finishes.`,
            );
          }
          await new Promise((r) => setTimeout(r, CONTENTION_RETRY_MS + Math.floor(Math.random() * 250)));
        }
      }
    }

    // Fallback to local in-memory lock (Redis unavailable only -- never contention)
    const local = acquireLocalLock(projectId);
    localRelease = local.release;
    await local.ready;
  })();

  return {
    ready: readyPromise,
    release: async () => {
      released = true;
      if (extendTimer) clearInterval(extendTimer);
      if (redlockLock) {
        try {
          await redlockLock.release();
        } catch {
          // Lock may have expired or already been released; safe to ignore
        }
      }
      if (localRelease) {
        localRelease();
      }
    },
  };
}

/**
 * Removes the local lock-chain entry once nothing else is queued behind it.
 * Call after releasing the lock returned by acquireProjectLock.
 */
export function cleanupProjectLock(projectId: string): void {
  const current = localProjectLocks.get(projectId);
  if (current) {
    current
      .then(() => {
        localProjectLocks.delete(projectId);
      })
      .catch(() => localProjectLocks.delete(projectId));
  }
}
