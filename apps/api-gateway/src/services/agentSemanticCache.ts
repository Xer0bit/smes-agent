import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

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
 * Generate OpenAI embedding using text-embedding-3-small model.
 * Returns vector array or null if request fails.
 */
async function getOpenAiEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text.slice(0, 4000),
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? null;
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
    const embedding = await getOpenAiEmbedding(prompt.trim());
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
    const embedding = await getOpenAiEmbedding(opts.prompt);
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
