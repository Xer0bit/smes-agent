/**
 * Redis cache in front of retrieveRelevantFiles(). The expensive part of a KB
 * lookup isn't recomputing embeddings (vectorStore.ts already skips unchanged
 * files via content-hash) -- it's the live round-trips on the QUERY side:
 * embedText() (an embedding-provider API call) + searchSimilarFiles() +
 * getDirectImports()/getDirectDependents() (Supabase pgvector/graph RPCs).
 * A repeated or near-duplicate query inside the cache window skips all of that.
 *
 * Short TTL by design: results here only steer which files the agent looks at
 * first, never the file content itself (that's always read fresh via
 * read_file) -- a ranking that's up to a minute stale is a non-issue, and a
 * miss just falls through to a live lookup exactly as before this cache existed.
 */
import crypto from 'crypto';
import { redisClient } from '../services/agentProjectLock.js';
import type { RetrievedFile, RetrievalOptions } from './retrieval.js';

const TTL_SECONDS = 60;

function cacheKey(projectId: string, prompt: string, options: RetrievalOptions): string {
  const normalized = JSON.stringify({
    maxFiles: options.maxFiles ?? 4,
    graphExpansion: options.graphExpansion ?? true,
    mentionedPaths: [...(options.mentionedPaths ?? [])].sort(),
    rerank: options.rerank ?? false,
  });
  const hash = crypto.createHash('md5').update(`${prompt}\n${normalized}`).digest('hex');
  return `kb:retrieval:${projectId}:${hash}`;
}

export async function getCachedRetrieval(
  projectId: string,
  prompt: string,
  options: RetrievalOptions,
): Promise<RetrievedFile[] | null> {
  try {
    const raw = await redisClient.get(cacheKey(projectId, prompt, options));
    if (!raw) return null;
    return JSON.parse(raw) as RetrievedFile[];
  } catch {
    // Redis down/slow/garbage entry -- treat exactly like a cache miss.
    return null;
  }
}

export async function setCachedRetrieval(
  projectId: string,
  prompt: string,
  options: RetrievalOptions,
  results: RetrievedFile[],
): Promise<void> {
  try {
    await redisClient.set(cacheKey(projectId, prompt, options), JSON.stringify(results), 'EX', TTL_SECONDS);
  } catch {
    // Best-effort only -- a failed cache write should never fail the run.
  }
}
