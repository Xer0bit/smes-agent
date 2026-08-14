import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { embedText, getProvider } from '../knowledgebase/embedder.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

export interface CachedDiffResult {
  hit: boolean;
  cachedSnapshot?: Record<string, string>;
  similarity?: number;
  cacheId?: string;
}

/**
 * Embeds via the same provider-fallback chain the rest of the KB layer uses
 * (embedder.ts: Google -> OpenAI -> BM25), not a hardcoded OpenAI-only call.
 * The prior version required OPENAI_API_KEY specifically and returned null
 * without it -- this cache was permanently inert on any deployment running
 * Google-only, including this one. embedText() never throws.
 */
async function getCacheEmbedding(text: string): Promise<number[] | null> {
  if (getProvider() === 'bm25') return null; // pseudo-embedding isn't meaningful cross-project
  try {
    return await embedText(text.slice(0, 4000));
  } catch {
    return null;
  }
}

/**
 * Check semantic cache for a prompt matching previously generated file snapshots
 * using pgvector cosine similarity search (threshold: 0.94).
 */
export async function checkSemanticCache(
  prompt: string,
  framework: string = 'react'
): Promise<CachedDiffResult> {
  if (!supabase || !prompt || !prompt.trim()) {
    return { hit: false };
  }

  try {
    const embedding = await getCacheEmbedding(prompt.trim());
    if (!embedding) {
      return { hit: false };
    }

    // Supabase RPC match_semantic_cache query with similarity_threshold 0.94
    const { data, error } = await supabase.rpc('match_semantic_cache', {
      query_embedding: embedding,
      similarity_threshold: 0.94,
      match_count: 1,
      p_framework: framework,
    });

    if (error || !data || !Array.isArray(data) || data.length === 0) {
      return { hit: false };
    }

    const match = data[0];
    const cacheId = match.id;
    const cachedSnapshot: Record<string, string> = match.file_snapshot || match.files_written || {};

    // Asynchronously update hit_count in background without blocking response
    if (cacheId) {
      supabase
        .from('agent_semantic_cache')
        .update({
          hit_count: (match.hit_count || 0) + 1,
          last_hit_at: new Date().toISOString(),
        })
        .eq('id', cacheId)
        .then(({ error: updateErr }) => {
          if (updateErr) {
            logger.warn('[agentSemanticCache] Failed to increment hit_count:', updateErr);
          }
        });
    }

    logger.info(`[agentSemanticCache] Semantic Hit! similarity=${match.similarity?.toFixed(4)} id=${cacheId}`);

    return {
      hit: true,
      cachedSnapshot,
      similarity: match.similarity,
      cacheId,
    };
  } catch (err) {
    // Fail silently so LLM agent loop continues unhindered
    logger.warn('[agentSemanticCache] Exception during cache check:', err);
    return { hit: false };
  }
}

/**
 * Optionally store a successful agent run into the semantic cache.
 */
export async function storeSemanticCache(opts: {
  prompt: string;
  framework?: string;
  fileSnapshot: Record<string, string>;
}): Promise<void> {
  if (!supabase || !opts.prompt || !opts.fileSnapshot) return;

  try {
    const embedding = await getCacheEmbedding(opts.prompt);
    if (!embedding) return;

    await supabase.from('agent_semantic_cache').insert({
      prompt_text: opts.prompt,
      embedding,
      framework: opts.framework || 'react',
      file_snapshot: opts.fileSnapshot,
      hit_count: 0,
    });
  } catch (err) {
    logger.warn('[agentSemanticCache] Error storing cache entry:', err);
  }
}
