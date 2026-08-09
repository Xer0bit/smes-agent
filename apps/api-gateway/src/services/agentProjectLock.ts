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

/**
 * Acquire a distributed lock for a project using Redlock on `locks:project:${projectId}`.
 * Safely falls back to local in-memory mutex if Redis connection is unavailable.
 */
export function acquireProjectLock(projectId: string, ttlMs: number = 45000): ProjectLockHandle {
  const resourceKey = `locks:project:${projectId}`;

  let redlockLock: Lock | null = null;
  let localRelease: (() => void) | null = null;

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
      try {
        redlockLock = await redlock.acquire([resourceKey], ttlMs);
        return;
      } catch {
        // Redlock acquisition failed (e.g. timeout or lock contention exception)
        // Fall back to local locking mechanism
      }
    }

    // Fallback to local in-memory lock
    const local = acquireLocalLock(projectId);
    localRelease = local.release;
    await local.ready;
  })();

  return {
    ready: readyPromise,
    release: async () => {
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
